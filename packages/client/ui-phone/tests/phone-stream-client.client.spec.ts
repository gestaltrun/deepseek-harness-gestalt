/**
 * The same-origin stream transport: the io frame codec, reply parsing, mint
 * failure classification, `POST /phone/session` over fetch, and the io
 * WebSocket wiring — against stubbed browser globals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHttpPhoneGateway, encodePhoneIoFrame, installPhoneAgent, mintPhoneSession, openPhoneIoSocket,
  parsePhoneIoReply, PHONE_AGENT_PATH, PHONE_SESSION_PATH, PhoneStreamHttpError, readPhoneAgentStatus,
} from '../src/client/phone-stream-client.ts'

async function rejectionOf(run: () => Promise<unknown>): Promise<PhoneStreamHttpError> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof PhoneStreamHttpError) return error
    throw error
  }
  throw new Error('expected PhoneStreamHttpError')
}

/** The io upgrade path the Host mints into every session. */
const MINTED_IO_PATH = '/phone/ws/io'

afterEach(() => { vi.unstubAllGlobals() })

describe('io frame codec', () => {
  it('encodes the four io methods onto the phoneStream JSON-RPC signature', () => {
    expect(JSON.parse(encodePhoneIoFrame(1, 'emulator-5554', { method: 'tap', x: 12, y: 34 }))).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap', params: { deviceId: 'emulator-5554', x: 12, y: 34 },
    })
    expect(JSON.parse(encodePhoneIoFrame(5, 'emulator-5554', {
      method: 'tap', x: 99, y: 660, captureWidth: 2_868, captureHeight: 1_320,
    }))).toEqual({
      jsonrpc: '2.0', id: 5, method: 'tap',
      params: {
        deviceId: 'emulator-5554', x: 99, y: 660, captureWidth: 2_868, captureHeight: 1_320,
      },
    })
    expect(JSON.parse(encodePhoneIoFrame(2, 'emulator-5554', {
      method: 'gesture', actions: [{ type: 'pointerDown', x: 1, y: 2 }],
    }))).toEqual({
      jsonrpc: '2.0', id: 2, method: 'gesture',
      params: { deviceId: 'emulator-5554', actions: [{ type: 'pointerDown', x: 1, y: 2 }] },
    })
    expect(JSON.parse(encodePhoneIoFrame(6, 'emulator-5554', {
      method: 'gesture',
      actions: [{ type: 'pointerMove', x: 99, y: 660 }],
      captureWidth: 2_868,
      captureHeight: 1_320,
    }))).toEqual({
      jsonrpc: '2.0', id: 6, method: 'gesture',
      params: {
        deviceId: 'emulator-5554',
        actions: [{ type: 'pointerMove', x: 99, y: 660 }],
        captureWidth: 2_868,
        captureHeight: 1_320,
      },
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
      agentManaged: false,
      preferredFormat: 'h264',
      mjpeg: { url: '/phone/stream/emulator-5554/mjpeg?token=a', expiresAt: 1234 },
      h264: { url: '/phone/stream/emulator-5554/h264?token=a', expiresAt: 1234 },
    }
    const seen = await stubFetch(200, session)
    expect(await mintPhoneSession('emulator-5554')).toEqual(session)
    expect(seen.input).toBe(PHONE_SESSION_PATH)
    expect(seen.init.method).toBe('POST')
    expect(seen.init.body).toBe(JSON.stringify({ deviceId: 'emulator-5554', format: 'avc' }))
  })

  it('uses the requested device when an otherwise valid response omits its echo', async () => {
    await stubFetch(200, {
      ioPath: '/phone/ws/io',
      agentManaged: false,
      preferredFormat: 'mjpeg',
      mjpeg: { url: '/phone/stream/fallback/mjpeg?token=a', expiresAt: 1234 },
      h264: { url: '/phone/stream/fallback/h264?token=a', expiresAt: 1234 },
    })
    expect(await mintPhoneSession('fallback-device')).toMatchObject({
      deviceId: 'fallback-device', preferredFormat: 'mjpeg',
    })
  })

  it('maps error payloads and malformed bodies onto the wire error', async () => {
    await stubFetch(404, { error: { code: 'not-found', message: 'absent from the listing' } })
    const missing = await rejectionOf(() => mintPhoneSession('gone'))
    expect(missing.code).toBe('not-found')

    await stubFetch(502, {
      error: {
        code: 'PHONE_REAL_DEVICE_ISSUE',
        issue: 'device-locked',
        message: 'unlock the device',
      },
    })
    const locked = await rejectionOf(() => mintPhoneSession('UDID-9'))
    expect(locked.issue).toBe('device-locked')

    await stubFetch(500, 'not json')
    const broken = await rejectionOf(() => mintPhoneSession('x'))
    expect(broken.code).toBe('http')

    await stubFetch(200, { ioPath: 42 })
    await expect(mintPhoneSession('x')).rejects.toBeInstanceOf(PhoneStreamHttpError)

    await stubFetch(200, {
      ioPath: '/phone/ws/io',
      agentManaged: false,
      preferredFormat: 'av1',
      mjpeg: { url: '/phone/stream/x/mjpeg?token=a', expiresAt: 1234 },
      h264: { url: '/phone/stream/x/h264?token=a', expiresAt: 1234 },
    })
    await expect(mintPhoneSession('x')).rejects.toBeInstanceOf(PhoneStreamHttpError)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 500 })))
    const unparseable = await rejectionOf(() => mintPhoneSession('x'))
    expect(unparseable.message).toBe('phone session mint failed with HTTP 500')
  })

  it('wraps network refusals as status-0 wire errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('load failed')
    }))
    const network = await rejectionOf(() => mintPhoneSession('x'))
    expect(network.status).toBe(0)

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'socket reset'
    }))
    const nonError = await rejectionOf(() => mintPhoneSession('x'))
    expect(nonError.message).toBe('socket reset')
  })
})

