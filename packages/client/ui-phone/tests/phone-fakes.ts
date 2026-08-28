/**
 * Shared test fakes for the phone connection surfaces: a scripted stream
 * gateway, explicit-event sockets, and a manual retry scheduler. Exported
 * from the tests tree only — production code receives its own gateway via
 * `createHttpPhoneGateway`.
 */
import type {
  PhoneIoHandlers, PhoneIoSocket, PhoneStreamGateway, PhoneStreamSessionView,
} from '../src/client/phone-connection.ts'

export const SESSION_A: PhoneStreamSessionView = {
  deviceId: 'emulator-5554',
  ioPath: '/phone/ws/io',
  mjpeg: { url: '/phone/stream/emulator-5554/mjpeg?token=a', expiresAt: 1000 },
  h264: { url: '/phone/stream/emulator-5554/h264?token=a', expiresAt: 1000 },
}

/** Drain the microtask queue of one in-flight mint round trip. */
export const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** One socket the fake gateway handed out; events fire explicitly. */
export class FakeSocket implements PhoneIoSocket {
  readonly sent: string[] = []
  private opened = false

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

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.opened = false
  }
}

/** Gateway fake with a scripted mint queue and observable sockets. */
export class FakeGateway implements PhoneStreamGateway {
  readonly sockets: FakeSocket[] = []
  readonly mintedDevices: string[] = []
  private readonly mintScript: Array<{ readonly session?: PhoneStreamSessionView; readonly error?: unknown }> = []

  /** Queue one mint outcome; unqueued mints succeed with SESSION_A. */
  queueMint(outcome: { readonly session?: PhoneStreamSessionView; readonly error?: unknown }): void {
    this.mintScript.push(outcome)
  }

  async mintSession(deviceId: string): Promise<PhoneStreamSessionView> {
    this.mintedDevices.push(deviceId)
    const next = this.mintScript.shift()
    if (next !== undefined && next.error !== undefined) throw next.error
    return next?.session ?? SESSION_A
  }

  connectIo(handlers: PhoneIoHandlers): PhoneIoSocket {
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
