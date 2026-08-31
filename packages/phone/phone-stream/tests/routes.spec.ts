import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import PhoneDevices, { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import PhoneStream, { PHONE_IO_PATH } from '../src/index.ts'
import { assertRecognizableH264Picture, assertStructurallyDecodableJpeg, jpegDimensions, stageFake, wireDevice } from '../../phone-runtime/tests/helpers.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const ANDROID = deviceId('emulator-5554')

function parseWebSocketJson(data: RawData): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
  return JSON.parse(bytes.toString('utf8')) as unknown
}

const contexts: Context[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

async function mount(
  devices: Array<Record<string, unknown>> = [wireDevice('emulator-5554', 'android', 'emulator', 'online')],
  fakeKnobs: Record<string, unknown> = {},
): Promise<{ context: Context; origin: string }> {
  const fake = await stageFake({ devices, ...fakeKnobs })
  fakes.push(fake)
  await fake.claim()
  const context = new Context()
  contexts.push(context)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await context.plugin(PhoneDevices, {
    executablePath: fake.executablePath,
    serverPort: fake.port,
    pollIntervalMs: 20,
    readyTimeoutMs: 6_000,
    requestTimeoutMs: 1_500,
    bootTimeoutMs: 2_000,
  }).await()
  await context.plugin(PhoneStream, {}).await()
  return { context, origin: `http://127.0.0.1:${String(context.webServer.port)}` }
}

async function mint(origin: string, id = 'emulator-5554'): Promise<{
  ioPath: string
  mjpeg: { url: string; expiresAt: number }
  h264: { url: string; expiresAt: number }
}> {
  const response = await fetch(`${origin}/phone/session`, {
    method: 'POST',
    headers: { host: new URL(origin).host, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: id }),
  })
  expect(response.status).toBe(200)
  return await response.json() as {
    ioPath: string
    mjpeg: { url: string; expiresAt: number }
    h264: { url: string; expiresAt: number }
  }
}

async function rawRequest(options: {
  readonly origin: string
  readonly method?: string
  readonly path: string
  readonly host: string
  readonly body?: string
}): Promise<{ status: number; contentType: string; body: Buffer }> {
  const url = new URL(options.origin)
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: {
        host: options.host,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(options.body)) }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'] ?? '',
          body: Buffer.concat(chunks),
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/**
 * Read the capture stream until the first complete MJPEG frame arrived (up to
 * its boundary terminator) or the stream ended, so assertions never depend on
 * how the proxy chunked the writes.
 */
function readFrame(origin: string, path: string, host: string): Promise<{
  status: number
  contentType: string
  body: Buffer
}> {
  const url = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      method: 'GET',
      path,
      headers: { host },
    }, (res) => {
      const chunks: Buffer[] = []
      let acc = Buffer.alloc(0)
      const settle = (body: Buffer) => {
        req.destroy()
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'] ?? '',
          body,
        })
      }
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        acc = Buffer.concat(chunks)
        if (acc.includes('\r\n--frame')) settle(acc)
      })
      res.once('end', () => {
        settle(Buffer.concat(chunks))
      })
      res.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') return
        reject(error)
      })
    })
    req.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') return
      reject(error)
    })
    req.end()
  })
}

