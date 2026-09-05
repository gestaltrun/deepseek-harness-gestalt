import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import PhoneDevices, { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import PhoneStream, { PHONE_IO_PATH } from '../src/index.ts'
import { CaptureGrantLedger } from '../src/capture-grant-ledger.ts'
import { assertRecognizableH264Picture, assertStructurallyDecodableJpeg, jpegDimensions, stageFake, wireDevice } from '../../phone-runtime/tests/helpers.ts'
import { readAndroidLogicalDisplay } from '../../phone-runtime/src/android-display.ts'

vi.mock('../../phone-runtime/src/android-display.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../phone-runtime/src/android-display.ts')>()
  return {
    ...actual,
    readAndroidLogicalDisplay: vi.fn(() => undefined),
  }
})

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const ANDROID = deviceId('emulator-5554')

function parseWebSocketJson(data: RawData): unknown {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(data))
      : data
  return JSON.parse(bytes.toString('utf8')) as unknown
}

const contexts: Context[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  vi.mocked(readAndroidLogicalDisplay).mockReturnValue(undefined)
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

async function mount(
  devices: Array<Record<string, unknown>> = [wireDevice('emulator-5554', 'android', 'emulator', 'online')],
  fakeKnobs: Record<string, unknown> = {},
): Promise<{ context: Context; origin: string; phoneStreamFiber: Fiber }> {
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
  const phoneStreamFiber = context.plugin(PhoneStream, {})
  await phoneStreamFiber.await()
  return { context, origin: `http://127.0.0.1:${String(context.webServer.port)}`, phoneStreamFiber }
}

async function mint(origin: string, id = 'emulator-5554'): Promise<{
  ioPath: string
  preferredFormat: 'h264' | 'mjpeg'
  mjpeg: { url: string; captureId: string; expiresAt: number }
  h264: { url: string; captureId: string; expiresAt: number }
}> {
  const response = await fetch(`${origin}/phone/session`, {
    method: 'POST',
    headers: { host: new URL(origin).host, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: id }),
  })
  expect(response.status).toBe(200)
  return await response.json() as {
    ioPath: string
    preferredFormat: 'h264' | 'mjpeg'
    mjpeg: { url: string; captureId: string; expiresAt: number }
    h264: { url: string; captureId: string; expiresAt: number }
  }
}

