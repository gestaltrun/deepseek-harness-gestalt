import { once } from 'node:events'
import type { Agent } from 'node:http'
import { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import WebSocket, { type RawData } from 'ws'
import type { RelayEndpointSocket } from './relay.ts'
import { RelayInboundQueue, type RelayInboundQueueLimits } from './relay-queue.ts'

/** Node WSS connection policy supplied by the endpoint-owned native adapter. */
export interface NodeRelayConnectionOptions {
  /** Optional HTTP CONNECT agent selected by the native system proxy owner. */
  agent?: Agent
  /** Test-only TLS trust override; production omits it. */
  rejectUnauthorized?: boolean
}

/** Node WebSocket adapter with wire-level maxPayload and a bounded live inbound queue. */
export class NodeRelayEndpointSocket implements RelayEndpointSocket {
  private readonly queue: RelayInboundQueue
  private readonly done: Promise<void>
  private closed = false

  private constructor(private readonly socket: WebSocket, limits: RelayInboundQueueLimits) {
    this.queue = new RelayInboundQueue(limits)
    this.done = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        try { this.queue.push(bytes(data)) }
        catch (error) {
          this.queue.fail(error)
          socket.close(1009, 'relay inbound limit')
        }
      })
      socket.once('close', () => { this.closed = true; this.queue.end(); resolve() })
      socket.once('error', () => { this.queue.fail(new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket failed')) })
    })
  }

  /**
   * Open one Node WSS connection owned by the supplied lifecycle signal.
   * @param url - deployment WSS endpoint.
   * @param signal - lifecycle cancellation.
   * @param limits - bounded live inbound queue.
   * @param options - optional native proxy agent and test-only TLS trust override.
   * @returns connected Relay socket.
   */
  static async connect(
    url: string,
    signal: AbortSignal,
    limits: RelayInboundQueueLimits,
    options?: NodeRelayConnectionOptions,
  ): Promise<NodeRelayEndpointSocket> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'wss:') throw new TypeError('Node Relay endpoint must use WSS')
    const socket = new WebSocket(parsed, {
      perMessageDeflate: false,
      maxPayload: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
      ...(options?.agent === undefined ? {} : { agent: options.agent }),
      ...(options?.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
    })
    try {
      await once(socket, 'open', { signal })
    } catch (error) {
      socket.terminate()
      if (signal.aborted) {
        throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket acquisition was cancelled')
      }
      if (error instanceof Error) throw error
      throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket failed to open')
    }
    return new NodeRelayEndpointSocket(socket, limits)
  }

  async send(value: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new RemoteRelayError('REMOTE_OFFLINE', 'Relay WebSocket is closed'))
        return
      }
      this.socket.send(value, { binary: true }, (error) => { if (error == null) resolve(); else reject(error) })
    })
  }

  messages(): AsyncIterable<Uint8Array> { return this.queue }

  async close(): Promise<void> {
    if (!this.closed) this.socket.close()
    await this.done
  }
}

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const { buffer, byteOffset, byteLength } = data
  return new Uint8Array(buffer, byteOffset, byteLength)
}