describe('phone stream Host routes', () => {
  it('answers the grouped device listing with platform groups and online states', async () => {
    const { origin } = await mount([
      wireDevice('emulator-5554', 'android', 'emulator', 'online'),
      wireDevice('R3CN30', 'android', 'real', 'offline'),
      wireDevice('iPhone-16', 'ios', 'simulator', 'online'),
      wireDevice('UDID-9', 'ios', 'real', 'offline'),
    ])
    const host = new URL(origin).host
    const response = await rawRequest({ origin, path: '/phone/devices', host })
    expect(response.status).toBe(200)
    expect(response.contentType).toContain('application/json')
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      android: [
        { id: 'emulator-5554', name: 'emulator-5554-name', kind: 'emulator', state: 'online', online: true },
        { id: 'R3CN30', name: 'R3CN30-name', kind: 'real', state: 'offline', online: false },
      ],
      ios: {
        simulators: [{ id: 'iPhone-16', name: 'iPhone-16-name', kind: 'simulator', state: 'online', online: true }],
        reals: [{ id: 'UDID-9', name: 'UDID-9-name', kind: 'real', state: 'offline', online: false }],
      },
    })
  })

  it('serves the listing only to trusted GET requests on the exact path', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    expect((await rawRequest({ origin, method: 'POST', path: '/phone/devices', host })).status).toBe(405)
    expect((await rawRequest({ origin, path: '/phone/devices/extra', host })).status).toBe(404)
    expect((await rawRequest({ origin, path: '/phone/devices', host: 'evil.example' })).status).toBe(403)
  })

  it('answers 502 when the listing fails upstream', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    context.phoneDevices.listDevices = async () => {
      throw new Error('listing backend down')
    }
    expect((await rawRequest({ origin, path: '/phone/devices', host })).status).toBe(502)
  })

  it('answers 502 with PHONE_UNRESOLVED and install guidance when mobilecli is missing', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    context.phoneDevices.listDevices = async () => {
      throw new PhoneDevicesError(
        'PHONE_UNRESOLVED',
        'phone-runtime: cannot resolve the mobilecli executable.\nInstall it first, then retry:\n  npm install -g mobilecli@latest',
      )
    }
    const response = await rawRequest({ origin, path: '/phone/devices', host })
    expect(response.status).toBe(502)
    const body = JSON.parse(response.body.toString('utf8')) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('PHONE_UNRESOLVED')
    expect(body.error?.message).toContain('npm install -g mobilecli@latest')
  })

  it('refuses a signed capture URL that is expired, forged, or not loopback', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    const forged = session.mjpeg.url.replace(/token=[^&]+/u, 'token=1.not-a-signature')
    const expired = session.mjpeg.url.replace(/token=[^&]+/u, `token=${String(Date.now() - 1)}.${'a'.repeat(43)}`)
    expect((await rawRequest({ origin, path: forged, host })).status).toBe(403)
    expect((await rawRequest({ origin, path: expired, host })).status).toBe(403)
    expect((await rawRequest({ origin, path: session.mjpeg.url, host: 'example.com' })).status).toBe(403)
    expect((await rawRequest({ origin, path: session.mjpeg.url, host: '192.168.1.5:3080' })).status).toBe(403)
  })

  it('delivers at least one MJPEG frame and one H264 Annex-B prefix through signed loopback URLs', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    const mjpeg = await readFrame(origin, session.mjpeg.url, host)
    expect(mjpeg.status).toBe(200)
    expect(mjpeg.contentType).toMatch(/multipart\/x-mixed-replace/)
    // The proxy passes the upstream bytes through; assert the delivered frame
    // is a complete JPEG (SOI…EOI) rather than assuming marker adjacency.
    const headerEnd = mjpeg.body.indexOf('\r\n\r\n')
    expect(headerEnd).toBeGreaterThanOrEqual(0)
    const frame = mjpeg.body.subarray(headerEnd + 4, mjpeg.body.indexOf('\r\n--frame'))
    expect(frame.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
    expect(frame.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true)
    expect(jpegDimensions(frame)).toEqual({ width: 390, height: 844 })
    const h264 = await readFrame(origin, session.h264.url, host)
    expect(h264.status).toBe(200)
    expect(h264.contentType).toMatch(/video\/h264/)
    assertRecognizableH264Picture(h264.body)
  })

  it('delivers decodable frames when the real backend answers the capture envelope', async () => {
    const { origin } = await mount([wireDevice('emulator-5554', 'android', 'emulator', 'online')], { captureEnvelope: true })
    const host = new URL(origin).host
    const session = await mint(origin)
    const mjpeg = await readFrame(origin, session.mjpeg.url, host)
    expect(mjpeg.status).toBe(200)
    expect(mjpeg.contentType).toMatch(/multipart\/x-mixed-replace/)
    const headerEnd = mjpeg.body.indexOf('\r\n\r\n')
    expect(headerEnd).toBeGreaterThanOrEqual(0)
    const frame = mjpeg.body.subarray(headerEnd + 4, mjpeg.body.indexOf('\r\n--frame'))
    assertStructurallyDecodableJpeg(frame)
    expect(jpegDimensions(frame)).toEqual({ width: 390, height: 844 })
  })

  it('normalizes the real R4 dual-boundary stream to a single image-frame boundary', async () => {
    const { origin } = await mount([wireDevice('emulator-5554', 'android', 'emulator', 'online')], { dualBoundaryStream: true })
    const host = new URL(origin).host
    const session = await mint(origin)
    const mjpeg = await readFrame(origin, session.mjpeg.url, host)
    expect(mjpeg.status).toBe(200)
    expect(mjpeg.contentType).toBe('multipart/x-mixed-replace; boundary=frame')
    const body = mjpeg.body.toString('utf8')
    // The upstream notification family and its undeclared frame boundary are gone.
    expect(body).not.toContain('BoundaryString')
    expect(body).not.toContain('mjpeg-frame-boundary')
    expect(body).not.toContain('notification')
    // readFrame stops at the first frame terminator; a streaming proxy owes
    // the browser exactly that one frame per read, not the whole upstream.
    expect(body.split('--frame\r\n').length - 1).toBe(1)
    const headerEnd = mjpeg.body.indexOf('\r\n\r\n')
    const frame = mjpeg.body.subarray(headerEnd + 4, mjpeg.body.indexOf('\r\n--frame'))
    assertStructurallyDecodableJpeg(frame)
    expect(jpegDimensions(frame)).toEqual({ width: 390, height: 844 })
  })

  it('cancels the upstream capture when the browser disconnects mid-stream', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    let cancelled = false
    context.phoneDevices.startCapture = async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x00, 0x00, 0x00, 0x01]))
        },
        cancel() {
          cancelled = true
        },
      }),
    })
    const url = new URL(origin)
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        hostname: url.hostname,
        port: url.port,
        method: 'GET',
        path: session.h264.url,
        headers: { host },
      }, (res) => {
        res.once('data', () => {
          res.destroy()
          resolve()
        })
        res.once('error', (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve()
          else reject(error)
        })
      })
      req.once('error', reject)
      req.end()
    })
    await vi.waitFor(() => { expect(cancelled).toBe(true) })
  })

  it('closes the browser response when the upstream capture stream fails', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    context.phoneDevices.startCapture = async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('capture stream failed'))
        },
      }),
    })
    const body = fetch(`${origin}${session.h264.url}`, { headers: { host } })
      .then(async response => await response.arrayBuffer())
    await expect(body).rejects.toThrow()
  })

  it('forwards tap JSON-RPC over the trusted WebSocket upgrade', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    expect(session.ioPath).toBe(PHONE_IO_PATH)
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}${PHONE_IO_PATH}`, { headers: { host } })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    const reply = new Promise<unknown>((resolve) => {
      socket.once('message', (data) => { resolve(parseWebSocketJson(data)) })
    })
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tap',
      params: { deviceId: ANDROID, x: 9, y: 10 },
    }))
    expect(await reply).toEqual({ jsonrpc: '2.0', id: 7, result: { status: 'ok' } })
    socket.close()
  })

  it('refuses to mint URLs for an unknown device and an untrusted Host', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    const unknown = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/session',
      host,
      body: JSON.stringify({ deviceId: 'missing' }),
    })
    expect(unknown.status).toBe(404)
    const untrusted = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/session',
      host: 'evil.example',
      body: JSON.stringify({ deviceId: 'emulator-5554' }),
    })
    expect(untrusted.status).toBe(403)
  })

  it('refuses a zero token lifetime at plugin load', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
    context.provide('phoneDevices', {
      listDevices: async () => ({ android: [], ios: { simulators: [], reals: [] } }),
    } as never)
    const pending = context.plugin(PhoneStream, { tokenTtlMs: 0 })
    void Promise.resolve(pending).catch(() => undefined)
    await expect(pending.await()).rejects.toThrow(/tokenTtlMs must be a positive safe integer/)
  })

  it('rejects non-POST session minting and a missing deviceId', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    expect((await rawRequest({ origin, method: 'GET', path: '/phone/session', host })).status).toBe(405)
    expect((await rawRequest({ origin, method: 'POST', path: '/phone/session/extra', host, body: '{}' })).status).toBe(404)
    const missing = await rawRequest({ origin, method: 'POST', path: '/phone/session', host, body: '{}' })
    expect(missing.status).toBe(400)
  })

  it('rejects non-GET capture and an unknown capture path', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    expect((await rawRequest({ origin, method: 'POST', path: '/phone/stream/x/mjpeg', host })).status).toBe(405)
    expect((await rawRequest({ origin, path: '/phone/stream/', host })).status).toBe(404)
    expect((await rawRequest({ origin, path: '/phone/stream/%E0%A4%A/mjpeg', host })).status).toBe(404)
    expect((await rawRequest({ origin, path: '/phone/stream/a%2Fb/mjpeg', host })).status).toBe(404)
    expect((await rawRequest({ origin, path: '/phone/stream/emulator-5554/mjpeg', host })).status).toBe(403)
  })

  it('forwards gesture, text, and button JSON-RPC and reports malformed frames', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}${PHONE_IO_PATH}`, { headers: { host } })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    const next = (): Promise<unknown> => new Promise((resolve) => {
      socket.once('message', (data) => { resolve(parseWebSocketJson(data)) })
    })
    socket.send('not-json')
    expect(await next()).toMatchObject({ error: { code: -32700 } })
    socket.send('null')
    expect(await next()).toMatchObject({ error: { code: -32600 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'swipe', params: { deviceId: 'emulator-5554' } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tap', params: { deviceId: 'emulator-5554', x: 1 } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'gesture', params: { deviceId: 'emulator-5554', actions: [{ type: 'move' }] } }))
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 3, result: { status: 'ok' } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'text', params: { deviceId: 'emulator-5554', text: 'hi' } }))
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 4, result: { status: 'ok' } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'button', params: { deviceId: 'emulator-5554', button: 'HOME' } }))
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 5, result: { status: 'ok' } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'tap', params: { deviceId: 'emulator-5554', x: 1, y: 2 } }))
    expect(await next()).toMatchObject({ jsonrpc: '2.0', result: { status: 'ok' } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tap', params: null }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tap', params: { x: 1, y: 2 } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'gesture', params: { deviceId: 'emulator-5554', actions: 'nope' } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'text', params: { deviceId: 'emulator-5554' } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'button', params: { deviceId: 'emulator-5554', button: '' } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tap', params: { deviceId: 'missing', x: 1, y: 2 } }))
    expect(await next()).toMatchObject({ error: { code: -32010 } })
    socket.close()
  })

  it('answers 502 when capture start fails upstream after a valid token', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    context.phoneDevices.startCapture = async () => {
      throw new Error('capture backend down')
    }
    expect((await rawRequest({ origin, path: session.mjpeg.url, host })).status).toBe(502)
  })

  it('normalizes a non-Error capture failure at the Host boundary', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    context.phoneDevices.startCapture = async () => {
      throw 17
    }
    const response = await rawRequest({ origin, path: session.h264.url, host })
    expect(response.status).toBe(502)
    expect(response.body.toString('utf8')).toContain('17')
  })

  it('normalizes a non-Error IO failure at the WebSocket boundary', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    context.phoneDevices.io = async () => {
      throw 'io failed'
    }
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}${PHONE_IO_PATH}`, { headers: { host } })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    const reply = new Promise<{ error?: { message?: string } }>((resolve) => {
      socket.once('message', (data) => {
        resolve(parseWebSocketJson(data) as { error?: { message?: string } })
      })
    })
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 12,
      method: 'tap',
      params: { deviceId: 'emulator-5554', x: 1, y: 2 },
    }))
    expect((await reply).error?.message).toBe('io failed')
    socket.close()
  })

  it('destroys an untrusted IO upgrade before protocol negotiation', async () => {
    const { origin } = await mount()
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}${PHONE_IO_PATH}`, {
      headers: { host: 'evil.example' },
    })
    const closed = await new Promise<{ code?: number }>((resolve) => {
      socket.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode === undefined ? {} : { code: res.statusCode })
      })
      socket.once('error', () => { resolve({}) })
    })
    expect(closed.code === 403 || closed.code === undefined).toBe(true)
  })
})
