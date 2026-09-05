/**
 * Shared test fakes for the phone connection surfaces: a scripted stream
 * gateway, explicit-event sockets, and a manual retry scheduler. Exported
 * from the tests tree only — production code receives its own gateway via
 * `createHttpPhoneGateway` and its own listing source via
 * `createHttpPhoneListingSource`.
 */
import type { PhoneIoHandlers, PhoneIoSocket, PhoneStreamGateway } from '../src/client/phone-connection.ts'
import type { PhoneIoTarget, PhoneStreamSessionView } from '../src/client/phone-stream-client.ts'
import type {
  PhoneBadgeSnapshot, PhoneDeviceSummary, PhoneGateSource, PhoneListingSnapshot, PhoneListingSource,
} from '../src/client/registry.ts'
import { vi } from 'vitest'

export const SESSION_A: PhoneStreamSessionView = {
  deviceId: 'emulator-5554',
  ioPath: '/phone/ws/io',
  agentManaged: false,
  preferredFormat: 'h264',
  mjpeg: { url: '/phone/stream/emulator-5554/mjpeg?token=mjpeg-a', captureId: 'mjpeg-a', expiresAt: 1000 },
  h264: { url: '/phone/stream/emulator-5554/h264?token=h264-a', captureId: 'h264-a', expiresAt: 1000 },
}

/** Drain the microtask queue of one in-flight mint round trip. */
export const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** Observable browser resources installed for a decoded 390×844 H264 frame. */
export interface FakeH264PlaybackRuntime {
  readonly abortSignals: AbortSignal[]
  readonly decoderCloseCounts: number[]
  readonly frameCloseCounts: number[]
  readonly drawImage: ReturnType<typeof vi.fn>
  /** Deliver one asynchronous WebCodecs failure to the newest decoder. */
  failLastDecoder(): void
  /** Emit one decoded frame of the given display size from the newest decoder. */
  emitFrame(width: number, height: number, rotation?: number): void
}

/** Install a same-origin Annex-B response and WebCodecs decoder for view specs. */
export function installFakeH264Playback(): FakeH264PlaybackRuntime {
  const abortSignals: AbortSignal[] = []
  const decoderCloseCounts: number[] = []
  const frameCloseCounts: number[] = []
  const decoderErrors: Array<(error: DOMException) => void> = []
  const decoderOutputs: Decoder['output'][] = []
  const drawImage = vi.fn()
  const payload = Uint8Array.from([
    0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x06, 0x41, 0xaf, 0x9a, 0xd0,
    0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80,
    0, 0, 0, 1, 0x65, 0x88, 0x86,
    0, 0, 0, 1, 0x09, 0xf0,
    0, 0, 0, 1, 0x0c, 0x80,
  ])

  class Chunk {
    constructor(readonly init: EncodedVideoChunkInit) {}
  }

  class Decoder extends EventTarget {
    static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
      return { supported: true, config }
    }

    readonly index = decoderCloseCounts.push(0) - 1
    readonly output: (frame: {
      readonly displayWidth: number
      readonly displayHeight: number
      readonly rotation: number
      close(): void
    }) => void
    readonly error: (error: DOMException) => void
    state: CodecState = 'unconfigured'
    decodeQueueSize = 0
    decoded = 0
    emitted = 0

    constructor(init: { output: Decoder['output']; error: Decoder['error'] }) {
      super()
      this.output = init.output
      this.error = init.error
      decoderErrors.push(init.error)
      decoderOutputs.push(init.output)
    }

    configure(): void { this.state = 'configured' }
    decode(_chunk: Chunk): void {
      this.decoded += 1
      const frameIndex = frameCloseCounts.push(0) - 1
      this.emitted += 1
      this.output({
        displayWidth: 390,
        displayHeight: 844,
        rotation: 0,
        close: () => { frameCloseCounts[frameIndex] = (frameCloseCounts[frameIndex] ?? 0) + 1 },
      })
    }
    async flush(): Promise<void> {
      while (this.emitted < this.decoded) {
        const frameIndex = frameCloseCounts.push(0) - 1
        this.emitted += 1
        this.output({
          displayWidth: 390,
          displayHeight: 844,
          rotation: 0,
          close: () => { frameCloseCounts[frameIndex] = (frameCloseCounts[frameIndex] ?? 0) + 1 },
        })
      }
    }
    close(): void {
      decoderCloseCounts[this.index] = (decoderCloseCounts[this.index] ?? 0) + 1
      this.state = 'closed'
    }
  }

  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('EncodedVideoChunk', Chunk)
  vi.stubGlobal('VideoDecoder', Decoder)
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.signal !== undefined && init.signal !== null) abortSignals.push(init.signal)
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload) } })
    return new Response(body, { status: 200, headers: { 'content-type': 'video/h264' } })
  }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
  return {
    abortSignals,
    decoderCloseCounts,
    frameCloseCounts,
    drawImage,
    failLastDecoder() {
      decoderErrors.at(-1)?.(new DOMException('decode failed', 'EncodingError'))
    },
    emitFrame(width: number, height: number, rotation = 0) {
      const frameIndex = frameCloseCounts.push(0) - 1
      decoderOutputs.at(-1)?.({
        displayWidth: width,
        displayHeight: height,
        rotation,
        close: () => { frameCloseCounts[frameIndex] = (frameCloseCounts[frameIndex] ?? 0) + 1 },
      })
    },
  }
}