describe('iOS real-device agent operations', () => {
  it('reads status and requests a forced reinstall through trusted same-origin POSTs', async () => {
    const calls: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) })
      return new Response(JSON.stringify(calls.length === 1
        ? {
          deviceId: 'UDID-9', installed: true, version: '0.0.25', bundleId: 'agent.bundle',
          profileReminder: 'free profile expires',
        }
        : { deviceId: 'UDID-9', installed: true, reinstalled: true }), { status: 200 })
    }))

    expect(await readPhoneAgentStatus('UDID-9')).toMatchObject({ installed: true, version: '0.0.25' })
    expect(await installPhoneAgent('UDID-9', true)).toMatchObject({ installed: true, reinstalled: true })
    expect(calls.map(call => call.input)).toEqual([
      `${PHONE_AGENT_PATH}/status`,
      `${PHONE_AGENT_PATH}/install`,
    ])
    expect(calls.map(call => call.init?.body)).toEqual([
      JSON.stringify({ deviceId: 'UDID-9' }),
      JSON.stringify({ deviceId: 'UDID-9', force: true }),
    ])
  })

  it('keeps structured install issues and rejects malformed status answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'PHONE_REAL_DEVICE_ISSUE', issue: 'profile-expired', message: 'profile expired',
      },
    }), { status: 502 })))
    expect((await rejectionOf(() => installPhoneAgent('UDID-9', true))).issue).toBe('profile-expired')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ installed: 'yes' }), { status: 200 })))
    await expect(readPhoneAgentStatus('UDID-9')).rejects.toMatchObject({ code: 'protocol' })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))
    await expect(readPhoneAgentStatus('UDID-9')).rejects.toMatchObject({ code: 'protocol' })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      deviceId: 'UDID-9', installed: true, reinstalled: 'yes',
    }), { status: 200 })))
    await expect(installPhoneAgent('UDID-9', true)).rejects.toMatchObject({ code: 'protocol' })
  })

  it('normalizes agent network and non-JSON failures and accepts the minimal status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    await expect(readPhoneAgentStatus('UDID-9')).rejects.toMatchObject({ code: 'network', message: 'network down' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'socket gone' }))
    await expect(installPhoneAgent('UDID-9', false)).rejects.toMatchObject({ code: 'network', message: 'socket gone' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 502 })))
    await expect(readPhoneAgentStatus('UDID-9')).rejects.toMatchObject({
      code: 'http', message: 'phone agent status failed with HTTP 502',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      deviceId: 'UDID-9', installed: false,
    }), { status: 200 })))
    expect(await readPhoneAgentStatus('UDID-9')).toEqual({ deviceId: 'UDID-9', installed: false })
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
    const socket = openPhoneIoSocket({ ioPath: MINTED_IO_PATH }, {
      onOpen: () => { events.push('open') },
      onClose: () => { events.push('close') },
      onError: () => { events.push('error') },
      onMessage: (data) => { events.push(data) },
    })
    expect(urls).toEqual([`ws://127.0.0.1:57641${MINTED_IO_PATH}`])
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
    const socket = gateway.connectIo(
      { ioPath: MINTED_IO_PATH },
      { onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} },
    )
    expect(urls[0]).toBe(`wss://phone.example.net${MINTED_IO_PATH}`)
    socket.send('tap')
    socket.close()
    expect(sent).toEqual(['tap'])
  })

  it('mints through the production gateway facade', async () => {
    const body = {
      deviceId: 'R3CN30',
      ioPath: MINTED_IO_PATH,
      agentManaged: false,
      preferredFormat: 'h264',
      mjpeg: { url: '/phone/stream/R3CN30/mjpeg?token=a', expiresAt: 1234 },
      h264: { url: '/phone/stream/R3CN30/h264?token=a', expiresAt: 1234 },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    expect((await createHttpPhoneGateway().mintSession('R3CN30')).deviceId).toBe('R3CN30')
  })

  it('runs agent status and install through the production gateway facade', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('agent gateway request body must be JSON text')
      const request = JSON.parse(init.body) as { force?: boolean }
      return new Response(JSON.stringify({
        deviceId: 'UDID-9', installed: true,
        ...(request.force === undefined ? {} : { reinstalled: request.force }),
      }), { status: 200 })
    }))
    const gateway = createHttpPhoneGateway()
    expect(await gateway.agentStatus('UDID-9')).toMatchObject({ installed: true })
    expect(await gateway.installAgent('UDID-9', true)).toMatchObject({ reinstalled: true })
  })
})