async function openCapture(origin: string, url: string): Promise<Response> {
  const response = await fetch(`${origin}${url}`, { headers: { host: new URL(origin).host } })
  expect(response.status).toBe(200)
  return response
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
  it('rolls back earlier route registrations when upgrade registration fails', async () => {
    const context = new Context(); contexts.push(context)
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
    const fake = await stageFake({ devices: [wireDevice('emulator-5554', 'android', 'emulator', 'online')] }); fakes.push(fake)
    await fake.claim()
    await context.plugin(PhoneDevices, {
      executablePath: fake.executablePath,
      serverPort: fake.port,
      pollIntervalMs: 20,
      readyTimeoutMs: 6_000,
      requestTimeoutMs: 1_500,
      bootTimeoutMs: 2_000,
    }).await()
    const disposeCollision = context.webServer.registerUpgrade({ path: PHONE_IO_PATH, handler: () => {} })
    await expect(context.plugin(PhoneStream, {})).rejects.toThrow('duplicate upgrade route')
    const origin = `http://127.0.0.1:${String(context.webServer.port)}`; const host = new URL(origin).host
    for (const path of ['/phone/session', '/phone/agent', '/phone/devices', '/phone/stream/x/h264']) {
      expect((await rawRequest({ origin, path, host })).status).toBe(404)
    }
    disposeCollision()
  })
  it('prefers MJPEG only for the iOS simulator that mobilecli cannot encode as AVC', async () => {
    const { origin, context } = await mount([
      wireDevice('android-real', 'android', 'real', 'online'),
      wireDevice('ios-simulator', 'ios', 'simulator', 'online'),
      wireDevice('ios-real', 'ios', 'real', 'online'),
    ])
    context.phoneDevices.agentStatus = async id => ({ deviceId: id, installed: true })
    const installAgent = vi.fn()
    context.phoneDevices.installAgent = installAgent

    expect(await mint(origin, 'android-real')).toMatchObject({ preferredFormat: 'h264', agentManaged: true })
    expect((await mint(origin, 'ios-real')).preferredFormat).toBe('h264')
    expect((await mint(origin, 'ios-simulator')).preferredFormat).toBe('mjpeg')
    expect(installAgent).not.toHaveBeenCalled()
  })

  it('installs a missing iOS real-device agent during mint and answers a picture session', async () => {
    const { origin, context } = await mount([
      wireDevice('UDID-9', 'ios', 'real', 'online'),
    ])
    const host = new URL(origin).host
    let installed = false
    const installAgent = vi.fn(async (id: ReturnType<typeof deviceId>, options?: { force?: boolean }) => {
      installed = true
      return { deviceId: id, installed: true, reinstalled: options?.force === true }
    })
    context.phoneDevices.agentStatus = async id => ({ deviceId: id, installed })
    context.phoneDevices.installAgent = installAgent

    const response = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/session',
      host,
      body: JSON.stringify({ deviceId: 'UDID-9' }),
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({
      deviceId: 'UDID-9',
      agentManaged: true,
      preferredFormat: 'h264',
    })
    expect(installAgent).toHaveBeenCalledTimes(1)
    expect(installAgent.mock.calls[0]?.[0]).toBe(deviceId('UDID-9'))
    expect(installAgent.mock.calls[0]?.[1]?.force).not.toBe(true)
  })

  it('keeps mint install failures on their existing error codes', async () => {
    const cases: readonly {
      readonly name: string
      readonly error: PhoneDevicesError
      readonly status: number
      readonly body: object
    }[] = [
      {
        name: 'missing provisioning profile',
        error: new PhoneDevicesError(
          'PHONE_AGENT_PROFILE_REQUIRED',
          'configure provisioningProfilePath before installing the iOS real-device control agent',
        ),
        status: 409,
        body: {
          error: {
            code: 'PHONE_AGENT_PROFILE_REQUIRED',
            message: 'configure provisioningProfilePath before installing the iOS real-device control agent',
          },
        },
      },
      {
        name: 'device locked',
        error: new PhoneDevicesError('PHONE_REAL_DEVICE_ISSUE', 'unlock the device', { issue: 'device-locked' }),
        status: 502,
        body: { error: { code: 'PHONE_REAL_DEVICE_ISSUE', issue: 'device-locked', message: 'unlock the device' } },
      },
      {
        name: 'certificate untrusted',
        error: new PhoneDevicesError(
          'PHONE_REAL_DEVICE_ISSUE',
          'the signing certificate is not trusted',
          { issue: 'cert-untrusted' },
        ),
        status: 502,
        body: {
          error: {
            code: 'PHONE_REAL_DEVICE_ISSUE',
            issue: 'cert-untrusted',
            message: 'the signing certificate is not trusted',
          },
        },
      },
      {
        name: 'profile expired',
        error: new PhoneDevicesError(
          'PHONE_REAL_DEVICE_ISSUE',
          'the provisioning profile has expired',
          { issue: 'profile-expired' },
        ),
        status: 502,
        body: {
          error: {
            code: 'PHONE_REAL_DEVICE_ISSUE',
            issue: 'profile-expired',
            message: 'the provisioning profile has expired',
          },
        },
      },
      {
        name: 'user-restricted install',
        error: new PhoneDevicesError(
          'PHONE_UPSTREAM',
          'adb install failed: INSTALL_FAILED_USER_RESTRICTED',
        ),
        status: 502,
        body: {
          error: {
            code: 'PHONE_UPSTREAM',
            message: 'adb install failed: INSTALL_FAILED_USER_RESTRICTED',
          },
        },
      },
    ]
    for (const testCase of cases) {
      const { origin, context } = await mount([
        wireDevice('UDID-9', 'ios', 'real', 'online'),
      ])
      const host = new URL(origin).host
      context.phoneDevices.agentStatus = async id => ({ deviceId: id, installed: false })
      context.phoneDevices.installAgent = async () => {
        throw testCase.error
      }

      const response = await rawRequest({
        origin,
        method: 'POST',
        path: '/phone/session',
        host,
        body: JSON.stringify({ deviceId: 'UDID-9' }),
      })

      expect({ name: testCase.name, status: response.status }).toEqual({
        name: testCase.name, status: testCase.status,
      })
      expect({ name: testCase.name, body: JSON.parse(response.body.toString('utf8')) }).toEqual({
        name: testCase.name, body: testCase.body,
      })
    }
  })

  it('answers PHONE_AGENT_MISSING when mint install still leaves the iOS real agent absent', async () => {
    const { origin, context } = await mount([
      wireDevice('UDID-9', 'ios', 'real', 'online'),
    ])
    const host = new URL(origin).host
    const installAgent = vi.fn(async (id: ReturnType<typeof deviceId>) => ({
      deviceId: id, installed: false, reinstalled: false,
    }))
    context.phoneDevices.agentStatus = async id => ({ deviceId: id, installed: false })
    context.phoneDevices.installAgent = installAgent

    const response = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/session',
      host,
      body: JSON.stringify({ deviceId: 'UDID-9' }),
    })

    expect(response.status).toBe(409)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      error: {
        code: 'PHONE_AGENT_MISSING',
        message: 'the iOS real-device control agent is not installed',
      },
    })
    expect(installAgent).toHaveBeenCalledTimes(1)
  })

  it('does not install an agent when minting an iOS simulator session', async () => {
    const { origin, context } = await mount([
      wireDevice('SIM-9', 'ios', 'simulator', 'online'),
    ])
    const host = new URL(origin).host
    const agentStatus = vi.fn(async (id: ReturnType<typeof deviceId>) => ({ deviceId: id, installed: false }))
    const installAgent = vi.fn(async (id: ReturnType<typeof deviceId>) => ({
      deviceId: id, installed: true, reinstalled: false,
    }))
    context.phoneDevices.agentStatus = agentStatus
    context.phoneDevices.installAgent = installAgent

    const response = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/session',
      host,
      body: JSON.stringify({ deviceId: 'SIM-9' }),
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({
      deviceId: 'SIM-9',
      agentManaged: false,
      preferredFormat: 'mjpeg',
    })
    expect(agentStatus).not.toHaveBeenCalled()
    expect(installAgent).not.toHaveBeenCalled()
  })

  it('preserves the structured real-device issue on agent status and install failures', async () => {
    const { origin, context } = await mount([
      wireDevice('UDID-9', 'ios', 'real', 'online'),
    ])
    const host = new URL(origin).host
    context.phoneDevices.agentStatus = async () => {
      throw new PhoneDevicesError(
        'PHONE_REAL_DEVICE_ISSUE',
        'the signing certificate is not trusted',
        { issue: 'cert-untrusted' },
      )
    }

    const status = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/agent/status',
      host,
      body: JSON.stringify({ deviceId: 'UDID-9' }),
    })
    expect(status.status).toBe(502)
    expect(JSON.parse(status.body.toString('utf8'))).toEqual({
      error: {
        code: 'PHONE_REAL_DEVICE_ISSUE',
        issue: 'cert-untrusted',
        message: 'the signing certificate is not trusted',
      },
    })

    context.phoneDevices.installAgent = async () => {
      throw new PhoneDevicesError(
        'PHONE_REAL_DEVICE_ISSUE',
        'the provisioning profile has expired',
        { issue: 'profile-expired' },
      )
    }
    const install = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/agent/install',
      host,
      body: JSON.stringify({ deviceId: 'UDID-9', force: true }),
    })
    expect(install.status).toBe(502)
    expect(JSON.parse(install.body.toString('utf8'))).toMatchObject({
      error: { code: 'PHONE_REAL_DEVICE_ISSUE', issue: 'profile-expired' },
    })
  })

  it('projects a missing provisioning profile as an actionable agent prerequisite', async () => {
    const { origin, context } = await mount([
      wireDevice('UDID-9', 'ios', 'real', 'online'),
    ])
    const host = new URL(origin).host
    context.phoneDevices.installAgent = async () => {
      throw new PhoneDevicesError(
        'PHONE_AGENT_PROFILE_REQUIRED',
        'configure a provisioning profile before installing the iOS real-device control agent',
      )
    }

    const response = await rawRequest({
      origin,
      method: 'POST',
      path: '/phone/agent/install',
      host,
      body: JSON.stringify({ deviceId: 'UDID-9', force: false }),
    })

    expect(response.status).toBe(409)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      error: {
        code: 'PHONE_AGENT_PROFILE_REQUIRED',
        message: 'configure a provisioning profile before installing the iOS real-device control agent',
      },
    })
  })

  it('serves managed Android and iOS real-device agent operations only on trusted exact POST routes', async () => {
    const { origin, context } = await mount([
      wireDevice('android-real', 'android', 'real', 'online'),
      wireDevice('UDID-9', 'ios', 'real', 'online'),
      wireDevice('SIM-9', 'ios', 'simulator', 'online'),
    ])
    const host = new URL(origin).host
    context.phoneDevices.agentStatus = async id => ({ deviceId: id, installed: true, version: '0.0.25' })
    context.phoneDevices.installAgent = async (id, options) => ({
      deviceId: id, installed: true, reinstalled: options?.force === true,
    })

    const session = await rawRequest({
      origin, method: 'POST', path: '/phone/session', host, body: JSON.stringify({ deviceId: 'UDID-9' }),
    })
    expect(session.status).toBe(200)
    expect(JSON.parse(session.body.toString('utf8'))).toMatchObject({ agentManaged: true })

    const status = await rawRequest({
      origin, method: 'POST', path: '/phone/agent/status', host, body: JSON.stringify({ deviceId: 'UDID-9' }),
    })
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body.toString('utf8'))).toMatchObject({ installed: true, version: '0.0.25' })
    const install = await rawRequest({
      origin, method: 'POST', path: '/phone/agent/install', host,
      body: JSON.stringify({ deviceId: 'UDID-9', force: true }),
    })
    expect(JSON.parse(install.body.toString('utf8'))).toMatchObject({ installed: true, reinstalled: true })

    const androidStatus = await rawRequest({
      origin, method: 'POST', path: '/phone/agent/status', host,
      body: JSON.stringify({ deviceId: 'android-real' }),
    })
    expect(androidStatus.status).toBe(200)
    expect(JSON.parse(androidStatus.body.toString('utf8'))).toMatchObject({ installed: true })

    expect((await rawRequest({
      origin, method: 'POST', path: '/phone/agent/status', host: 'evil.example', body: '{}',
    })).status).toBe(403)
    expect((await rawRequest({ origin, method: 'GET', path: '/phone/agent/status', host })).status).toBe(405)
    expect((await rawRequest({ origin, method: 'POST', path: '/phone/agent/unknown', host, body: '{}' })).status).toBe(404)
    expect((await rawRequest({ origin, method: 'POST', path: '/phone/agent/status', host, body: '{}' })).status).toBe(400)
    expect((await rawRequest({
      origin, method: 'POST', path: '/phone/agent/install', host,
      body: JSON.stringify({ deviceId: 'UDID-9', force: 'yes' }),
    })).status).toBe(400)
    expect((await rawRequest({
      origin, method: 'POST', path: '/phone/agent/status', host,
      body: JSON.stringify({ deviceId: 'SIM-9' }),
    })).status).toBe(400)
    expect((await rawRequest({
      origin, method: 'POST', path: '/phone/agent/status', host,
      body: JSON.stringify({ deviceId: 'MISSING' }),
    })).status).toBe(404)
  })

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

  it('forwards Android logicalDisplay on the listing wire', async () => {
    vi.mocked(readAndroidLogicalDisplay).mockImplementation(options => (
      options.deviceId === 'emulator-5554' ? { width: 2248, height: 1080 } : undefined
    ))
    const { origin } = await mount([
      wireDevice('emulator-5554', 'android', 'emulator', 'online'),
    ])
    const host = new URL(origin).host
    const response = await rawRequest({ origin, path: '/phone/devices', host })
    expect(JSON.parse(response.body.toString('utf8')).android[0]).toMatchObject({
      id: 'emulator-5554',
      logicalDisplay: { width: 2248, height: 1080 },
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

  it('mints four unique capture identities even when the clock does not move', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const { origin } = await mount()
      const first = await mint(origin)
      const second = await mint(origin)
      const ids = [first.mjpeg.captureId, first.h264.captureId, second.mjpeg.captureId, second.h264.captureId]
      expect(new Set(ids).size).toBe(4)
      expect(new Set([first.mjpeg.url, first.h264.url, second.mjpeg.url, second.h264.url]).size).toBe(4)
    } finally {
      now.mockRestore()
    }
  })

  it('consumes an exact signed capture URL once under concurrent replay', async () => {
    const { origin, context } = await mount()
    const session = await mint(origin)
    const host = new URL(origin).host
    let starts = 0
    context.phoneDevices.startCapture = async () => {
      starts += 1
      return { contentType: 'video/h264', body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)) } }) }
    }
    const [first, second] = await Promise.all([
      fetch(`${origin}${session.h264.url}`, { headers: { host } }),
      fetch(`${origin}${session.h264.url}`, { headers: { host } }),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 403])
    expect(starts).toBe(1)
    await first.body?.cancel()
    await second.body?.cancel()
  })

  it('cancels a delayed capture start when the request closes before headers', async () => {
    const { origin, context } = await mount()
    const session = await mint(origin)
    const host = new URL(origin).host
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    let startEntered!: () => void
    const entered = new Promise<void>((resolve) => { startEntered = resolve })
    let cancelled = 0
    let starts = 0
    context.phoneDevices.startCapture = async () => {
      starts += 1
      startEntered()
      await startGate
      return { contentType: 'video/h264', body: new ReadableStream({ cancel() { cancelled += 1 } }) }
    }
    const abort = new AbortController()
    const request = fetch(`${origin}${session.h264.url}`, { headers: { host }, signal: abort.signal })
    await entered
    abort.abort()
    releaseStart()
    await request.catch(() => {})
    await vi.waitFor(() => { expect(cancelled).toBe(1) })
    expect((await rawRequest({ origin, path: session.h264.url, host })).status).toBe(403)
    expect(starts).toBe(1)
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

  it('awaits and reports rejected upstream cancellation after a browser disconnect', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    const cancellationStarted = Promise.withResolvers<undefined>()
    const cancellationRelease = Promise.withResolvers<undefined>()
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
    context.phoneDevices.startCapture = async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x00, 0x00, 0x00, 0x01]))
        },
        async cancel() {
          cancellationStarted.resolve(undefined)
          await cancellationRelease.promise
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
    await cancellationStarted.promise
    expect(warn).not.toHaveBeenCalled()
    cancellationRelease.reject(new Error('capture cancellation failed'))
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'capture cancellation failed' }))
    })
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
    const { origin } = await mount(undefined, { streamFrameCount: 20 })
    const host = new URL(origin).host
    const session = await mint(origin)
    expect(session.ioPath).toBe(PHONE_IO_PATH)
    const capture = await openCapture(origin, session.mjpeg.url)
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
      params: {
        deviceId: ANDROID, x: 9, y: 10, kind: 'capture', captureWidth: 100, captureHeight: 200,
        captureId: session.mjpeg.captureId, captureFormat: 'mjpeg',
      },
    }))
    expect(await reply).toEqual({ jsonrpc: '2.0', id: 7, result: { status: 'ok' } })
    socket.close()
    await capture.body?.cancel()
  })

  it('forwards live capture size from a tap frame onto Host io', async () => {
    const { origin, context } = await mount(undefined, { streamFrameCount: 20 })
    const host = new URL(origin).host
    const session = await mint(origin)
    const capture = await openCapture(origin, session.mjpeg.url)
    const seen: unknown[] = []
    const original = context.phoneDevices.io.bind(context.phoneDevices)
    context.phoneDevices.io = async (request, signal) => {
      seen.push(request)
      return original(request, signal)
    }
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
      id: 8,
      method: 'tap',
      params: {
        deviceId: ANDROID, x: 99, y: 660, kind: 'capture', captureWidth: 2_868, captureHeight: 1_320,
        captureId: session.mjpeg.captureId, captureFormat: 'mjpeg',
      },
    }))
    expect(await reply).toEqual({ jsonrpc: '2.0', id: 8, result: { status: 'ok' } })
    expect(seen).toEqual([{
      deviceId: ANDROID, method: 'tap', x: 99, y: 660,
      source: {
        kind: 'capture', captureWidth: 2_868, captureHeight: 1_320,
        captureId: session.mjpeg.captureId, captureFormat: 'mjpeg',
      },
    }])
    socket.close()
    await capture.body?.cancel()
  })

  it('revokes one capture before gated cancellation settles and leaves a parallel capture active', async () => {
    const { origin, context } = await mount(undefined, { streamFrameCount: 20 })
    const host = new URL(origin).host
    const session = await mint(origin)
    let releaseFirst!: () => void
    const firstCancelled = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstCancelEntered!: () => void
    const cancelEntered = new Promise<void>((resolve) => { firstCancelEntered = resolve })
    const originalStart = context.phoneDevices.startCapture.bind(context.phoneDevices)
    let underlyingCancellation: Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> | undefined
    let releasePull!: () => void
    const pullGate = new Promise<void>((resolve) => { releasePull = resolve })
    let enterPull!: () => void
    const pullEntered = new Promise<void>((resolve) => { enterPull = resolve })
    let captures = 0
    context.phoneDevices.startCapture = async (request) => {
      captures += 1
      const capture = await originalStart(request)
      if (captures !== 1) {
        return {
          ...capture,
          body: new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(Uint8Array.of(2)) },
            pull() { return new Promise(() => {}) },
            async cancel(reason) { await capture.body.cancel(reason) },
          }, { highWaterMark: 0 }),
        }
      }
      let pulls = 0
      return {
        ...capture,
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            pulls += 1
            if (pulls === 1) { controller.enqueue(Uint8Array.of(1)); return }
            enterPull()
            await pullGate
          },
          async cancel(reason) {
            underlyingCancellation = Promise.resolve(capture.body.cancel(reason)).then(
              () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }),
            )
            firstCancelEntered()
            releasePull()
            await firstCancelled
            const outcome = await underlyingCancellation
            if (!outcome.ok) throw outcome.error
          },
        }, { highWaterMark: 0 }),
      }
    }
    const firstAbort = new AbortController()
    const firstRequest = fetch(`${origin}${session.h264.url}`, { headers: { host }, signal: firstAbort.signal })
      .then(response => ({ ok: true as const, response }), (error: unknown) => ({ ok: false as const, error }))
    await vi.waitFor(() => { expect(captures).toBe(1) })
    await pullEntered
    const secondSession = await mint(origin)
    const second = await openCapture(origin, secondSession.h264.url)
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}${PHONE_IO_PATH}`, { headers: { host } })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const send = async (captureId: string): Promise<unknown> => {
      const reply = new Promise((resolve) => {
        socket.once('message', (data) => { resolve(parseWebSocketJson(data)) })
      })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tap', params: {
        deviceId: ANDROID, x: 1, y: 2, kind: 'capture', captureWidth: 100, captureHeight: 200,
        captureId, captureFormat: 'h264', captureRotation: 0,
      } }))
      return await reply
    }
    firstAbort.abort()
    await cancelEntered
    await expect(send(session.h264.captureId)).resolves.toMatchObject({ error: { code: -32000 } })
    await expect(send(secondSession.h264.captureId)).resolves.toMatchObject({ result: { status: 'ok' } })
    releaseFirst()
    await firstRequest
    await underlyingCancellation
    await second.body?.cancel()
    socket.close()
  })

  it('rejects missing, forged, stale, cross-device, and wrong-format capture evidence', async () => {
    const { origin, context } = await mount([
      wireDevice('emulator-5554', 'android', 'emulator', 'online'),
      wireDevice('emulator-5556', 'android', 'emulator', 'online'),
    ])
    const host = new URL(origin).host
    const session = await mint(origin)
    context.phoneDevices.startCapture = async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1)) } }),
    })
    const capture = await openCapture(origin, session.h264.url)
    const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}${PHONE_IO_PATH}`, { headers: { host } })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const send = async (params: Record<string, unknown>): Promise<unknown> => {
      const reply = new Promise((resolve) => {
        socket.once('message', (data) => { resolve(parseWebSocketJson(data)) })
      })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tap', params: { x: 1, y: 2, captureWidth: 100, captureHeight: 200, captureRotation: 0, ...params } }))
      return await reply
    }
    for (const params of [
      { deviceId: ANDROID },
      { deviceId: ANDROID, captureId: `${session.h264.captureId}x`, captureFormat: 'h264' },
      { deviceId: 'emulator-5556', captureId: session.h264.captureId, captureFormat: 'h264' },
      { deviceId: ANDROID, captureId: session.h264.captureId, captureFormat: 'mjpeg' },
    ]) expect(await send(params)).toMatchObject({ error: { code: -32000 } })
    await capture.body?.cancel()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await send({ deviceId: ANDROID, captureId: session.h264.captureId, captureFormat: 'h264' }))
      .toMatchObject({ error: { code: -32000 } })
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

  it('refuses an unsafe absolute token expiry at session mint', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)
    try {
      const { context } = await mount()
      expect(() => context.phoneStream.sessionFor(ANDROID)).toThrow('capture token expiry exceeds the safe integer range')
    } finally {
      now.mockRestore()
    }
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

  it('forwards semantic swipe, text, and button JSON-RPC and rejects old gesture frames', async () => {
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
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 13, method: 42, params: { deviceId: 'emulator-5554' } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tap', params: { deviceId: 'emulator-5554', x: 1 } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({
      jsonrpc: '2.0', id: 14, method: 'tap',
      params: { deviceId: 'emulator-5554', x: 1, y: 2, captureWidth: 2_868 },
    }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'swipe',
      params: { deviceId: 'emulator-5554', x1: 1, y1: 2, x2: 3, y2: 4 },
    }))
    expect(await next()).toMatchObject({ jsonrpc: '2.0', id: 3, error: { code: -32000 } })
    socket.send(JSON.stringify({
      jsonrpc: '2.0', id: 15, method: 'gesture',
      params: { deviceId: 'emulator-5554', actions: [{ type: 'move' }] },
    }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'text', params: { deviceId: 'emulator-5554', text: 'hi' } }))
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 4, result: { status: 'ok' } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'button', params: { deviceId: 'emulator-5554', button: 'HOME' } }))
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 5, result: { status: 'ok' } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'tap', params: { deviceId: 'emulator-5554', x: 1, y: 2 } }))
    expect(await next()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tap', params: null }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tap', params: { x: 1, y: 2 } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'swipe',
      params: { deviceId: 'emulator-5554', x1: 1, y1: 2, x2: 'nope', y2: 4 },
    }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'text', params: { deviceId: 'emulator-5554' } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'button', params: { deviceId: 'emulator-5554', button: '' } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tap', params: { deviceId: 'missing', x: 1, y: 2 } }))
    expect(await next()).toMatchObject({ error: { code: -32000 } })
    socket.close()
  })

  it('prevents iOS real session install and mint after an admitted status crosses disposal', async () => {
    const { origin, context, phoneStreamFiber } = await mount([wireDevice('ios-real', 'ios', 'real', 'online')])
    let release!: () => void; let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const admission = new Promise<void>((resolve) => { entered = resolve })
    context.phoneDevices.agentStatus = async () => { entered(); await gate; throw new Error('late status failure') }
    const install = vi.fn(async (id: ReturnType<typeof deviceId> = deviceId('ios-real')) => ({
      deviceId: id,
      installed: true,
      reinstalled: false,
    }))
    context.phoneDevices.installAgent = install
    const request = fetch(`${origin}/phone/session`, { method: 'POST', headers: { host: new URL(origin).host, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'ios-real' }) })
    await admission; const disposal = phoneStreamFiber.dispose()
    expect((await rawRequest({ origin, path: '/phone/devices', host: new URL(origin).host })).status).toBe(503)
    release(); const response = await request; expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('/phone/stream/')
    expect(install).not.toHaveBeenCalled(); await disposal
    expect((await rawRequest({ origin, path: '/phone/session', host: new URL(origin).host, method: 'POST' })).status).toBe(404)
  })

  it('prevents agent install after managed-device listing crosses disposal', async () => {
    const { origin, context, phoneStreamFiber } = await mount()
    const original = context.phoneDevices.listDevices.bind(context.phoneDevices); let release!: () => void; let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const admission = new Promise<void>((resolve) => { entered = resolve })
    context.phoneDevices.listDevices = async () => { entered(); await gate; return await original() }
    const install = vi.fn(async () => ({} as never)); context.phoneDevices.installAgent = install
    const request = fetch(`${origin}/phone/agent/install`, { method: 'POST', headers: { host: new URL(origin).host, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'emulator-5554' }) })
    await admission; const disposal = phoneStreamFiber.dispose(); release(); const response = await request
    expect(response.status).toBe(503); expect(install).not.toHaveBeenCalled(); await disposal
    expect((await rawRequest({ origin, path: '/phone/agent/install', host: new URL(origin).host, method: 'POST' })).status).toBe(404)
  })

  it('prevents a device listing commit after its acquisition crosses disposal', async () => {
    const { origin, context, phoneStreamFiber } = await mount()
    const original = context.phoneDevices.listDevices.bind(context.phoneDevices)
    let release!: () => void; let entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve })
    const admission = new Promise<void>((resolve) => { entered = resolve })
    context.phoneDevices.listDevices = async () => { entered(); await gate; return await original() }
    const request = fetch(`${origin}/phone/devices`, { headers: { host: new URL(origin).host } }); await admission
    const disposal = phoneStreamFiber.dispose(); release(); const response = await request
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('emulator-5554'); await disposal
    expect((await rawRequest({ origin, path: '/phone/devices', host: new URL(origin).host })).status).toBe(404)
  })

  it('spends but never starts capture when disposal wins after grant consumption', async () => {
    const { origin, context, phoneStreamFiber } = await mount(); const session = await mint(origin); const host = new URL(origin).host
    const start = vi.fn(context.phoneDevices.startCapture.bind(context.phoneDevices)); context.phoneDevices.startCapture = start
    const ledger = CaptureGrantLedger.prototype
    const original = Reflect.get(ledger, 'consume')
    const consume = vi.spyOn(ledger, 'consume')
    let disposal!: Promise<void>; let triggered = false
    consume.mockImplementation(function (this: CaptureGrantLedger, ...args) {
      const result = original.apply(this, args)
      if (!triggered) { triggered = true; disposal = phoneStreamFiber.dispose() }
      return result
    })
    try {
      const response = await rawRequest({ origin, path: session.h264.url, host })
      expect(response.status).not.toBe(200); expect(start).not.toHaveBeenCalled()
      expect((await rawRequest({ origin, path: session.h264.url, host })).status).not.toBe(200)
      await disposal
      expect((await rawRequest({ origin, path: session.h264.url, host })).status).not.toBe(200)
    } finally {
      consume.mockRestore()
    }
  })

  it('refuses in-process session minting after the synchronous owner fence', async () => {
    const { context, phoneStreamFiber } = await mount()
    const disposal = phoneStreamFiber.dispose()
    expect(() => context.phoneStream.sessionFor(ANDROID)).toThrow(expect.objectContaining({ code: 'PHONE_ABORTED' }))
    await disposal
  })

  it('fences every admission synchronously when the public plugin fiber begins disposal', async () => {
    const { origin, phoneStreamFiber } = await mount()
    const host = new URL(origin).host
    const disposal = phoneStreamFiber.dispose()
    const paths = ['/phone/session', '/phone/agent/status', '/phone/devices', '/phone/stream/emulator-5554/h264?token=x']
    const responses = await Promise.all(paths.map(path => rawRequest({ origin, path, host, method: path === '/phone/session' ? 'POST' : 'GET' })))
    expect(responses.every(response => response.status !== 200)).toBe(true)
    await disposal
    await expect(fetch(`${origin}/phone/devices`, { headers: { host } })).resolves.toMatchObject({ status: 404 })
  })

  it('answers 502 when capture start fails upstream after a valid token', async () => {
    const { origin, context } = await mount()
    const host = new URL(origin).host
    const session = await mint(origin)
    let starts = 0
    context.phoneDevices.startCapture = async () => {
      starts += 1
      throw new Error('capture backend down')
    }
    expect((await rawRequest({ origin, path: session.mjpeg.url, host })).status).toBe(502)
    expect((await rawRequest({ origin, path: session.mjpeg.url, host })).status).toBe(403)
    expect(starts).toBe(1)
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
    const session = await mint(origin)
    context.phoneDevices.startCapture = async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1)) } }),
    })
    const capture = await openCapture(origin, session.h264.url)
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
      params: {
        deviceId: 'emulator-5554', x: 1, y: 2, kind: 'capture', captureWidth: 100, captureHeight: 200,
        captureId: session.h264.captureId, captureFormat: 'h264', captureRotation: 0,
      },
    }))
    expect((await reply).error?.message).toBe('io failed')
    socket.close()
    await capture.body?.cancel()
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
