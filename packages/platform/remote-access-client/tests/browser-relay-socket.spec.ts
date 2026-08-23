import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserRelayEndpointSocket } from '../src/browser-relay-socket.ts'

const instances: FakeBrowserWebSocket[] = []
let openMode: 'open' | 'error' | 'pending' = 'open'

class FakeBrowserWebSocket {
  static readonly OPEN = 1
  binaryType = ''
  readyState = 0
  readonly sent: unknown[] = []
  readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>()
  closeCalls: Array<readonly [number | undefined, string | undefined]> = []

  constructor(readonly url: URL) {
    instances.push(this)
    if (openMode !== 'pending') queueMicrotask(() => {
      if (openMode === 'open') { this.readyState = FakeBrowserWebSocket.OPEN; this.emit('open') }
      else this.emit('error')
    })
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: unknown): void { this.sent.push(value) }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason])
    this.readyState = 3
    this.emit('close')
  }

  emit(type: string, data?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data })
  }
}

beforeEach(() => {
  instances.length = 0
  openMode = 'open'
  vi.stubGlobal('WebSocket', FakeBrowserWebSocket)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('BrowserRelayEndpointSocket', () => {
  it('owns a successful WSS carrier and bounds the live inbound queue', async () => {
    const socket = await BrowserRelayEndpointSocket.connect(
      'wss://platform.example/relay', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )
    const native = instances[0]
    if (native === undefined) throw new Error('browser WebSocket was not allocated')
    expect(native.binaryType).toBe('arraybuffer')
    await socket.send(Uint8Array.of(1, 2))
    expect(native.sent).toEqual([Uint8Array.of(1, 2)])

    const iterator = socket.messages()[Symbol.asyncIterator]()
    native.emit('message', Uint8Array.of(3, 4).buffer)
    await expect(iterator.next()).resolves.toEqual({ done: false, value: Uint8Array.of(3, 4) })
    native.emit('message', new ArrayBuffer(3))
    native.emit('message', new ArrayBuffer(2))
    await expect(iterator.next()).rejects.toThrow('inbound live queue exceeded its limit')
    expect(native.closeCalls).toContainEqual([1009, 'relay inbound limit'])
    await socket.close()
    await socket.close()
  })

  it('fails closed for protocol, open, send, and lifecycle cancellation errors', async () => {
    await expect(BrowserRelayEndpointSocket.connect(
      'ws://platform.example/relay', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )).rejects.toThrow('must use WSS')

    const loopback = await BrowserRelayEndpointSocket.connect(
      'ws://127.0.0.1:5174/v1/remote-access/relay', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )
    expect(instances.at(-1)?.url.href).toBe('ws://127.0.0.1:5174/v1/remote-access/relay')
    await loopback.close()

    openMode = 'error'
    await expect(BrowserRelayEndpointSocket.connect(
      'wss://platform.example/error', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )).rejects.toThrow('failed to open')

    openMode = 'pending'
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    await expect(BrowserRelayEndpointSocket.connect(
      'wss://platform.example/pre-aborted', alreadyCancelled.signal, { maxBytes: 4, maxMessages: 1 },
    )).rejects.toThrow('acquisition was cancelled')
    expect(instances.at(-1)?.closeCalls).toHaveLength(1)

    const cancelled = new AbortController()
    const connecting = BrowserRelayEndpointSocket.connect(
      'wss://platform.example/pending', cancelled.signal, { maxBytes: 4, maxMessages: 1 },
    )
    cancelled.abort()
    await expect(connecting).rejects.toThrow('acquisition was cancelled')

    openMode = 'open'
    const socket = await BrowserRelayEndpointSocket.connect(
      'wss://platform.example/relay', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )
    const native = instances.at(-1)
    if (native === undefined) throw new Error('browser WebSocket was not allocated')
    native.readyState = 3
    await expect(socket.send(Uint8Array.of(1))).rejects.toThrow('closed')
    native.emit('message', 'not-binary')
    await expect(socket.messages()[Symbol.asyncIterator]().next()).rejects.toThrow('requires binary')
    native.emit('error')

    const closing = await BrowserRelayEndpointSocket.connect(
      'wss://platform.example/close', new AbortController().signal, { maxBytes: 4, maxMessages: 1 },
    )
    await closing.close()
    await closing.close()
  })
})
