import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'

const sockets: FakeNodeWebSocket[] = []
let openMode: 'open' | 'error' | 'string-error' | 'pending' = 'open'

class FakeNodeWebSocket extends EventEmitter {
  static readonly OPEN = 1
  readyState = 0
  readonly sent: Uint8Array[] = []
  sendFailure: Error | undefined
  terminated = false
  readonly options: Record<string, unknown>

  constructor(readonly url: URL, options: Record<string, unknown>) {
    super()
    this.options = options
    sockets.push(this)
    if (openMode !== 'pending') queueMicrotask(() => {
      if (openMode === 'open') { this.readyState = FakeNodeWebSocket.OPEN; this.emit('open') }
      else this.emit('error', openMode === 'error' ? new Error('TLS failed') : 'native failure')
    })
  }

  send(value: Uint8Array, _options: unknown, callback: (error?: Error) => void): void {
    this.sent.push(value)
    callback(this.sendFailure)
  }

  close(): void { this.readyState = 3; this.emit('close') }
  terminate(): void { this.terminated = true; this.close() }
}

vi.mock('ws', () => ({ default: FakeNodeWebSocket }))

const { NodeRelayEndpointSocket } = await import('../src/node-relay-socket.ts')

beforeEach(() => { sockets.length = 0; openMode = 'open' })
afterEach(() => { vi.restoreAllMocks() })

describe('NodeRelayEndpointSocket', () => {
  it('sets the wire maxPayload and owns successful send, receive, and close', async () => {
    const agent = {} as never
    const socket = await NodeRelayEndpointSocket.connect(
      'wss://platform.example/relay', new AbortController().signal,
      { maxBytes: REMOTE_PROTOCOL_LIMITS.relayMessageBytes, maxMessages: 3 },
      { agent, rejectUnauthorized: false },
    )
    const native = sockets[0]
    if (native === undefined) throw new Error('Node WebSocket was not allocated')
    expect(native.options).toMatchObject({
      maxPayload: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
      perMessageDeflate: false,
      rejectUnauthorized: false,
      agent,
    })
    await socket.send(Uint8Array.of(1))
    expect(native.sent).toEqual([Uint8Array.of(1)])
    const iterator = socket.messages()[Symbol.asyncIterator]()
    native.emit('message', Buffer.from([2]))
    native.emit('message', new ArrayBuffer(1))
    native.emit('message', [Buffer.from([3]), Buffer.from([4])])
    await expect(iterator.next()).resolves.toMatchObject({ value: Uint8Array.of(2) })
    await expect(iterator.next()).resolves.toMatchObject({ value: new Uint8Array(1) })
    await expect(iterator.next()).resolves.toMatchObject({ value: Uint8Array.of(3, 4) })
    await socket.close()
    await socket.close()
  })

  it('fails closed for invalid URL, open, send, inbound, and cancellation failures', async () => {
    await expect(NodeRelayEndpointSocket.connect(
      'ws://platform.example/relay', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )).rejects.toThrow('must use WSS')

    openMode = 'error'
    await expect(NodeRelayEndpointSocket.connect(
      'wss://platform.example/error', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )).rejects.toThrow('TLS failed')

    openMode = 'string-error'
    await expect(NodeRelayEndpointSocket.connect(
      'wss://platform.example/error', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )).rejects.toThrow('failed to open')

    openMode = 'pending'
    const cancelled = new AbortController()
    const connecting = NodeRelayEndpointSocket.connect(
      'wss://platform.example/pending', cancelled.signal, { maxBytes: 4, maxMessages: 1 },
    )
    cancelled.abort()
    await expect(connecting).rejects.toThrow('acquisition was cancelled')
    expect(sockets.at(-1)?.terminated).toBe(true)

    openMode = 'open'
    const socket = await NodeRelayEndpointSocket.connect(
      'wss://platform.example/relay', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )
    const native = sockets.at(-1)
    if (native === undefined) throw new Error('Node WebSocket was not allocated')
    native.sendFailure = new Error('write failed')
    await expect(socket.send(Uint8Array.of(1))).rejects.toThrow('write failed')
    native.readyState = 3
    await expect(socket.send(Uint8Array.of(1))).rejects.toThrow('closed')
    native.emit('message', Buffer.alloc(5))
    await expect(socket.messages()[Symbol.asyncIterator]().next()).rejects.toThrow('inbound live queue exceeded its limit')
    native.emit('error', new Error('socket failed'))
  })
})
