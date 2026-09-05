/**
 * Phone live-view connection controller: the React-free state machine one
 * occupying device runs against the same-origin stream gateway. It mints
 * signed capture sessions, opens the Host-selected device-class encoding,
 * owns the io WebSocket lifecycle, falls back from H264 to the same session's MJPEG URL,
 * bounds automatic reconnects after both encodings fail, and maps normalized
 * screen touches onto JSON-RPC io frames. Renderers subscribe and read phase
 * snapshots; every decision stays in this module so the machine is testable
 * without a browser.
 * @module @deepseek-ai/dsh-client-ui-phone/client/phone-connection
 */
import type { PhoneCaptureId } from '@deepseek-ai/dsh-phone-runtime'
import {
  encodePhoneIoFrame, isUnauthorizedMessage, parsePhoneIoReply, PhoneStreamHttpError,
  type PhoneAgentStatusView, type PhoneClientIoRequest, type PhoneIoTarget, type PhoneStreamSessionView,
} from './phone-stream-client.ts'

/** Capture encoding currently rendered by the live view. */
export type PhoneCaptureFormat = 'h264' | 'mjpeg'

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
  /** The managed device control agent has not been installed. */
  | 'agent-missing'
  | 'agent-install-restricted'
  /** Agent installation is blocked until the Host names a provisioning profile. */
  | 'agent-profile-required'
  /** The real iPhone must be unlocked before agent or picture operations continue. */
  | 'device-locked'
  /** Developer Mode, certificate trust, signing identity, or provisioning trust needs human action. */
  | 'cert-untrusted'
  /** The installed real-device agent must be re-signed with a current profile. */
  | 'profile-expired'
  /** The real-device transport tunnel could not be established. */
  | 'tunnel-failed'
  /** The real iPhone disconnected from the Host. */
  | 'device-unplugged'

/** One terminal stream failure carried by the error phase. */
export interface PhoneStreamFailure {
  readonly kind: PhoneStreamFailureKind
  /** Product action that can repair the on-device agent after any stated manual prerequisite. */
  readonly agentRecovery?: 'install' | 'reinstall'
}

/** Closed phase union the connected view renders from. */
/** Latest ordinary device action failure; it never replaces a healthy live phase. */
export interface PhoneActionFailure {
  readonly code?: number
  readonly message: string
}

/** Why tap/swipe cannot leave this capture. */
export type PhoneCoordinateUnavailableReason =
  | 'missing-surface'
  | 'unknown-platform'
  | 'missing-logical'
  | 'orientation-mismatch'

/** Closed connection lifecycle states rendered by the connected phone view. */
export type PhoneConnectionPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | {
    readonly kind: 'live'
    /** Signed same-origin capture URL the renderer loads. */
    readonly streamUrl: string
    /** Encoding of {@link PhoneConnectionPhase.streamUrl}. */
    readonly format: PhoneCaptureFormat
    /** Opaque identity of the capture currently rendered by the browser. */
    readonly captureId: PhoneCaptureId
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
  | { readonly kind: 'checking-agent' }
  | { readonly kind: 'repairing-agent'; readonly force: boolean }
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
  /** Admit one text frame to the Host transport. */
  send(data: string): boolean
  /** Close the socket; no reconnect follows a controller-initiated close. */
  close(): void
}

/** Transport seam the controller runs against (faked in tests). */
export interface PhoneStreamGateway {
  /** Mint one signed same-origin session for the device. */
  mintSession(deviceId: string): Promise<PhoneStreamSessionView>
  /** Detect the managed device control agent through the Host. */
  agentStatus(deviceId: string): Promise<PhoneAgentStatusView>
  /** Install or force-reinstall the managed device control agent through the Host. */
  installAgent(deviceId: string, force: boolean): Promise<PhoneAgentStatusView>
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
    if (error.code === 'PHONE_AGENT_MISSING') return 'agent-missing'
    if (error.message.includes('INSTALL_FAILED_USER_RESTRICTED')) return 'agent-install-restricted'
    if (error.code === 'PHONE_AGENT_PROFILE_REQUIRED') return 'agent-profile-required'
    if (error.code === 'PHONE_REAL_DEVICE_ISSUE' && error.issue !== undefined) return error.issue
    if (error.status === 404) return 'device-offline'
    if (error.status === 403) return 'refused'
    if (isUnauthorizedMessage(error.message)) return 'unauthorized'
    return 'unavailable'
  }
  return 'unavailable'
}