/** One socket the fake gateway handed out; events fire explicitly. */
export class FakeSocket implements PhoneIoSocket {
  readonly sent: string[] = []
  opened = false

  constructor(private readonly handlers: PhoneIoHandlers) {}

  /** Deliver the async open event (the gateway contract fires it async). */
  accept(): void {
    this.opened = true
    this.handlers.onOpen()
  }

  /** Deliver one server frame. */
  receive(data: string): void {
    this.handlers.onMessage(data)
  }

  /** Drop the connection the way a network failure would. */
  drop(): void {
    if (!this.opened) return
    this.opened = false
    this.handlers.onError()
    this.handlers.onClose()
  }

  /** Deliver a remote close without a preceding socket error. */
  closeFromRemote(): void {
    if (!this.opened) return
    this.opened = false
    this.handlers.onClose()
  }

  /** Deliver an error callback even after the socket stopped being current. */
  fail(): void {
    this.handlers.onError()
  }

  send(data: string): boolean {
    this.sent.push(data)
    return true
  }

  close(): void {
    this.opened = false
  }
}

/** Gateway fake with a scripted mint queue and observable sockets. */
export class FakeGateway implements PhoneStreamGateway {
  readonly sockets: FakeSocket[] = []
  readonly mintedDevices: string[] = []
  readonly dialedPaths: string[] = []
  readonly agentStatusDevices: string[] = []
  readonly agentInstallCalls: Array<{ readonly deviceId: string; readonly force: boolean }> = []
  private readonly mintScript: Array<{ readonly session?: PhoneStreamSessionView; readonly error?: unknown }> = []
  private readonly agentStatusScript: Array<{ readonly installed?: boolean; readonly error?: unknown }> = []
  private readonly agentInstallScript: Array<{ readonly installed?: boolean; readonly error?: unknown }> = []

  /** Queue one mint outcome; unqueued mints succeed with SESSION_A. */
  queueMint(outcome: { readonly session?: PhoneStreamSessionView; readonly error?: unknown }): void {
    this.mintScript.push(outcome)
  }

  /** Queue one real-device status outcome; unqueued checks report installed. */
  queueAgentStatus(outcome: { readonly installed?: boolean; readonly error?: unknown }): void {
    this.agentStatusScript.push(outcome)
  }

  /** Queue one real-device install outcome; unqueued installs succeed. */
  queueAgentInstall(outcome: { readonly installed?: boolean; readonly error?: unknown }): void {
    this.agentInstallScript.push(outcome)
  }

