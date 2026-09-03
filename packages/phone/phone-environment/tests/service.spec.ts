import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { deviceId, type DeviceId } from '@deepseek-ai/dsh-phone-runtime'
import PhoneEnvironment, {
  PHONE_ENVIRONMENT_ANDROID_CANCEL_PATH, PHONE_ENVIRONMENT_ANDROID_START_PATH,
  PHONE_ENVIRONMENT_PATH, PhoneEnvironmentError,
} from '../src/index.ts'
import type { AndroidEnvironmentProvider, AndroidPreparationPlan, PhoneAndroidState } from '../src/index.ts'
import type { MobilecliReleaseAsset } from '../src/types.ts'

class TestPhoneEnvironment extends PhoneEnvironment {
  protected override readonly probeRuntimeVersion = async (executablePath: string): Promise<string> => {
    try {
      await access(executablePath)
      return '1.0.5'
    } catch (error) {
      throw new PhoneEnvironmentError('PHONE_ENVIRONMENT_VERSION', 'mobilecli version probe failed', { cause: error })
    }
  }
}

let controlledAsset: unknown
let controlledProbe: ((executablePath: string, signal: AbortSignal) => Promise<string>) | undefined

class ControlledPhoneEnvironment extends PhoneEnvironment {
  protected override selectManagedAsset(): MobilecliReleaseAsset {
    if (controlledAsset instanceof Error || typeof controlledAsset === 'string') throw controlledAsset
    return controlledAsset as MobilecliReleaseAsset
  }

  protected override readonly probeRuntimeVersion = async (
    executablePath: string, signal?: AbortSignal,
  ): Promise<string> => {
    if (controlledProbe !== undefined) {
      if (signal === undefined) throw new Error('controlled version probe requires an operation signal')
      return await controlledProbe(executablePath, signal)
    }
    await access(executablePath)
    return '1.0.5'
  }
}

const contexts: Context[] = []
const roots: string[] = []
const ANDROID_PLAN: AndroidPreparationPlan = {
  sdkRoot: '/managed/android/sdk', sdkSource: 'managed', avdHome: '/managed/android/avd',
  avdName: 'Pixel_6_API_35_Gestalt', abi: 'arm64-v8a', commandLineToolsVersion: '15859902',
  commandLineToolsBytes: 1, packageIds: ['platform-tools', 'emulator', 'system-image'],
  minimumFreeBytes: 16 * 1024 ** 3, licenseUrl: 'https://developer.android.com/studio/terms',
  components: { commandLineTools: true, platformTools: true, emulator: true, systemImage: true, avd: true },
}
const H264_PICTURE = Uint8Array.from([
  0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x06, 0x41, 0xaf, 0x9a, 0xd0,
  0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80,
  0, 0, 0, 1, 0x65, 0x88, 0x84, 0x86, 0x80, 0xff, 0xff, 0xff, 0xff,
  0, 0, 1, 0x09, 0xf0,
])
const servers: Server[] = []

async function rawGet(url: string, host: string): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const req = request(url, { headers: { host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolveResponse({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
      })
    })
    req.on('error', rejectResponse)
    req.end()
  })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolveClose) => {
    server.close(() => { resolveClose() })
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  controlledAsset = undefined
  controlledProbe = undefined
  vi.unstubAllEnvs()
})

async function executable(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-service-'))
  roots.push(root)
  const path = join(root, 'mobilecli')
  await writeFile(path, '#!/bin/sh\necho "mobilecli version 1.0.5"\n')
  await chmod(path, 0o700)
  return path
}

function isolateSystemMobilecliSearch(): void {
  vi.stubEnv('PATH', '')
  vi.stubEnv('HOME', '')
  vi.stubEnv('USERPROFILE', '')
  vi.stubEnv('npm_config_prefix', '')
}

async function mountEnvironment(
  context: Context,
  phoneDevices: object = {},
  config: { root?: string; executablePath?: string } = {},
  Plugin: typeof PhoneEnvironment = TestPhoneEnvironment,
) {
  const fleet = {
    isReady: () => false,
    onReadinessChanged: () => () => {},
    activateExecutable: async () => {},
    deactivate: async () => {},
    ...phoneDevices,
  }
  context.provide('phoneDevices', fleet as never)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const fiber = context.plugin(Plugin, config)
  await fiber.await()
  const service = context.get('phoneEnvironment')
  if (service === undefined) throw new Error('phoneEnvironment did not activate')
  return {
    fiber,
    service,
    origin: `http://127.0.0.1:${String(context.webServer.port)}`,
  }
}

function runningAndroidProvider() {
  let state: PhoneAndroidState = { kind: 'ready', plan: ANDROID_PLAN, running: false }
  const listeners = new Set<(value: PhoneAndroidState) => void>()
  const emit = (next: PhoneAndroidState): void => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const deactivate = vi.fn(async () => { emit({ kind: 'ready', plan: ANDROID_PLAN, running: false }) })
  const cancel = vi.fn()
  const provider: AndroidEnvironmentProvider = {
    snapshot: () => state,
    refresh: async () => state,
    prepare: async () => state,
    start: async () => {
      emit({
        kind: 'ready', plan: ANDROID_PLAN, deviceId: deviceId('emulator-5554'), running: true,
      })
      return state
    },
    cancel,
    deactivate,
    runtimeEnvironment: () => ({
      ANDROID_SDK_ROOT: ANDROID_PLAN.sdkRoot, ANDROID_AVD_HOME: ANDROID_PLAN.avdHome,
    }),
    onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { provider, cancel, deactivate, emit }
}

interface ServiceInternals {
  current: ReturnType<PhoneEnvironment['snapshot']>
  candidate: { source: 'override'; executablePath: string } | undefined
  candidateVersion: string | undefined
  refreshTask: Promise<ReturnType<PhoneEnvironment['snapshot']>> | undefined
  androidTask: Promise<void> | undefined
  android: AndroidEnvironmentProvider | undefined
  prepareAndroid(request: { licenseAccepted: true }): Promise<void>
  startAndroid(): Promise<void>
  refreshAndroid(): Promise<void>
  activateAndroidRuntime(state: PhoneAndroidState, signal: AbortSignal): Promise<void>
  runAndroidOperation(operation: (provider: AndroidEnvironmentProvider, signal: AbortSignal) => Promise<void>): Promise<void>
  cancelAndroid(): Promise<void>
  verifyAndroidRuntime(id: DeviceId, signal: AbortSignal): Promise<void>
  requireCurrentAndroidRuntime(id: DeviceId): void
}

function internals(service: PhoneEnvironment): ServiceInternals {
  return service as unknown as ServiceInternals
}

async function localAsset(options: { hold?: boolean; digest?: string } = {}): Promise<MobilecliReleaseAsset> {
  const executableName = process.platform === 'win32' ? 'mobilecli.exe' : 'mobilecli'
  const bytes = zipSync({
    [executableName]: new TextEncoder().encode('#!/bin/sh\necho "mobilecli version 1.0.5"\n'),
  })
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(bytes.byteLength) })
    if (options.hold === true) {
      res.write(bytes.slice(0, 8))
      return
    }
    res.end(bytes)
  })
  servers.push(server)
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('asset server did not bind')
  return {
    platform: process.platform as 'darwin' | 'linux' | 'win32',
    architecture: process.arch as 'arm64' | 'x64',
    name: 'mobilecli.zip',
    url: `http://127.0.0.1:${String(address.port)}/mobilecli.zip`,
    bytes: bytes.byteLength,
    sha256: options.digest ?? createHash('sha256').update(bytes).digest('hex'),
    executable: executableName,
  }
}