function failureOf(error: unknown): PhoneStreamFailure {
  const kind = classifyPhoneStreamFailure(error)
  if (kind === 'agent-missing') return { kind, agentRecovery: 'install' }
  if (kind === 'agent-install-restricted') return { kind, agentRecovery: 'install' }
  if (kind === 'profile-expired') return { kind, agentRecovery: 'reinstall' }
  return { kind }
}

/** Constructor dependencies; everything but the gateway stays defaultable. */
export interface PhoneConnectionOptions {
  /** Transport seam minting sessions and opening the io socket. */
  readonly gateway: PhoneStreamGateway
  /** Device the session addresses (Android serial or iOS UDID). */
  readonly deviceId: string
  /** Occupying listing platform; Android capture IO requires current `logicalDisplay`. */
  readonly platform?: 'android' | 'ios'
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
  private platform: 'android' | 'ios' | undefined
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
  private surfaceRotation: 0 | 90 | 180 | 270 | undefined
  /** Current listing `logicalDisplay`; undefined is a dumpsys miss. */
  private logicalDisplay: PhoneSurfaceSize | undefined
  private logicalDisplayKnown = false
  /** Last finite listing size; remint identity, not current availability. */
  private lastKnownLogicalDisplay: PhoneSurfaceSize | undefined
  /** Host last-known logicalDisplay snapshotted when the current mint started. */
  private mintLogicalDisplay: PhoneSurfaceSize | undefined
  private nextFrameId = 1
  private latestSentFrameId = 0
  private readonly outstandingFrameIds = new Set<number>()
  private actionFailure: PhoneActionFailure | undefined
  private retryAttempt = 0
  private lastTransient: Extract<PhoneStreamFailureKind, 'interrupted' | 'unavailable'> = 'interrupted'
  private cancelRetry: (() => void) | undefined

