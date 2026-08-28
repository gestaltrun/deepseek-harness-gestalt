/**
 * Phone live-view connection controller: the React-free state machine one
 * device tab runs against the same-origin stream gateway. It mints signed
 * capture sessions, owns the io WebSocket lifecycle, bounds automatic
 * reconnects after stream interruptions, and maps normalized screen touches
 * onto JSON-RPC io frames. Renderers subscribe and read phase snapshots;
 * every decision stays in this module so the machine is testable without a
 * browser.
 * @module @deepseek-ai/dsh-client-ui-phone/client/phone-connection
 */
import {
  encodePhoneIoFrame, isUnauthorizedMessage, parsePhoneIoReply, PhoneStreamHttpError,
  type PhoneClientIoRequest, type PhoneIoTarget, type PhoneStreamSessionView,
} from './phone-stream-client.ts'

/** Capture encodings the Host signs (the `phoneStream` URL vocabulary). */
export type PhoneCaptureFormat = 'mjpeg' | 'h264'

/** Closed failure vocabulary the error copy switches on. */
export type PhoneStreamFailureKind =
  /** The handset asks for USB/WDA debugging authorization. */
  | 'unauthorized'
  /** The device vanished from the fleet listing. */
  | 'device-offline'
  /** The live stream broke and every bounded retry failed. */
  | 'interrupted'
  /** The Host trust fence refused the session. */
  | 'refused'
  /** The stream channel is unreachable (network or upstream). */
  | 'unavailable'

/** One terminal stream failure carried by the error phase. */
export interface PhoneStreamFailure {
  readonly kind: PhoneStreamFailureKind
}

/** Closed phase union the connected view renders from. */
export type PhoneConnectionPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | {
    readonly kind: 'live'
    /** Signed same-origin capture URL the renderer loads. */
    readonly streamUrl: string
    /** Encoding of {@link PhoneConnectionPhase.streamUrl}. */
    readonly format: PhoneCaptureFormat
    /** Unix epoch milliseconds after which the Host refuses the URL. */
    readonly expiresAt: number
  }
  | {
    readonly kind: 'reconnecting'
    /** 1-based attempt number of the scheduled retry. */
    readonly attempt: number
    /** Last signed URL kept for reference while the renderer shows a spinner. */
    readonly streamUrl?: string
  }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'error'; readonly failure: PhoneStreamFailure }

/** Events one io socket delivers to the controller. */
export interface PhoneIoHandlers {
  /** The WebSocket handshake completed (always fired asynchronously). */
  readonly onOpen: () => void
  /** The socket closed after being handed to the controller. */
  readonly onClose: () => void
  /** The socket hit a transmission error (a close usually follows). */
  readonly onError: () => void
  /** One text frame arrived from the Host. */
  readonly onMessage: (data: string) => void
}

/** One live io socket the controller owns. */
export interface PhoneIoSocket {
  /** Send one text frame to the Host. */
  send(data: string): void
  /** Close the socket; no reconnect follows a controller-initiated close. */
  close(): void
}

/** Transport seam the controller runs against (faked in tests). */
export interface PhoneStreamGateway {
  /** Mint one signed same-origin session for the device. */
  mintSession(deviceId: string): Promise<PhoneStreamSessionView>
  /** Open the io WebSocket on the session's minted path; events fire asynchronously. */
  connectIo(target: PhoneIoTarget, handlers: PhoneIoHandlers): PhoneIoSocket
}

/** Toolbar button vocabulary forwarded as `device.io.button` names. */
export type PhoneButtonName = 'BACK' | 'HOME' | 'RECENTS'

/** One normalized screen point (both axes clamped to [0, 1]). */
export interface PhoneScreenPoint {
  /** Horizontal fraction of the live frame width. */
  readonly u: number
  /** Vertical fraction of the live frame height. */
  readonly v: number
}

/** Learned device pixel size of the streamed frame. */
export interface PhoneSurfaceSize {
  readonly width: number
  readonly height: number
}

/** How long one device tab keeps retrying interruptions on its own. */
const RETRY_LIMIT = 3
/** Linear backoff base; attempt n waits `n × retryBaseDelayMs`. */
const RETRY_BASE_DELAY_MS = 1000

/** Default wall-clock scheduler. */
const defaultSchedule = (delayMs: number, fn: () => void): (() => void) => {
  const handle = setTimeout(fn, delayMs)
  return () => { clearTimeout(handle) }
}

/**
 * Map one normalized screen point onto integer device pixels.
 * @param point - normalized point; both axes clamp into [0, 1].
 * @param surface - learned device pixel size of the streamed frame.
 * @returns the integer device coordinates the io frame carries.
 */
export function devicePointOf(point: PhoneScreenPoint, surface: PhoneSurfaceSize): { x: number; y: number } {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  return {
    x: Math.round(clamp(point.u) * surface.width),
    y: Math.round(clamp(point.v) * surface.height),
  }
}

/**
 * Classify one mint failure onto the failure vocabulary. Terminal arms
 * (offline, unauthorized, refused) stop the auto-retry loop; everything
 * else retries within the budget.
 * @param error - the thrown mint failure.
 * @returns the failure kind the phase error carries.
 */