  async mintSession(deviceId: string): Promise<PhoneStreamSessionView> {
    this.mintedDevices.push(deviceId)
    const next = this.mintScript.shift()
    if (next !== undefined && next.error !== undefined) throw next.error
    return next?.session ?? SESSION_A
  }

  async agentStatus(deviceId: string): Promise<{ readonly deviceId: string; readonly installed: boolean }> {
    this.agentStatusDevices.push(deviceId)
    const next = this.agentStatusScript.shift()
    if (next?.error !== undefined) throw next.error
    return { deviceId, installed: next?.installed ?? true }
  }

  async installAgent(deviceId: string, force: boolean): Promise<{ readonly deviceId: string; readonly installed: boolean }> {
    this.agentInstallCalls.push({ deviceId, force })
    const next = this.agentInstallScript.shift()
    if (next?.error !== undefined) throw next.error
    return { deviceId, installed: next?.installed ?? true }
  }

  connectIo(target: PhoneIoTarget, handlers: PhoneIoHandlers): PhoneIoSocket {
    this.dialedPaths.push(target.ioPath)
    const socket = new FakeSocket(handlers)
    this.sockets.push(socket)
    return socket
  }

  get lastSocket(): FakeSocket | undefined {
    return this.sockets[this.sockets.length - 1]
  }
}

/** Deterministic scheduler: retries fire only when the spec runs them. */
export class ManualScheduler {
  private readonly pending: { readonly delay: number; readonly fn: () => void; cancelled: boolean }[] = []

  readonly schedule = (delay: number, fn: () => void): (() => void) => {
    const task = { delay, fn, cancelled: false }
    this.pending.push(task)
    return () => { task.cancelled = true }
  }

  get scheduledCount(): number {
    return this.pending.length
  }

  runNext(): void {
    const task = this.pending.find(candidate => !candidate.cancelled)
    if (task === undefined) throw new Error('no pending retry')
    task.cancelled = true
    task.fn()
  }
}

/**
 * Enable-gate fake: a settable snapshot whose writes notify subscribers —
 * the picker body must re-render the gate strip on the same tick.
 */
export class FakeGate implements PhoneGateSource {
  private readonly listeners = new Set<() => void>()

  constructor(private value: boolean) {}

  snapshot(): boolean {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: boolean): void {
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** One committed listing built from per-platform rows. */
export function listingOf(
  android: readonly PhoneDeviceSummary[] = [],
  ios: readonly PhoneDeviceSummary[] = [],
): PhoneListingSnapshot {
  return { android, ios }
}

/**
 * Listing-source fake: a seedable committed snapshot plus scripted refresh
 * outcomes. A scripted snapshot commits and notifies; a scripted promise
 * holds `refresh()` until the spec resolves it; an empty script is a no-op.
 */
export class FakeListingSource implements PhoneListingSource {
  private committed: PhoneListingSnapshot = listingOf()
  private readonly listeners = new Set<() => void>()
  private readonly scripts: Array<PhoneListingSnapshot | Promise<void> | Error> = []

  /** How many times refresh() ran, mount pulls included. */
  refreshCount = 0

  /** Replace the committed snapshot without notifying (construction seeding). */
  seed(snapshot: PhoneListingSnapshot): this {
    this.committed = snapshot
    return this
  }

  /** Script one refresh outcome for the next refresh() call. */
  scriptNext(outcome: PhoneListingSnapshot | Promise<void> | Error): void {
    this.scripts.push(outcome)
  }

  getBadge(): PhoneBadgeSnapshot {
    return {
      onlineCount: [...this.committed.android, ...this.committed.ios]
        .filter(device => device.online).length,
    }
  }

  snapshot(): PhoneListingSnapshot {
    return this.committed
  }

  async refresh(): Promise<void> {
    this.refreshCount += 1
    const next = this.scripts.shift()
    if (next instanceof Error) throw next
    if (next instanceof Promise) {
      await next
      return
    }
    if (next !== undefined) {
      this.committed = next
      for (const listener of [...this.listeners]) listener()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
