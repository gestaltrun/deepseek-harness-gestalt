import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import WebSocket from 'ws'
import PhoneStream, { PHONE_IO_PATH } from '../src/index.ts'
import { stageFake, wireDevice } from '../../phone-runtime/tests/helpers.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const ANDROID = deviceId('emulator-5554')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const H264 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42])

const contexts: Context[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

async function mount(): Promise<{ context: Context; origin: string }> {
  const fake = await stageFake({
    devices: [wireDevice('emulator-5554', 'android', 'emulator', 'online')],
  })
  fakes.push(fake)
  fake.claim()
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
          contentType: String(res.headers['content-type'] ?? ''),
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

async function readPrefix(origin: string, path: string, host: string): Promise<{
  status: number
  contentType: string
  body: Buffer
}> {
  const url = new URL(origin)
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      method: 'GET',
      path,
      headers: { host },
    }, (res) => {
      res.once('data', (chunk: Buffer) => {
        req.destroy()
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body: chunk,
        })
      })
      res.once('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body: Buffer.alloc(0),
        })
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
    const mjpeg = await readPrefix(origin, session.mjpeg.url, host)
    expect(mjpeg.status).toBe(200)
    expect(mjpeg.contentType).toMatch(/multipart\/x-mixed-replace/)
    expect(mjpeg.body.includes(JPEG)).toBe(true)
    const h264 = await readPrefix(origin, session.h264.url, host)
    expect(h264.status).toBe(200)
    expect(h264.contentType).toMatch(/video\/h264/)
    expect(h264.body.subarray(0, 4).equals(H264.subarray(0, 4))).toBe(true)
  })

  it('cancels the upstream capture when the browser disconnects mid-stream', async () => {
    const { origin } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    await readPrefix(origin, session.mjpeg.url, host)
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
      socket.once('message', (data) => { resolve(JSON.parse(String(data))) })
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
      socket.once('message', (data) => { resolve(JSON.parse(String(data))) })
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