async function rawRequest(
  origin: string,
  path: string,
  method = 'POST',
): Promise<{ status: number; body: unknown }> {
  const url = new URL(origin)
  return await new Promise((resolveResponse, rejectResponse) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path,
      method,
      headers: { host: `${url.hostname}:${url.port}` },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveResponse({
          status: res.statusCode ?? 0,
          body: text.length === 0 ? undefined : JSON.parse(text),
        })
      })
    })
    req.on('error', rejectResponse)
    req.end()
  })
}

describe('PhoneEnvironment', () => {
  it('discovers a compatible system mobilecli from PATH', async () => {
    const path = await executable()
    vi.stubEnv('PATH', dirname(path))
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    expect(service.snapshot().runtime).toEqual({
      kind: 'ready', source: 'system', version: '1.0.5',
    })
  })

  it('requires Android license consent and reactivates mobilecli with the Provider environment', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const activateExecutable = vi.fn(async () => {})
    const listDevices = vi.fn(async () => ({
      android: [{
        id: deviceId('emulator-5554'), name: 'Pixel 6', kind: 'emulator', platform: 'android', state: 'online', online: true,
      }],
      ios: { simulators: [], reals: [] },
    }))
    const startCapture = vi.fn(async (_request: {
      readonly deviceId: DeviceId
      readonly format: 'h264'
      readonly signal: AbortSignal
    }) => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([
            ...H264_PICTURE,
          ]))
        },
      }),
    }))
    const { service, origin } = await mountEnvironment(
      context, { activateExecutable, listDevices, startCapture }, { executablePath: path },
    )
    const plan = ANDROID_PLAN
    let state: PhoneAndroidState = { kind: 'missing', plan }
    const listeners = new Set<(value: PhoneAndroidState) => void>()
    const prepare = vi.fn(async () => {
      state = { kind: 'ready', plan, running: false }
      for (const listener of listeners) listener(state)
      return state
    })
    const provider: AndroidEnvironmentProvider = {
      snapshot: () => state,
      refresh: async () => state,
      prepare,
      start: async () => {
        state = { kind: 'ready', plan, deviceId: deviceId('emulator-5554'), running: true }
        for (const listener of listeners) listener(state)
        return state
      },
      cancel: vi.fn(),
      deactivate: vi.fn(async () => {}),
      runtimeEnvironment: () => ({ ANDROID_SDK_ROOT: plan.sdkRoot, ANDROID_AVD_HOME: plan.avdHome }),
      onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const unregister = service.registerAndroidEnvironment(provider)
    await service.setEnabled(true)
    const refused = await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}/android/prepare`, { method: 'POST' })
    expect(refused.status).toBe(502)
    expect(await refused.json()).toMatchObject({ error: { code: 'PHONE_ANDROID_LICENSE_REQUIRED' } })
    const accepted = await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}/android/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ licenseAccepted: true }),
    })
    expect(accepted.status).toBe(200)
    expect(prepare).toHaveBeenCalledWith({ licenseAccepted: true }, expect.any(AbortSignal))
    expect(activateExecutable).toHaveBeenLastCalledWith(
      path,
      expect.any(AbortSignal),
      { ANDROID_SDK_ROOT: plan.sdkRoot, ANDROID_AVD_HOME: plan.avdHome },
    )
    expect(listDevices).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(startCapture).toHaveBeenCalledOnce()
    const captureRequest = startCapture.mock.calls[0]?.[0]
    expect(captureRequest?.deviceId).toBe(deviceId('emulator-5554'))
    expect(captureRequest?.format).toBe('h264')
    expect(captureRequest?.signal).toBeInstanceOf(AbortSignal)
    expect(service.snapshot().platforms.android).toMatchObject({ kind: 'ready', running: true })
    unregister()
    expect(service.snapshot().platforms.android).toEqual({ kind: 'deferred' })
  })

  it('rejects Android readiness when mobilecli cannot list the booted device', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const deactivateRuntime = vi.fn(async () => {})
    const { service, origin } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      deactivate: deactivateRuntime,
      listDevices: async () => ({ android: [], ios: { simulators: [], reals: [] } }),
    }, { executablePath: path })
    let state: PhoneAndroidState = { kind: 'missing', plan: ANDROID_PLAN }
    const listeners = new Set<(value: PhoneAndroidState) => void>()
    const deactivateAndroid = vi.fn(async () => {})
    service.registerAndroidEnvironment({
      snapshot: () => state,
      refresh: async () => state,
      prepare: async () => {
        state = { kind: 'ready', plan: ANDROID_PLAN, running: false }
        for (const listener of listeners) listener(state)
        return state
      },
      start: async () => {
        state = {
          kind: 'ready', plan: ANDROID_PLAN, deviceId: deviceId('emulator-5554'), running: true,
        }
        for (const listener of listeners) listener(state)
        return state
      },
      cancel: () => {},
      deactivate: deactivateAndroid,
      runtimeEnvironment: () => ({}),
      onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    })
    await service.setEnabled(true)
    const response = await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}/android/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ licenseAccepted: true }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'PHONE_ANDROID_RUNTIME_VERIFY' } })
    expect(deactivateRuntime).toHaveBeenCalled()
    expect(deactivateAndroid).toHaveBeenCalled()
    expect(service.snapshot().platforms.android).toMatchObject({
      kind: 'failed', code: 'PHONE_ANDROID_RUNTIME_VERIFY', retryable: true,
    })
  })

  it('publishes Android running readiness once, after mobilecli listing and H264 verification', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let picture!: ReadableStreamDefaultController<Uint8Array>
    const startCapture = vi.fn(async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({ start(controller) { picture = controller } }),
    }))
    const { service, origin } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      listDevices: async () => ({
        android: [{
          id: deviceId('emulator-5554'), name: 'Pixel 6', kind: 'emulator', platform: 'android', state: 'online', online: true,
        }],
        ios: { simulators: [], reals: [] },
      }),
      startCapture,
    }, { executablePath: path })
    const { provider } = runningAndroidProvider()
    service.registerAndroidEnvironment(provider)
    await service.setEnabled(true)
    const seen: PhoneAndroidState[] = []
    let previousAndroid = ''
    service.onChanged((snapshot) => {
      const serialized = JSON.stringify(snapshot.platforms.android)
      if (serialized === previousAndroid) return
      previousAndroid = serialized
      seen.push(snapshot.platforms.android)
    })

    const starting = fetch(`${origin}${PHONE_ENVIRONMENT_ANDROID_START_PATH}`, { method: 'POST' })
    await vi.waitFor(() => { expect(startCapture).toHaveBeenCalled() })
    expect(seen.some(state => state.kind === 'ready' && state.running)).toBe(false)
    picture.enqueue(H264_PICTURE)
    expect((await starting).status).toBe(200)

    expect(seen.map(state => state.kind === 'ready' ? `${state.kind}:${String(state.running)}` : state.kind))
      .toEqual(['booting', 'ready:true'])
  })

  it('does not trust a running Provider snapshot registered after Host activation', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, { activateExecutable: async () => {} }, { executablePath: path })
    await service.setEnabled(true)
    const { provider } = runningAndroidProvider()
    await provider.start()

    service.registerAndroidEnvironment(provider)

    expect(service.snapshot().platforms.android).toEqual({ kind: 'booting', plan: ANDROID_PLAN })
  })

  it('does not restore running readiness after the Emulator exits during H264 verification', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let picture!: ReadableStreamDefaultController<Uint8Array>
    const startCapture = vi.fn(async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({ start(controller) { picture = controller } }),
    }))
    const { service, origin } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      listDevices: async () => ({
        android: [{
          id: deviceId('emulator-5554'), name: 'Pixel 6', kind: 'emulator', platform: 'android', state: 'online', online: true,
        }],
        ios: { simulators: [], reals: [] },
      }),
      startCapture,
    }, { executablePath: path })
    const { provider, emit } = runningAndroidProvider()
    service.registerAndroidEnvironment(provider)
    await service.setEnabled(true)

    const starting = fetch(`${origin}${PHONE_ENVIRONMENT_ANDROID_START_PATH}`, { method: 'POST' })
    await vi.waitFor(() => { expect(startCapture).toHaveBeenCalled() })
    emit({
      kind: 'failed', plan: ANDROID_PLAN, code: 'PHONE_ANDROID_EMULATOR_EXIT',
      message: 'Android Emulator exited by SIGABRT', retryable: true,
    })
    picture.enqueue(H264_PICTURE)

    expect((await starting).status).toBe(502)
    expect(service.snapshot().platforms.android).toMatchObject({
      kind: 'failed', code: 'PHONE_ANDROID_EMULATOR_EXIT',
    })
  })

  it('cancels Android capture verification without publishing stale running readiness', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const captureCancelled = vi.fn()
    const startCapture = vi.fn(async () => ({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>({ cancel: captureCancelled }),
    }))
    const { service, origin } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      listDevices: async () => ({
        android: [{
          id: deviceId('emulator-5554'), name: 'Pixel 6', kind: 'emulator', platform: 'android', state: 'online', online: true,
        }],
        ios: { simulators: [], reals: [] },
      }),
      startCapture,
    }, { executablePath: path })
    const { provider, cancel, deactivate } = runningAndroidProvider()
    service.registerAndroidEnvironment(provider)
    await service.setEnabled(true)
    const seen: PhoneAndroidState[] = []
    service.onChanged((snapshot) => { seen.push(snapshot.platforms.android) })

    const starting = fetch(`${origin}${PHONE_ENVIRONMENT_ANDROID_START_PATH}`, { method: 'POST' })
    await vi.waitFor(() => { expect(startCapture).toHaveBeenCalled() })
    const cancelling = fetch(`${origin}${PHONE_ENVIRONMENT_ANDROID_CANCEL_PATH}`, { method: 'POST' })
    expect((await starting).status).toBe(502)
    expect((await cancelling).status).toBe(200)

    expect(captureCancelled).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalled()
    expect(deactivate).toHaveBeenCalled()
    expect(seen.some(state => state.kind === 'ready' && state.running)).toBe(false)
    expect(service.snapshot().platforms.android).toMatchObject({ kind: 'ready', running: false })
  })

  it('surfaces an Android process-tree stop failure from the cancel response', async () => {
    const context = new Context()
    contexts.push(context)
    const { service, origin } = await mountEnvironment(context)
    const stopFailure = new Error('taskkill refused the Android process tree')
    const cancel = vi.fn()
    const provider: AndroidEnvironmentProvider = {
      snapshot: () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      refresh: async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      prepare: async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      start: async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      cancel,
      deactivate: async () => { throw stopFailure },
      runtimeEnvironment: () => ({}),
      onChanged: () => () => {},
    }
    const unregister = service.registerAndroidEnvironment(provider)

    const response = await fetch(`${origin}${PHONE_ENVIRONMENT_ANDROID_CANCEL_PATH}`, { method: 'POST' })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { code: 'PHONE_ENVIRONMENT_ACTIVATION', message: stopFailure.message },
    })
    expect(cancel).toHaveBeenCalled()
    unregister()
  })

  it('rejects duplicate Android Providers and ignores a stale registration disposer', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const first = runningAndroidProvider()
    first.provider.refresh = async () => { throw new Error('probe failed') }
    const unregisterFirst = service.registerAndroidEnvironment(first.provider)
    expect(() => service.registerAndroidEnvironment(runningAndroidProvider().provider)).toThrow(/already registered/u)
    await Promise.resolve()
    unregisterFirst()
    const second = runningAndroidProvider()
    service.registerAndroidEnvironment(second.provider)
    unregisterFirst()
    second.emit({ kind: 'missing', plan: ANDROID_PLAN })
    expect(service.snapshot().platforms.android).toMatchObject({ kind: 'missing' })
  })

  it('prepares while disabled without starting and rejects start without an active runtime', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const prepared = vi.fn(async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false } satisfies PhoneAndroidState))
    const start = vi.fn(async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: true } satisfies PhoneAndroidState))
    const fixture = runningAndroidProvider()
    fixture.provider.prepare = prepared
    fixture.provider.start = start
    service.registerAndroidEnvironment(fixture.provider)
    await internals(service).prepareAndroid({ licenseAccepted: true })
    expect(prepared).toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    await expect(internals(service).startAndroid()).rejects.toMatchObject({ code: 'PHONE_ANDROID_RUNTIME_REQUIRED' })
  })

  it('uses an already-running prepared Emulator and refreshes its pending state', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {
      listDevices: async () => ({
        android: [{
          id: deviceId('emulator-5554'), name: 'Pixel', kind: 'emulator', platform: 'android', state: 'online', online: true,
        }],
        ios: { simulators: [], reals: [] },
      }),
      startCapture: async () => ({
        contentType: 'video/h264',
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(H264_PICTURE) } }),
      }),
    }, { executablePath: path })
    await service.setEnabled(true)
    const fixture = runningAndroidProvider()
    fixture.provider.prepare = async () => {
      fixture.emit({
        kind: 'ready', plan: ANDROID_PLAN, deviceId: deviceId('emulator-5554'), running: true,
      })
      return fixture.provider.snapshot()
    }
    const start = vi.spyOn(fixture.provider, 'start')
    service.registerAndroidEnvironment(fixture.provider)
    await internals(service).prepareAndroid({ licenseAccepted: true })
    expect(start).not.toHaveBeenCalled()
    await internals(service).refreshAndroid()
    expect(service.snapshot().platforms.android).toMatchObject({ kind: 'booting' })
  })

  it('returns early for Android states that cannot be committed as running', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const owned = internals(service)
    const signal = new AbortController().signal
    await owned.activateAndroidRuntime({ kind: 'missing', plan: ANDROID_PLAN }, signal)
    owned.candidate = { source: 'override', executablePath: '/mobilecli' }
    owned.candidateVersion = '1.0.5'
    await owned.activateAndroidRuntime({ kind: 'ready', plan: ANDROID_PLAN, running: false }, signal)
    await owned.activateAndroidRuntime({ kind: 'ready', plan: ANDROID_PLAN, running: true }, signal)
    owned.candidate = undefined
    await owned.activateAndroidRuntime({
      kind: 'ready', plan: ANDROID_PLAN, deviceId: deviceId('emulator-5554'), running: true,
    }, signal)
  })

  it('rejects a concurrent Android transaction and cancel contains an owned cancellation', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const fixture = runningAndroidProvider()
    service.registerAndroidEnvironment(fixture.provider)
    const owned = internals(service)
    owned.androidTask = new Promise(() => {})
    await expect(owned.runAndroidOperation(async () => {})).rejects.toMatchObject({ code: 'PHONE_ANDROID_BUSY' })
    owned.androidTask = Promise.reject(new PhoneEnvironmentError('PHONE_ANDROID_ABORTED', 'cancelled'))
    await expect(owned.cancelAndroid()).resolves.toBeUndefined()
  })

  it('preserves an Android transaction failure when Provider teardown also fails', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const fixture = runningAndroidProvider()
    fixture.provider.deactivate = async () => { throw new Error('stop failed') }
    service.registerAndroidEnvironment(fixture.provider)
    internals(service).androidTask = Promise.reject(
      Object.assign(new Error('operation failed'), { code: 'ANDROID_OPERATION' }),
    )
    await expect(internals(service).cancelAndroid()).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ACTIVATION' })
  })

  it('rejects an Android transaction when no Provider is registered', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    await expect(internals(service).runAndroidOperation(async () => {})).rejects.toMatchObject({
      code: 'PHONE_ANDROID_UNAVAILABLE',
    })
  })

  it('contains cleanup failures after Android verification rejects', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {
      deactivate: async () => { throw new Error('fleet stop failed') },
      listDevices: async () => ({ android: [], ios: { simulators: [], reals: [] } }),
    }, { executablePath: path })
    await service.setEnabled(true)
    const fixture = runningAndroidProvider()
    fixture.provider.deactivate = async () => { throw new Error('provider stop failed') }
    service.registerAndroidEnvironment(fixture.provider)
    await expect(internals(service).activateAndroidRuntime({
      kind: 'ready', plan: ANDROID_PLAN, deviceId: deviceId('emulator-5554'), running: true,
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'PHONE_ANDROID_RUNTIME_VERIFY' })
  })

  it('rejects a readiness commit after the Provider revokes its running device', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const fixture = runningAndroidProvider()
    service.registerAndroidEnvironment(fixture.provider)
    expect(() => { internals(service).requireCurrentAndroidRuntime(deviceId('emulator-5554')) }).toThrow(
      /revoked running device/u,
    )
  })

  it.each([
    ['', 'no Content-Type'],
    ['text/plain', 'text/plain'],
  ])('rejects Android capture media type %j', async (contentType, diagnostic) => {
    const path = await executable()
    const cancel = vi.fn(async () => {})
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {
      listDevices: async () => ({
        android: [{
          id: deviceId('emulator-5554'), name: 'Pixel', kind: 'emulator', platform: 'android', state: 'online', online: true,
        }],
        ios: { simulators: [], reals: [] },
      }),
      startCapture: async () => ({ contentType, body: new ReadableStream<Uint8Array>({ cancel }) }),
    }, { executablePath: path })
    await expect(internals(service).verifyAndroidRuntime(
      deviceId('emulator-5554'), new AbortController().signal,
    )).rejects.toThrow(diagnostic)
    expect(cancel).toHaveBeenCalled()
  })

  it('maps verification timeout, owner cancellation, and unexpected failures', async () => {
    vi.useFakeTimers()
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {
      listDevices: async (signal: AbortSignal) => await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        }, { once: true })
      }),
    }, { executablePath: path })
    const timed = internals(service).verifyAndroidRuntime(
      deviceId('emulator-5554'), new AbortController().signal,
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await timed).toMatchObject({ code: 'PHONE_ANDROID_RUNTIME_VERIFY' })

    const owner = new AbortController()
    const cancelled = internals(service).verifyAndroidRuntime(deviceId('emulator-5554'), owner.signal)
      .catch((error: unknown) => error)
    owner.abort('owner stopped')
    const failure = await cancelled
    expect(failure).toBe('owner stopped')
  })

  it.each([new Error('capture failed'), 'capture string failure'])(
    'wraps an unexpected Android verification failure %#', async (failure) => {
      const path = await executable()
      const context = new Context()
      contexts.push(context)
      const { service } = await mountEnvironment(context, {
        listDevices: async () => { throw failure },
      }, { executablePath: path })
      await expect(internals(service).verifyAndroidRuntime(
        deviceId('emulator-5554'), new AbortController().signal,
      )).rejects.toMatchObject({ code: 'PHONE_ANDROID_RUNTIME_VERIFY' })
    },
  )

  it('keeps the active operation failure when teardown aggregates Provider failures', async () => {
    const context = new Context()
    contexts.push(context)
    const { fiber, service } = await mountEnvironment(context)
    const fixture = runningAndroidProvider()
    fixture.provider.deactivate = async () => { throw new Error('provider teardown failed') }
    service.registerAndroidEnvironment(fixture.provider)
    internals(service).androidTask = Promise.reject(
      Object.assign(new Error('operation failed'), { code: 'ANDROID_OPERATION' }),
    )
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })

  it('drains rejected detection while disabling and rejects primitive Android task failures', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const owned = internals(service)
    owned.current = { ...service.snapshot(), enabled: true }
    owned.refreshTask = Promise.reject(new Error('detection failed'))
    await expect(service.setEnabled(false)).resolves.toBeUndefined()

    const providerTask = Promise.withResolvers<undefined>()
    owned.androidTask = providerTask.promise
    Reflect.apply(providerTask.reject, undefined, ['operation failed'])
    await expect(owned.cancelAndroid()).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ACTIVATION' })
  })

  it('accepts Android refresh and rejects malformed or oversized request bodies', async () => {
    const context = new Context()
    contexts.push(context)
    const { service, origin } = await mountEnvironment(context)
    service.registerAndroidEnvironment(runningAndroidProvider().provider)
    expect((await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}/android/refresh`, { method: 'POST' })).status).toBe(200)
    for (const body of ['{', 'x'.repeat(4_097)]) {
      const response = await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}/android/prepare`, { method: 'POST', body })
      expect(response.status).toBe(502)
    }
  })

  it('drains Android capture verification before disable settles', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const captureCancelled = vi.fn()
    const startCapture = vi.fn(async () => ({
      contentType: 'video/h264', body: new ReadableStream<Uint8Array>({ cancel: captureCancelled }),
    }))
    const { service, origin } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      listDevices: async () => ({
        android: [{
          id: deviceId('emulator-5554'), name: 'Pixel 6', kind: 'emulator', platform: 'android', state: 'online', online: true,
        }],
        ios: { simulators: [], reals: [] },
      }),
      startCapture,
    }, { executablePath: path })
    const { provider, deactivate } = runningAndroidProvider()
    service.registerAndroidEnvironment(provider)
    await service.setEnabled(true)

    const starting = fetch(`${origin}${PHONE_ENVIRONMENT_ANDROID_START_PATH}`, { method: 'POST' })
    await vi.waitFor(() => { expect(startCapture).toHaveBeenCalled() })
    const disabling = service.setEnabled(false)
    expect((await starting).status).toBe(502)
    await disabling

    expect(captureCancelled).toHaveBeenCalledOnce()
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().enabled).toBe(false)
    expect(service.snapshot().platforms.android).not.toMatchObject({ kind: 'ready', running: true })
  })

  it('drains Android capture verification before teardown settles', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const captureCancelled = vi.fn()
    const startCapture = vi.fn(async () => ({
      contentType: 'video/h264', body: new ReadableStream<Uint8Array>({ cancel: captureCancelled }),
    }))
    const { fiber, service, origin } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      listDevices: async () => ({
        android: [{
          id: deviceId('emulator-5554'), name: 'Pixel 6', kind: 'emulator', platform: 'android', state: 'online', online: true,
        }],
        ios: { simulators: [], reals: [] },
      }),
      startCapture,
    }, { executablePath: path })
    const { provider, deactivate } = runningAndroidProvider()
    service.registerAndroidEnvironment(provider)
    await service.setEnabled(true)

    const starting = fetch(`${origin}${PHONE_ENVIRONMENT_ANDROID_START_PATH}`, { method: 'POST' })
    await vi.waitFor(() => { expect(startCapture).toHaveBeenCalled() })
    const teardown = fiber.dispose()
    await starting.catch(() => undefined)
    await teardown

    expect(captureCancelled).toHaveBeenCalledOnce()
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().platforms.android).not.toMatchObject({ kind: 'ready', running: true })
  })

  it('updates the durable enable gate without remounting the Service', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const seen = vi.fn()
    const unsubscribe = service.onChanged(seen)
    const before = service.snapshot().revision
    await service.setEnabled(true)
    const afterEnable = service.snapshot().revision
    await service.setEnabled(true)
    expect(service.snapshot().enabled).toBe(true)
    expect(afterEnable).toBeGreaterThan(before)
    expect(service.snapshot().revision).toBe(afterEnable)
    expect(seen).toHaveBeenCalled()
    const calls = seen.mock.calls.length
    unsubscribe()
    await service.setEnabled(false)
    expect(seen).toHaveBeenCalledTimes(calls)
  })

  it('serializes disable and re-enable around one activating generation', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let releaseActivation: (() => void) | undefined
    const calls: string[] = []
    const activation = new Promise<void>((resolve) => { releaseActivation = resolve })
    const { service } = await mountEnvironment(context, {
      activateExecutable: async () => { calls.push('activate'); await activation },
      deactivate: async () => { calls.push('deactivate') },
    }, { executablePath: path })
    const first = service.setEnabled(true)
    await vi.waitFor(() => { expect(calls).toContain('activate') })
    const off = service.setEnabled(false)
    const on = service.setEnabled(true)
    releaseActivation?.()
    await Promise.all([first, off, on])
    expect(calls).toEqual(['activate', 'deactivate', 'activate'])
    expect(service.snapshot().enabled).toBe(true)
  })

  it('actively aborts a non-prepare activation when disabled', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let activationStarted!: () => void
    const started = new Promise<void>((resolve) => { activationStarted = resolve })
    const deactivate = vi.fn(async () => {})
    const { service } = await mountEnvironment(context, {
      activateExecutable: async (_path: string, signal?: AbortSignal) => {
        activationStarted()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('phone environment activation aborted'))
          }, { once: true })
        })
      },
      deactivate,
    }, { executablePath: path })
    const enabling = service.setEnabled(true)
    await started
    const beganDisable = Date.now()
    const disabling = service.setEnabled(false)
    await expect(enabling).rejects.toBeTruthy()
    await disabling
    expect(Date.now() - beganDisable).toBeLessThan(500)
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().enabled).toBe(false)
  })

  it('lets the cancel operation interrupt a non-prepare activation', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let activationStarted!: () => void
    const started = new Promise<void>((resolve) => { activationStarted = resolve })
    const { service } = await mountEnvironment(context, {
      activateExecutable: async (_path: string, signal?: AbortSignal) => {
        activationStarted()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('phone environment activation aborted'))
          }, { once: true })
        })
      },
    }, { executablePath: path })
    const enabling = service.setEnabled(true)
    await started
    service.cancel()
    await expect(enabling).rejects.toBeTruthy()
    expect(service.snapshot().runtime).toMatchObject({ kind: 'failed' })
  })

  it('aborts and drains activation before teardown returns', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let activationStarted!: () => void
    const started = new Promise<void>((resolve) => { activationStarted = resolve })
    const { fiber, service } = await mountEnvironment(context, {
      activateExecutable: async (_path: string, signal?: AbortSignal) => {
        activationStarted()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('phone environment activation aborted'))
          }, { once: true })
        })
      },
    }, { executablePath: path })
    const enabling = service.setEnabled(true)
    await started
    const beganTeardown = Date.now()
    const teardown = fiber.dispose()
    await expect(enabling).rejects.toBeTruthy()
    await teardown
    expect(Date.now() - beganTeardown).toBeLessThan(500)
  })

  it('keeps an explicit executable override authoritative over managed preparation', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {}, { executablePath: '/operator/mobilecli' })
    await expect(service.prepare()).rejects.toEqual(expect.objectContaining<Partial<PhoneEnvironmentError>>({
      code: 'PHONE_ENVIRONMENT_OVERRIDE',
    }))
  })

  it('rejects a concurrent preparation instead of replacing its cancellation owner', async () => {
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context)
    const first = service.prepare()
    await expect(service.prepare()).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_BUSY' })
    service.cancel()
    await first.catch(() => {})
  })

  it('revokes the active generation when later detection fails', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const deactivate = vi.fn(async () => {})
    const { service } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      deactivate,
    }, { executablePath: path })
    await service.setEnabled(true)
    await rm(path)
    await service.refresh()
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().runtime).toMatchObject({ kind: 'failed', code: 'PHONE_ENVIRONMENT_VERSION' })
  })

  it('projects an unexpected runtime readiness loss into the environment snapshot', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    let readiness: ((ready: boolean) => void) | undefined
    const { service } = await mountEnvironment(context, {
      activateExecutable: async () => {},
      onReadinessChanged: (listener: (ready: boolean) => void) => {
        readiness = listener
        return () => { readiness = undefined }
      },
    }, { executablePath: path })
    await service.setEnabled(true)
    expect(service.snapshot().runtime.kind).toBe('ready')
    readiness?.(true)
    expect(service.snapshot().runtime.kind).toBe('ready')
    readiness?.(false)
    expect(service.snapshot().runtime).toMatchObject({
      kind: 'failed', code: 'PHONE_ENVIRONMENT_RUNTIME_LOST',
    })
  })

  it('recovers an existing managed current after the Service is rebuilt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-restart-'))
    roots.push(root)
    const executableName = process.platform === 'win32' ? 'mobilecli.exe' : 'mobilecli'
    const versionDir = join(root, 'versions', 'persisted')
    await mkdir(versionDir, { recursive: true })
    const managedExecutable = join(versionDir, executableName)
    await writeFile(managedExecutable, '#!/bin/sh\necho "mobilecli version 1.0.5"\n')
    await chmod(managedExecutable, 0o700)
    await writeFile(join(root, 'current.json'), `${JSON.stringify({
      version: '1.0.5', platform: process.platform, architecture: process.arch,
      executable: `versions/persisted/${executableName}`,
    })}\n`)

    const firstContext = new Context()
    contexts.push(firstContext)
    const first = await mountEnvironment(firstContext, {}, { root })
    expect(first.service.snapshot().runtime).toEqual({ kind: 'ready', source: 'managed', version: '1.0.5' })
    await first.fiber.dispose()

    const restartedContext = new Context()
    contexts.push(restartedContext)
    const restarted = await mountEnvironment(restartedContext, {}, { root })
    expect(restarted.service.snapshot().runtime).toEqual({ kind: 'ready', source: 'managed', version: '1.0.5' })
  })

  it('removes subscribers when its owning fiber disposes', async () => {
    const context = new Context()
    contexts.push(context)
    const { fiber, service } = await mountEnvironment(context)
    const listener = vi.fn()
    service.onChanged(listener)
    await fiber.dispose()
    await service.setEnabled(true)
    expect(listener).not.toHaveBeenCalled()
  })

  it('serves full snapshots only through the shared Host trust fence', async () => {
    const context = new Context()
    contexts.push(context)
    const { origin } = await mountEnvironment(context)
    const accepted = await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}`)
    expect(accepted.status).toBe(200)
    const body = await accepted.json() as {
      enabled: boolean
      runtime: { kind: string; targetVersion?: string; version?: string }
      platforms: { android: { kind: string } }
    }
    expect(body).toMatchObject({
      enabled: false,
      platforms: { android: { kind: 'deferred' } },
    })
    expect(body.runtime.kind).toMatch(/missing|ready/)
    expect(body.runtime.targetVersion ?? body.runtime.version).toBe('1.0.5')
    const refused = await rawGet(`${origin}${PHONE_ENVIRONMENT_PATH}`, 'attacker.example')
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({
      error: { code: 'forbidden', message: 'phone environment request is not trusted' },
    })
    expect((await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${origin}${PHONE_ENVIRONMENT_PATH}/unknown`, { method: 'POST' })).status).toBe(404)
  })

  it('passes a trimmed explicit override through the version probe', async () => {
    const path = await executable()
    const probe = vi.fn(async () => '1.0.5')
    controlledProbe = probe
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(
      context, {}, { executablePath: `  ${path}  ` }, ControlledPhoneEnvironment,
    )
    expect(probe).toHaveBeenCalledWith(path, expect.any(AbortSignal))
    expect(service.snapshot().runtime).toEqual({ kind: 'ready', source: 'override', version: '1.0.5' })
  })

  it('treats a blank override as absent and suppresses duplicate missing publications', async () => {
    isolateSystemMobilecliSearch()
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-missing-'))
    roots.push(root)
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {}, { root, executablePath: '   ' })
    const revision = service.snapshot().revision
    await service.refresh()
    await service.refresh()
    expect(service.snapshot()).toMatchObject({ revision, runtime: { kind: 'missing' } })
  })

  it('joins one active refresh and composes caller cancellation into detection', async () => {
    const path = await executable()
    let probes = 0
    let started!: () => void
    const probing = new Promise<void>((resolve) => { started = resolve })
    controlledProbe = async (_executablePath, signal) => {
      probes += 1
      if (probes === 1) return '1.0.5'
      started()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('detection aborted'))
        }, { once: true })
      })
      return '1.0.5'
    }
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(
      context, {}, { executablePath: path }, ControlledPhoneEnvironment,
    )
    const controller = new AbortController()
    const first = service.refresh(controller.signal)
    const joined = service.refresh()
    expect(joined).toBe(first)
    await probing
    controller.abort(new Error('stop detection'))
    await expect(first).resolves.toMatchObject({ runtime: { kind: 'failed' } })
  })

  it('keeps a later enable operation as the cleanup owner when the active activation is cancelled', async () => {
    const path = await executable()
    let activationStarted!: () => void
    const started = new Promise<void>((resolve) => { activationStarted = resolve })
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {
      activateExecutable: async (_path: string, signal: AbortSignal) => {
        activationStarted()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('activation aborted'))
          }, { once: true })
        })
      },
    }, { executablePath: path })
    const first = service.setEnabled(true)
    await started
    const later = service.setEnabled(true)
    service.cancel()
    await expect(first).rejects.toBeTruthy()
    await later
    expect(service.snapshot().enabled).toBe(true)
  })

  it('deactivates the enabled fleet when no runtime candidate can be detected', async () => {
    isolateSystemMobilecliSearch()
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-no-runtime-'))
    roots.push(root)
    const deactivate = vi.fn(async () => {})
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, { deactivate }, { root })
    await service.setEnabled(true)
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot()).toMatchObject({ enabled: true, runtime: { kind: 'missing' } })
  })

  it('publishes every managed preparation phase while disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-prepare-'))
    roots.push(root)
    controlledAsset = await localAsset()
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {}, { root }, ControlledPhoneEnvironment)
    const phases: string[] = []
    service.onChanged((snapshot) => { phases.push(snapshot.runtime.kind) })
    await service.prepare()
    expect(phases).toContain('downloading')
    expect(phases).toContain('verifying')
    expect(phases.at(-1)).toBe('ready')
    expect(service.snapshot().runtime).toEqual({ kind: 'ready', source: 'managed', version: '1.0.5' })
  })

  it('activates a prepared managed runtime without restarting the enabled Service', async () => {
    isolateSystemMobilecliSearch()
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-active-prepare-'))
    roots.push(root)
    controlledAsset = await localAsset()
    const activateExecutable = vi.fn(async () => {})
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, { activateExecutable }, { root }, ControlledPhoneEnvironment)
    await service.setEnabled(true)
    await service.prepare()
    expect(activateExecutable).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]versions[\\/]/u), expect.any(AbortSignal), undefined,
    )
    expect(service.snapshot()).toMatchObject({ enabled: true, runtime: { kind: 'ready', source: 'managed' } })
  })

  it('publishes verification failure and cancellation terminal states', async () => {
    const failedRoot = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-failed-prepare-'))
    roots.push(failedRoot)
    controlledAsset = await localAsset({ digest: '0'.repeat(64) })
    const failedContext = new Context()
    contexts.push(failedContext)
    const failed = await mountEnvironment(failedContext, {}, { root: failedRoot }, ControlledPhoneEnvironment)
    await expect(failed.service.prepare()).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DIGEST' })
    expect(failed.service.snapshot().runtime).toMatchObject({ kind: 'failed', code: 'PHONE_ENVIRONMENT_DIGEST' })

    const cancelledRoot = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-cancel-prepare-'))
    roots.push(cancelledRoot)
    controlledAsset = await localAsset({ hold: true })
    const cancelledContext = new Context()
    contexts.push(cancelledContext)
    const cancelled = await mountEnvironment(cancelledContext, {}, { root: cancelledRoot }, ControlledPhoneEnvironment)
    const operation = cancelled.service.prepare()
    await vi.waitFor(() => {
      expect(cancelled.service.snapshot().runtime).toMatchObject({ kind: 'downloading', receivedBytes: 8 })
    })
    cancelled.service.cancel()
    await expect(operation).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ABORTED' })
    expect(cancelled.service.snapshot().runtime).toMatchObject({ kind: 'missing' })
  })

  it('waits for cancelled preparation before disabling the fleet', async () => {
    isolateSystemMobilecliSearch()
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-disable-prepare-'))
    roots.push(root)
    controlledAsset = await localAsset({ hold: true })
    const deactivate = vi.fn(async () => {})
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(
      context, { deactivate }, { root }, ControlledPhoneEnvironment,
    )
    await service.setEnabled(true)
    const preparation = service.prepare().catch((error: unknown) => error)
    await vi.waitFor(() => {
      expect(service.snapshot().runtime).toMatchObject({ kind: 'downloading', receivedBytes: 8 })
    })
    await service.setEnabled(false)
    expect(await preparation).toMatchObject({ code: 'PHONE_ENVIRONMENT_ABORTED' })
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().enabled).toBe(false)
  })

  it.each([
    [new PhoneEnvironmentError('PHONE_ENVIRONMENT_TEST', 'asset selection failed'), 'PHONE_ENVIRONMENT_TEST'],
    ['non-error asset failure', 'PHONE_ENVIRONMENT_ACTIVATION'],
  ])('publishes managed-asset selection failure %#', async (failure, code) => {
    controlledAsset = failure
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {}, {}, ControlledPhoneEnvironment)
    await expect(service.prepare()).rejects.toBeTruthy()
    expect(service.snapshot().runtime).toMatchObject({ kind: 'failed', code })
  })

  it('contains subscriber failures and continues notifying later subscribers', async () => {
    const context = new Context()
    contexts.push(context)
    const report = vi.spyOn(context.logger, 'error').mockImplementation(() => {})
    const { service } = await mountEnvironment(context)
    service.onChanged(() => { throw new Error('broken subscriber') })
    const survivor = vi.fn()
    service.onChanged(survivor)
    await service.setEnabled(true)
    expect(report).toHaveBeenCalledWith(expect.any(Error))
    expect(survivor).toHaveBeenCalled()
  })

  it('replaces an in-flight activation without allowing stale cleanup to clear the new owner', async () => {
    const path = await executable()
    let activations = 0
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const activateExecutable = vi.fn(async (_path: string, signal: AbortSignal) => {
      activations += 1
      if (activations !== 1) return
      firstStarted()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('activation replaced'))
        }, { once: true })
      })
    })
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, { activateExecutable }, { executablePath: path })
    const enabling = service.setEnabled(true)
    await started
    const refreshing = service.refresh()
    await expect(enabling).rejects.toBeTruthy()
    await refreshing
    expect(activateExecutable).toHaveBeenCalledTimes(2)
    expect(service.snapshot().runtime.kind).toBe('ready')
  })

  it('contains fleet deactivation failure while projecting a failed enabled refresh', async () => {
    const path = await executable()
    let probes = 0
    controlledProbe = async () => {
      probes += 1
      if (probes === 1) return '1.0.5'
      throw new Error('probe failed')
    }
    const deactivate = vi.fn(async () => { throw new Error('stop failed') })
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(
      context, { activateExecutable: async () => {}, deactivate }, { executablePath: path }, ControlledPhoneEnvironment,
    )
    await service.setEnabled(true)
    await service.refresh()
    expect(deactivate).toHaveBeenCalled()
    expect(service.snapshot().runtime).toMatchObject({ kind: 'failed', message: 'probe failed' })
  })

  it('rejects a discovered runtime whose version does not match the pinned Desktop version', async () => {
    const path = await executable()
    controlledProbe = async () => '9.9.9'
    const context = new Context()
    contexts.push(context)
    const { service } = await mountEnvironment(context, {}, { executablePath: path }, ControlledPhoneEnvironment)
    const runtime = service.snapshot().runtime
    expect(runtime.kind).toBe('failed')
    if (runtime.kind !== 'failed') throw new Error('wrong runtime state')
    expect(runtime.code).toBe('PHONE_ENVIRONMENT_VERSION')
    expect(runtime.message).toContain('9.9.9')
  })

  it('serves trusted POST operations and maps stable failures to HTTP status', async () => {
    const path = await executable()
    const context = new Context()
    contexts.push(context)
    const { origin } = await mountEnvironment(context, {}, { executablePath: path })
    expect((await rawRequest(origin, '/phone/environment/refresh')).status).toBe(200)
    expect((await rawRequest(origin, '/phone/environment/cancel')).status).toBe(200)
    const prepare = await rawRequest(origin, '/phone/environment/prepare')
    expect(prepare).toMatchObject({
      status: 502,
      body: { error: { code: 'PHONE_ENVIRONMENT_OVERRIDE' } },
    })
  })

  it('maps concurrent preparation to HTTP conflict and drains it on teardown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-http-busy-'))
    roots.push(root)
    controlledAsset = await localAsset({ hold: true })
    const context = new Context()
    contexts.push(context)
    const mounted = await mountEnvironment(context, {}, { root }, ControlledPhoneEnvironment)
    const operation = mounted.service.prepare()
    await vi.waitFor(() => {
      expect(mounted.service.snapshot().runtime).toMatchObject({ kind: 'downloading', receivedBytes: 8 })
    })
    expect((await rawRequest(mounted.origin, '/phone/environment/prepare')).status).toBe(409)
    await mounted.fiber.dispose()
    await expect(operation).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ABORTED' })
  })
})