export function classifyPhoneStreamFailure(error: unknown): PhoneStreamFailureKind {
  if (error instanceof PhoneStreamHttpError) {
    if (error.status === 404) return 'device-offline'
    if (error.status === 403) return 'refused'
    if (isUnauthorizedMessage(error.message)) return 'unauthorized'
    return 'unavailable'
  }
  return 'unavailable'
}

/** Constructor dependencies; everything but the gateway stays defaultable. */
export interface PhoneConnectionOptions {
  /** Transport seam minting sessions and opening the io socket. */
  readonly gateway: PhoneStreamGateway
  /** Device the session addresses (Android serial or iOS UDID). */
  readonly deviceId: string
  /** Retry scheduler; tests inject a manual clock. */
  readonly schedule?: (delayMs: number, fn: () => void) => () => void
  /** Auto-retry budget for one connect cycle. */
  readonly retryLimit?: number
  /** Linear backoff base milliseconds. */
  readonly retryBaseDelayMs?: number
}

/**
 * One device tab's connection. Create one per tab and dispose with the tab:
 * `setVisible(false)` suspends pulling without forgetting the device, and
 * `dispose` tears everything down. The retry budget resets only on explicit
 * `connect` / `refresh` / resume — an auto-retry chain that spends it lands
 * in the error phase where the copy offers the manual reconnect.
 */
export class PhoneConnectionController {
  private readonly gateway: PhoneStreamGateway
  private readonly deviceId: string
  private readonly schedule: (delayMs: number, fn: () => void) => () => void
  private readonly retryLimit: number
  private readonly retryBaseDelayMs: number
  private readonly listeners = new Set<() => void>()

  private phase: PhoneConnectionPhase = { kind: 'idle' }
  private socket: PhoneIoSocket | undefined
  /** Raised on every teardown so stale mint continuations drop out. */
  private epoch = 0
  private session: PhoneStreamSessionView | undefined
  private surface: PhoneSurfaceSize | undefined
  private nextFrameId = 1
  private retryAttempt = 0
  private lastTransient: Extract<PhoneStreamFailureKind, 'interrupted' | 'unavailable'> = 'interrupted'
  private cancelRetry: (() => void) | undefined

  constructor(options: PhoneConnectionOptions) {
    this.gateway = options.gateway
    this.deviceId = options.deviceId
    this.schedule = options.schedule ?? defaultSchedule
    this.retryLimit = options.retryLimit ?? RETRY_LIMIT
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS
  }

  /**
   * Current phase snapshot; identity changes on every transition.
   * @returns the latest phase the connected view should render.
   */
  snapshot(): PhoneConnectionPhase {
    return this.phase
  }

  /**
   * Follow phase changes until the returned disposer runs.
   * @param listener - called after every phase transition.
   * @returns disposer that stops following this controller.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Resume pulling: a fresh connect cycle from idle, suspended, or error. */
  connect(): void {
    if (this.isBusy()) return
    this.retryAttempt = 0
    void this.startConnect()
  }

  /** Stop pulling, drop the session, and return to idle. */
  disconnect(): void {
    this.teardown()
    this.setPhase({ kind: 'idle' })
  }

  /** Disconnect and immediately start a fresh cycle (刷新流). */
  refresh(): void {
    this.disconnect()
    this.connect()
  }

  /**
   * Pause pulling while the tab hides and resume on re-show. Suspending
   * never forgets the device; resuming mints a fresh session because the
   * signed capture URLs are short-lived.
   * @param visible - whether the tab is active and the panel open.
   */
  setVisible(visible: boolean): void {
    if (visible) {
      this.connect()
      return
    }
    this.teardown()
    // A terminal error stays visible until the user acts on it.
    if (this.phase.kind !== 'error') this.setPhase({ kind: 'suspended' })
  }

  /**
   * Report a failed capture element (img/video error) so a broken stream
   * reconnects even while the io socket stays open.
   */
  noteCaptureFailure(): void {
    if (this.phase.kind !== 'live') return
    this.teardown()
    this.lastTransient = 'interrupted'
    this.scheduleRetry()
  }

  /**
   * Learn the streamed frame's device pixel size from the capture element.
   * @param width - natural width in device pixels.
   * @param height - natural height in device pixels.
   */
  noteSurface(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    this.surface = { width, height }
  }

  /**
   * Tap one normalized screen point.
   * @param u - Horizontal position in 0..1 of the streamed frame.
   * @param v - Vertical position in 0..1 of the streamed frame.
   * @returns false when the surface is unknown or the phase is not live.
   */
  tap(u: number, v: number): boolean {
    if (this.surface === undefined) return false
    const { x, y } = devicePointOf({ u, v }, this.surface)
    return this.send({ method: 'tap', x, y })
  }

