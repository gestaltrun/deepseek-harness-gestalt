/**
 * The same-origin stream transport: the io frame codec, reply parsing, mint
 * failure classification, `POST /phone/session` over fetch, and the io
 * WebSocket wiring — against stubbed browser globals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHttpPhoneGateway, encodePhoneIoFrame, mintPhoneSession, openPhoneIoSocket,
  parsePhoneIoReply, PHONE_IO_PATH, PHONE_SESSION_PATH, PhoneStreamHttpError,
} from '../src/client/phone-stream-client.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('io frame codec', () => {
  it('encodes the four io methods onto the phoneStream JSON-RPC signature', () => {
    expect(JSON.parse(encodePhoneIoFrame(1, 'emulator-5554', { method: 'tap', x: 12, y: 34 }))).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap', params: { deviceId: 'emulator-5554', x: 12, y: 34 },
    })
    expect(JSON.parse(encodePhoneIoFrame(2, 'emulator-5554', {
      method: 'gesture', actions: [{ type: 'pointerDown', x: 1, y: 2 }],
    }))).toEqual({
      jsonrpc: '2.0', id: 2, method: 'gesture',
      params: { deviceId: 'emulator-5554', actions: [{ type: 'pointerDown', x: 1, y: 2 }] },
    })
    expect(JSON.parse(encodePhoneIoFrame(3, 'R3CN30', { method: 'text', text: '验证码' }))).toEqual({
      jsonrpc: '2.0', id: 3, method: 'text', params: { deviceId: 'R3CN30', text: '验证码' },
    })
    expect(JSON.parse(encodePhoneIoFrame(4, 'R3CN30', { method: 'button', button: 'BACK' }))).toEqual({
      jsonrpc: '2.0', id: 4, method: 'button', params: { deviceId: 'R3CN30', button: 'BACK' },
    })
  })

  it('parses ok and error replies and drops non-replies', () => {
    expect(parsePhoneIoReply(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { status: 'ok' } })))
      .toEqual({ id: 7, ok: true })
    expect(parsePhoneIoReply(JSON.stringify({
      jsonrpc: '2.0', id: 8, error: { code: -32010, message: 'PHONE_DEVICE_NOT_FOUND' },
    }))).toEqual({ id: 8, ok: false, code: -32010, message: 'PHONE_DEVICE_NOT_FOUND' })
    expect(parsePhoneIoReply(JSON.stringify({ jsonrpc: '2.0', id: 9, error: {} })))
      .toEqual({ id: 9, ok: false, code: undefined, message: undefined })
    expect(parsePhoneIoReply('not json')).toBeUndefined()
    expect(parsePhoneIoReply(JSON.stringify({ jsonrpc: '2.0', method: 'tap' }))).toBeUndefined()
    expect(parsePhoneIoReply('42')).toBeUndefined()
  })
})

describe('session minting', () => {
  async function stubFetch(status: number, body: unknown): Promise<{ input: RequestInfo | URL; init: RequestInit }> {
    const seen: { input: RequestInfo | URL; init: RequestInit } = {} as never
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.input = input
      seen.init = init ?? {}
      return new Response(JSON.stringify(body), { status })
    }))
    return seen
  }

  it('mints a session from the same-origin endpoint and echoes the wire shape', async () => {
    const session = {
      deviceId: 'emulator-5554',
      ioPath: '/phone/ws/io',
      mjpeg: { url: '/phone/stream/emulator-5554/mjpeg?token=a', expiresAt: 1234 },
      h264: { url: '/phone/stream/emulator-5554/h264?token=a', expiresAt: 1234 },
    }
    const seen = await stubFetch(200, session)
    expect(await mintPhoneSession('emulator-5554')).toEqual(session)
    expect(seen.input).toBe(PHONE_SESSION_PATH)
    expect(seen.init.method).toBe('POST')
    expect(seen.init.body).toBe(JSON.stringify({ deviceId: 'emulator-5554' }))
  })

  it('maps error payloads and malformed bodies onto the wire error', async () => {
    await stubFetch(404, { error: { code: 'not-found', message: 'absent from the listing' } })
    const missing = await mintPhoneSession('gone').catch(error => error)
    expect(missing).toBeInstanceOf(PhoneStreamHttpError)
    expect(missing.code).toBe('not-found')

    await stubFetch(500, 'not json')
    const broken = await mintPhoneSession('x').catch(error => error)
    expect(broken).toBeInstanceOf(PhoneStreamHttpError)
    expect(broken.code).toBe('http')

    await stubFetch(200, { ioPath: 42 })
    const malformed = await mintPhoneSession('x').catch(error => error)
    expect(malformed).toBeInstanceOf(PhoneStreamHttpError)
  })

  it('wraps network refusals as status-0 wire errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('load failed')
    }))
    const network = await mintPhoneSession('x').catch(error => error)
    expect(network).toBeInstanceOf(PhoneStreamHttpError)
    expect(network.status).toBe(0)
  })
})

describe('io socket wiring', () => {
  const sent: string[] = []
  const urls: string[] = []
  const instances: FakeWebSocket[] = []

  class FakeWebSocket {
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    constructor(url: string) {
      urls.push(url)
      instances.push(this)
    }
    send(data: string): void { sent.push(data) }
    close(): void { urls.push('closed') }
  }

  function stubSocket(locationShard: { readonly protocol: string; readonly host: string }): void {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('location', locationShard)
  }

  afterEach(() => {
    sent.length = 0
    urls.length = 0
    instances.length = 0
  })

  it('dials the same-origin io path and forwards events, frames, and closes', () => {
    stubSocket({ protocol: 'http:', host: '127.0.0.1:57641' })
    const events: string[] = []
    const socket = openPhoneIoSocket({
      onOpen: () => { events.push('open') },
      onClose: () => { events.push('close') },
      onError: () => { events.push('error') },
      onMessage: (data) => { events.push(data) },
    })
    expect(urls).toEqual([`ws://127.0.0.1:57641${PHONE_IO_PATH}`])
    const ws = instances[0]!
    ws.onopen?.()
    ws.onmessage?.({ data: 'reply' })
    ws.onmessage?.({ data: 42 })
    ws.onerror?.()
    ws.onclose?.()
    socket.send('frame')
    socket.close()
    expect(events).toEqual(['open', 'reply', '', 'error', 'close'])
    expect(sent).toEqual(['frame'])
    expect(urls).toContain('closed')
  })

  it('wires the production gateway onto the wss upgrade arm', () => {
    stubSocket({ protocol: 'https:', host: 'phone.example.net' })
    const gateway = createHttpPhoneGateway()
    const socket = gateway.connectIo({ onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} })
    expect(urls[0]).toBe(`wss://phone.example.net${PHONE_IO_PATH}`)
    socket.send('tap')
    socket.close()
    expect(sent).toEqual(['tap'])
  })
})