  constructor(options: PhoneConnectionOptions) {
    this.gateway = options.gateway
    this.deviceId = options.deviceId
    this.platform = options.platform
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
   * Follow Host Android `logicalDisplay`. The first finite size seeds and
   * does not remint. A later numeric width/height change remints through
   * {@link refresh} only while live H264 so an H264→MJPEG fallback is not
   * undone. Identical polls are a no-op. Connecting, reconnecting,
   * suspended, idle, error, and live MJPEG record the size without starting
   * a new pull. A size recorded while connecting remints once the current
   * mint opens live H264 if it differs from the mint snapshot.
   * @param display - Host `dumpsys display` logicalFrame, when present.
   */
  noteLogicalDisplay(display: PhoneSurfaceSize | undefined): void {
    if (display === undefined) {
      const changed = this.logicalDisplay !== undefined
      this.logicalDisplay = undefined
      this.logicalDisplayKnown = true
      if (changed) this.notify()
      return
    }
    const { width, height } = display
    const sameKnown = this.lastKnownLogicalDisplay?.width === width
      && this.lastKnownLogicalDisplay.height === height
    this.logicalDisplay = { width, height }
    this.lastKnownLogicalDisplay = { width, height }
    if (!this.logicalDisplayKnown) {
      this.logicalDisplayKnown = true
      this.notify()
      return
    }
    if (sameKnown) {
      this.notify()
      return
    }
    if (this.phase.kind === 'live' && this.phase.format === 'h264') this.refresh()
    else this.notify()
  }

  /**
   * Occupying listing platform. Android capture IO requires current
   * `logicalDisplay`; iOS does not.
   * @param platform - Listing platform of the occupying device.
   */
  notePlatform(platform: 'android' | 'ios'): void {
    if (this.platform === platform) return
    this.platform = platform
    this.notify()
  }

  /**
   * Install or force-reinstall the managed device agent, then reconnect the picture session.
   * @param force - whether to replace an already installed agent and refresh its signing.
   */
  recoverAgent(force: boolean): void {
    if (this.phase.kind !== 'error') return
    this.teardown()
    this.setPhase({ kind: 'repairing-agent', force })
    const epoch = this.epoch
    void this.gateway.installAgent(this.deviceId, force).then(
      (status) => {
        if (this.epoch !== epoch) return
        if (!status.installed) {
          this.setPhase({ kind: 'error', failure: { kind: 'agent-missing', agentRecovery: 'install' } })
          return
        }
        void this.startConnect()
      },
      (error: unknown) => {
        if (this.epoch !== epoch) return
        this.setPhase({ kind: 'error', failure: failureOf(error) })
      },
    )
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
   * Report a failed capture. H264 switches to MJPEG from the already-minted
   * session without replacing its io socket; MJPEG spends the retry budget.
   * @param format - Encoding whose current renderer failed.
   * @param captureId - Exact capture identity owned by that renderer.
   */
  noteCaptureFailure(format: PhoneCaptureFormat, captureId: PhoneCaptureId): void {
    if (this.phase.kind !== 'live' || this.phase.format !== format || this.phase.captureId !== captureId) return
    if (format === 'h264' && this.session !== undefined) {
      this.surface = undefined
      this.setPhase({
        kind: 'live',
        streamUrl: this.session.mjpeg.url,
        format: 'mjpeg',
        captureId: this.session.mjpeg.captureId,
        expiresAt: this.session.mjpeg.expiresAt,
      })
      return
    }
    this.teardown()
    this.lastTransient = 'interrupted'
    this.scheduleRetry()
  }

  /**
   * Learned device pixel size of the streamed frame, or undefined before the
   * first measurement. Identity changes only when the size changes, so
   * subscribers can read it through `useSyncExternalStore`.
   * @returns the latest measured surface.
   */
  surfaceSize(): PhoneSurfaceSize | undefined {
    return this.surface
  }

  /** Exact rotation associated with the current measured surface.
   * @returns current display rotation, or undefined before measurement or for unrotated MJPEG.
   */
  surfaceOrientation(): 0 | 90 | 180 | 270 | undefined {
    return this.surfaceRotation
  }

  /**
   * Whether tap/swipe may leave this capture. Unknown listing platform is
   * fail-closed and is not treated as iOS. Android requires a current
   * listing `logicalDisplay` (a dumpsys miss is not the last known size).
   * Orientation mismatch is unavailable. iOS ignores listing logical size.
   * Wire x/y and `captureWidth`/`captureHeight` stay the decoded plane.
   * @returns true when a decoded surface may send tap/swipe.
   */
  coordinateIoAvailable(): boolean {
    return this.coordinateUnavailableReason() === undefined
  }

  /**
   * Why coordinate IO is blocked, or undefined when tap/swipe may leave.
   * @returns the closed unavailable reason, or undefined when tap/swipe may leave.
   */
  coordinateUnavailableReason(): PhoneCoordinateUnavailableReason | undefined {
    if (this.surface === undefined) return 'missing-surface'
    if (this.platform === undefined) return 'unknown-platform'
    if (this.platform === 'android') {
      if (this.logicalDisplay === undefined) return 'missing-logical'
      const paintedLandscape = this.surface.width > this.surface.height
      const logicalLandscape = this.logicalDisplay.width > this.logicalDisplay.height
      if (paintedLandscape !== logicalLandscape) return 'orientation-mismatch'
    }
    return undefined
  }

  /**
   * Latest ordinary action failure while the picture remains live.
   * @returns the structured failure, or undefined before/after a successful action.
   */
  actionStatus(): PhoneActionFailure | undefined {
    return this.actionFailure
  }

  /**
   * Learn the streamed frame's device pixel size from the capture element.
   * A repeated identical measurement is a no-op; a real change (device
   * rotation flips width and height) notifies subscribers so the frame box
   * follows the new aspect.
   * @param format - Encoding whose renderer measured the surface.
   * @param captureId - Exact active capture whose renderer measured the surface.
   * @param width - Frame width in device pixels.
   * @param height - Frame height in device pixels.
   * @param rotation - exact H264 display rotation; MJPEG omits it.
   */
  noteSurface(
    format: PhoneCaptureFormat,
    captureId: PhoneCaptureId,
    width: number,
    height: number,
    rotation?: 0 | 90 | 180 | 270,
  ): void {
    if (this.phase.kind !== 'live' || this.phase.format !== format || this.phase.captureId !== captureId) return
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    if (this.surface?.width === width && this.surface.height === height && this.surfaceRotation === rotation) return
    this.surface = { width, height }
    this.surfaceRotation = rotation
    this.notify()
  }

  /**
   * Tap one normalized screen point.
   * @param u - Horizontal position in 0..1 of the streamed frame.
   * @param v - Vertical position in 0..1 of the streamed frame.
   * @returns false when the surface is unknown or the phase is not live.
   */
  tap(u: number, v: number): boolean {
    const painted = this.surface
    if (painted === undefined || this.phase.kind !== 'live' || this.coordinateUnavailableReason() !== undefined) return false
    const { x, y } = devicePointOf({ u, v }, painted)
    return this.send({
      method: 'tap',
      x,
      y,
      source: {
        kind: 'capture', captureWidth: painted.width, captureHeight: painted.height,
        captureId: this.phase.captureId, captureFormat: this.phase.format,
        ...(this.surfaceRotation === undefined ? {} : { captureRotation: this.surfaceRotation }),
      },
    })
  }

  /**
   * Send a normalized drag as one semantic swipe from press origin to release.
   * The action carries current capture identity, format, dimensions, and H264 rotation.
   * @param points - the drag path in normalized screen points.
   * @returns false when the path is empty, the surface unknown, or not live.
   */
  swipe(points: readonly PhoneScreenPoint[]): boolean {
    const painted = this.surface
    const origin = points[0]
    const release = points[points.length - 1]
    if (painted === undefined || this.phase.kind !== 'live' || origin === undefined || release === undefined
      || this.coordinateUnavailableReason() !== undefined) return false
    const start = devicePointOf(origin, painted)
    const end = devicePointOf(release, painted)
    return this.send({
      method: 'swipe',
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      source: {
        kind: 'capture', captureWidth: painted.width, captureHeight: painted.height,
        captureId: this.phase.captureId, captureFormat: this.phase.format,
        ...(this.surfaceRotation === undefined ? {} : { captureRotation: this.surfaceRotation }),
      },
    })
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
      || this.phase.kind === 'checking-agent'
      || this.phase.kind === 'repairing-agent'
  }

  private async startConnect(): Promise<void> {
    this.teardown()
    this.mintLogicalDisplay = this.lastKnownLogicalDisplay
    this.setPhase({ kind: 'connecting' })
    const epoch = this.epoch
    let session: PhoneStreamSessionView
    try {
      session = await this.gateway.mintSession(this.deviceId)
    } catch (error) {
      if (epoch !== this.epoch) return
      this.handleConnectFailure(failureOf(error))
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
        const format = session.preferredFormat
        this.setPhase({
          kind: 'live',
          streamUrl: this.streamUrlOf(session, format),
          format,
          captureId: session[format].captureId,
          expiresAt: session[format].expiresAt,
        })
        if (!isCurrent()) return
        if (format === 'h264' && this.logicalDisplayChangedSinceMint()) this.refresh()
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

  private handleConnectFailure(failure: PhoneStreamFailure): void {
    const { kind } = failure
    if (kind === 'device-offline' || kind === 'unauthorized' || kind === 'refused') {
      this.teardown()
      this.setPhase({ kind: 'error', failure })
      return
    }
    if (kind === 'agent-missing' || kind === 'agent-install-restricted' || kind === 'agent-profile-required'
      || kind === 'device-locked' || kind === 'cert-untrusted'
      || kind === 'profile-expired' || kind === 'tunnel-failed' || kind === 'device-unplugged') {
      this.teardown()
      this.setPhase({ kind: 'error', failure })
      return
    }
    this.lastTransient = 'unavailable'
    this.scheduleRetry()
  }

  private handleFrame(data: string): void {
    const reply = parsePhoneIoReply(data)
    if (reply === undefined || !this.outstandingFrameIds.delete(reply.id)) return
    const terminal = !reply.ok && (reply.code === -32010
      || (reply.message !== undefined && isUnauthorizedMessage(reply.message)))
    if (!terminal && reply.id !== this.latestSentFrameId) return
    if (reply.ok) {
      if (this.actionFailure !== undefined) {
        this.actionFailure = undefined
        this.notify()
      }
      return
    }
    if (reply.code === -32010) {
      this.teardown()
      this.setPhase({ kind: 'error', failure: { kind: 'device-offline' } })
      return
    }
    if (reply.message !== undefined && isUnauthorizedMessage(reply.message)) {
      this.teardown()
      this.setPhase({ kind: 'error', failure: { kind: 'unauthorized' } })
      return
    }
    this.actionFailure = {
      ...(reply.code === undefined ? {} : { code: reply.code }),
      message: reply.message ?? '设备操作失败',
    }
    this.notify()
  }

  private scheduleRetry(): void {
    if (this.retryAttempt >= this.retryLimit) {
      if (this.session?.agentManaged === true) {
        this.checkAgentAfterFailure()
      } else {
        this.setPhase({ kind: 'error', failure: { kind: this.lastTransient } })
      }
      return
    }
    this.retryAttempt += 1
    const attempt = this.retryAttempt
    const streamUrl = this.phase.kind === 'live' ? this.phase.streamUrl : undefined
    this.setPhase(streamUrl === undefined
      ? { kind: 'reconnecting', attempt }
      : { kind: 'reconnecting', attempt, streamUrl })
    this.cancelRetry = this.schedule(this.retryBaseDelayMs * attempt, () => {
      this.cancelRetry = undefined
      void this.startConnect()
    })
  }

  private checkAgentAfterFailure(): void {
    this.setPhase({ kind: 'checking-agent' })
    const epoch = this.epoch
    void this.gateway.agentStatus(this.deviceId).then(
      (status) => {
        if (this.epoch !== epoch) return
        this.setPhase(status.installed
          ? { kind: 'error', failure: { kind: this.lastTransient, agentRecovery: 'reinstall' } }
          : { kind: 'error', failure: { kind: 'agent-missing', agentRecovery: 'install' } })
      },
      (error: unknown) => {
        if (this.epoch !== epoch) return
        this.setPhase({ kind: 'error', failure: failureOf(error) })
      },
    )
  }

  private streamUrlOf(session: PhoneStreamSessionView, format: PhoneCaptureFormat): string {
    return session[format].url
  }

  private logicalDisplayChangedSinceMint(): boolean {
    const minted = this.mintLogicalDisplay
    const known = this.lastKnownLogicalDisplay
    if (known === undefined) return false
    if (minted === undefined) return true
    return minted.width !== known.width || minted.height !== known.height
  }

  private send(request: PhoneClientIoRequest): boolean {
    if (this.phase.kind !== 'live') return false
    const socket = this.socket as PhoneIoSocket
    const id = this.nextFrameId
    const previousLatest = this.latestSentFrameId
    this.nextFrameId += 1
    this.latestSentFrameId = id
    this.outstandingFrameIds.add(id)
    let admitted: boolean
    try {
      admitted = socket.send(encodePhoneIoFrame(id, this.deviceId, request))
    } catch (sendFailure) {
      // Foreign WebSocket send threw instead of returning false; both mean the frame was not admitted.
      void sendFailure
      admitted = false
    }
    if (admitted) return true
    this.rollbackSend(id, previousLatest)
    if (this.socket === socket) {
      this.teardown()
      this.lastTransient = 'interrupted'
      this.scheduleRetry()
    }
    return false
  }

  private rollbackSend(id: number, previousLatest: number): void {
    if (!this.outstandingFrameIds.delete(id)) return
    if (this.nextFrameId === id + 1) this.nextFrameId = id
    if (this.latestSentFrameId === id) this.latestSentFrameId = previousLatest
  }

  private teardown(): void {
    this.epoch += 1
    this.surface = undefined
    this.surfaceRotation = undefined
    this.latestSentFrameId = 0
    this.outstandingFrameIds.clear()
    this.actionFailure = undefined
    this.cancelRetry?.()
    this.cancelRetry = undefined
    this.socket?.close()
    this.socket = undefined
  }

  private setPhase(phase: PhoneConnectionPhase): void {
    this.phase = phase
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