  /**
   * Send a drag as a `pointerDown`/`pointerMove`…/`pointerUp` gesture.
   * @param points - the drag path in normalized screen points.
   * @returns false when the path is empty, the surface unknown, or not live.
   */
  swipe(points: readonly PhoneScreenPoint[]): boolean {
    const surface = this.surface
    if (surface === undefined || points.length === 0) return false
    const mapped = points.map(point => devicePointOf(point, surface))
    const actions = mapped.map((point, index) => ({
      type: index === 0 ? 'pointerDown' : index === mapped.length - 1 ? 'pointerUp' : 'pointerMove',
      x: point.x,
      y: point.y,
    }))
    return this.send({ method: 'gesture', actions })
  }

  /**
   * Type text on the device.
   * @param value - the text to input; empty text is dropped.
   * @returns false when the text is empty or the phase is not live.
   */
  text(value: string): boolean {
    if (value.length === 0) return false
    return this.send({ method: 'text', text: value })
  }

  /**
   * Press one device toolbar button.
   * @param name - the closed button vocabulary.
   * @returns false when the phase is not live.
   */
  button(name: PhoneButtonName): boolean {
    return this.send({ method: 'button', button: name })
  }

  /** Tear everything down and stop following phase changes. */
  dispose(): void {
    this.disconnect()
    this.listeners.clear()
  }

  private isBusy(): boolean {
    return this.phase.kind === 'connecting'
      || this.phase.kind === 'live'
      || this.phase.kind === 'reconnecting'
  }

  private async startConnect(): Promise<void> {
    this.teardown()
    this.setPhase({ kind: 'connecting' })
    const epoch = this.epoch
    let session: PhoneStreamSessionView
    try {
      session = await this.gateway.mintSession(this.deviceId)
    } catch (error) {
      if (epoch !== this.epoch) return
      this.handleConnectFailure(classifyPhoneStreamFailure(error))
      return
    }
    if (epoch !== this.epoch) return
    this.session = session
    // The handlers read the socket identity lazily; open events always fire
    // after connectIo has returned, so the entry is populated by then.
    const entry: { socket?: PhoneIoSocket } = {}
    const isCurrent = (): boolean => entry.socket !== undefined && this.socket === entry.socket && this.epoch === epoch
    entry.socket = this.gateway.connectIo(session, {
      onOpen: () => {
        if (!isCurrent()) return
        this.setPhase({
          kind: 'live',
          streamUrl: this.streamUrlOf(session),
          format: 'mjpeg',
          expiresAt: session.mjpeg.expiresAt,
        })
      },
      onClose: () => {
        if (!isCurrent()) return
        this.teardown()
        this.lastTransient = 'interrupted'
        this.scheduleRetry()
      },
      onError: () => {
        if (!isCurrent()) return
        this.teardown()
        this.lastTransient = 'interrupted'
        this.scheduleRetry()
      },
      onMessage: (data) => {
        if (!isCurrent()) return
        this.handleFrame(data)
      },
    })
    this.socket = entry.socket
  }

  private handleConnectFailure(kind: PhoneStreamFailureKind): void {
    if (kind === 'device-offline' || kind === 'unauthorized' || kind === 'refused') {
      this.teardown()
      this.setPhase({ kind: 'error', failure: { kind } })
      return
    }
    this.lastTransient = 'unavailable'
    this.scheduleRetry()
  }

  private handleFrame(data: string): void {
    // Only error replies carry actionable state; junk frames and ok results
    // change nothing — the connection lifecycle owns the rest.
    const reply = parsePhoneIoReply(data)
    if (reply === undefined || reply.ok) return
    if (reply.code === -32010) {
      this.teardown()
      this.setPhase({ kind: 'error', failure: { kind: 'device-offline' } })
      return
    }
    if (reply.message !== undefined && isUnauthorizedMessage(reply.message)) {
      this.teardown()
      this.setPhase({ kind: 'error', failure: { kind: 'unauthorized' } })
    }
  }

  private scheduleRetry(): void {
    if (this.phase.kind === 'error' || this.phase.kind === 'suspended' || this.phase.kind === 'idle') return
    if (this.retryAttempt >= this.retryLimit) {
      this.setPhase({ kind: 'error', failure: { kind: this.lastTransient } })
      return
    }
    this.retryAttempt += 1
    const attempt = this.retryAttempt
    const streamUrl = this.session === undefined ? undefined : this.streamUrlOf(this.session)
    this.setPhase(streamUrl === undefined
      ? { kind: 'reconnecting', attempt }
      : { kind: 'reconnecting', attempt, streamUrl })
    this.cancelRetry = this.schedule(this.retryBaseDelayMs * attempt, () => {
      this.cancelRetry = undefined
      void this.startConnect()
    })
  }

  private streamUrlOf(session: PhoneStreamSessionView): string {
    return session.mjpeg.url
  }

  private send(request: PhoneClientIoRequest): boolean {
    if (this.phase.kind !== 'live' || this.socket === undefined) return false
    this.socket.send(encodePhoneIoFrame(this.nextFrameId, this.deviceId, request))
    this.nextFrameId += 1
    return true
  }

  private teardown(): void {
    this.epoch += 1
    this.cancelRetry?.()
    this.cancelRetry = undefined
    this.socket?.close()
    this.socket = undefined
  }

  private setPhase(phase: PhoneConnectionPhase): void {
    this.phase = phase
    for (const listener of this.listeners) listener()
  }
}
