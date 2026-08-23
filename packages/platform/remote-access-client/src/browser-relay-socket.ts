import { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import type { RelayEndpointSocket } from './relay.ts'
import { RelayInboundQueue, type RelayInboundQueueLimits } from './relay-queue.ts'

/** Browser WebSocket adapter with a bounded live inbound queue. */
export class BrowserRelayEndpointSocket implements RelayEndpointSocket {
  private readonly queue: RelayInboundQueue
  private readonly done: Promise<void>
  private closed = false

  private constructor(private readonly socket: WebSocket, limits: RelayInboundQueueLimits) {
    this.queue = new RelayInboundQueue(limits)
    socket.binaryType = 'arraybuffer'
    this.done = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        try {
          if (!(event.data instanceof ArrayBuffer)) {
            throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay WebSocket requires binary frames')
          }
          this.queue.push(new Uint8Array(event.data))
        } catch (error) {
          this.queue.fail(error)
          socket.close(1009, 'relay inbound limit')
        }
      })
      socket.addEventListener('close', () => {
        this.closed = true
        this.queue.end()
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        this.queue.fail(new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket failed'))
      })
    })
  }

  /**
   * Open one browser WebSocket owned by the supplied lifecycle signal.
   * @param url - deployment WSS endpoint, or loopback `ws:` when the page cannot present the listen certificate.
   * @param signal - lifecycle cancellation.
   * @param limits - bounded live inbound queue.
   * @returns connected Relay socket.
   */
  static async connect(url: string, signal: AbortSignal, limits: RelayInboundQueueLimits): Promise<BrowserRelayEndpointSocket> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'wss:' && !isLoopbackWs(parsed)) {
      throw new TypeError('Browser Relay endpoint must use WSS')
    }
    const socket = new WebSocket(parsed)
    await opened(socket, signal)
    return new BrowserRelayEndpointSocket(socket, limits)
  }

  send(value: Uint8Array): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket is closed'))
    }
    this.socket.send(Uint8Array.from(value))
    return Promise.resolve()
  }

  messages(): AsyncIterable<Uint8Array> { return this.queue }

  async close(): Promise<void> {
    if (!this.closed) this.socket.close()
    await this.done
  }
}

function isLoopbackWs(url: URL): boolean {
  return url.protocol === 'ws:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
}

function opened(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      socket.close()
      reject(new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket acquisition was cancelled'))
      return
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    signal.addEventListener('abort', aborted, { once: true })
    function onOpen(): void { finish(resolve) }
    function onError(): void {
      finish(() => { reject(new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket failed to open')) })
    }
    function aborted(): void {
      socket.close()
      finish(() => { reject(new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket acquisition was cancelled')) })
    }
    function finish(settle: () => void): void {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      signal.removeEventListener('abort', aborted)
      settle()
    }
  })
}
