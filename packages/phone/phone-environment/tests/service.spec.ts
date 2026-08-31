import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import PhoneEnvironment, {
  PHONE_ENVIRONMENT_ANDROID_CANCEL_PATH, PHONE_ENVIRONMENT_ANDROID_START_PATH,
  PHONE_ENVIRONMENT_PATH, PhoneEnvironmentError,
} from '../src/index.ts'
import type { AndroidEnvironmentProvider, AndroidPreparationPlan, PhoneAndroidState } from '../src/index.ts'

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
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function executable(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-service-'))
  roots.push(root)
  const path = join(root, 'mobilecli')
  await writeFile(path, '#!/bin/sh\necho "mobilecli version 1.0.5"\n')
  await chmod(path, 0o700)
  return path
}

async function mountEnvironment(context: Context, phoneDevices: object = {}, config: { root?: string; executablePath?: string } = {}) {
  const fleet = {
    isReady: () => false,
    onReadinessChanged: () => () => {},
    activateExecutable: async () => {},
    deactivate: async () => {},
    ...phoneDevices,
  }
  context.provide('phoneDevices', fleet as never)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const fiber = context.plugin(PhoneEnvironment, config)
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
    cancel: vi.fn(),
    deactivate,
    runtimeEnvironment: () => ({
      ANDROID_SDK_ROOT: ANDROID_PLAN.sdkRoot, ANDROID_AVD_HOME: ANDROID_PLAN.avdHome,
    }),
    onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { provider, deactivate, emit }
}

describe('PhoneEnvironment', () => {
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
    const startCapture = vi.fn(async () => ({
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
    const provider: AndroidEnvironmentProvider = {
      snapshot: () => state,
      refresh: async () => state,
      prepare: vi.fn(async () => {
        state = { kind: 'ready', plan, running: false }
        for (const listener of listeners) listener(state)
        return state
      }),
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
    expect(provider.prepare).toHaveBeenCalledWith({ licenseAccepted: true }, expect.any(AbortSignal))
    expect(activateExecutable).toHaveBeenLastCalledWith(
      path,
      expect.any(AbortSignal),
      { ANDROID_SDK_ROOT: plan.sdkRoot, ANDROID_AVD_HOME: plan.avdHome },
    )
    expect(listDevices).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(startCapture).toHaveBeenCalledWith({
      deviceId: deviceId('emulator-5554'), format: 'h264', signal: expect.any(AbortSignal),
    })
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
    const { provider, deactivate } = runningAndroidProvider()
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
    expect(provider.cancel).toHaveBeenCalled()
    expect(deactivate).toHaveBeenCalled()
    expect(seen.some(state => state.kind === 'ready' && state.running)).toBe(false)
    expect(service.snapshot().platforms.android).toMatchObject({ kind: 'ready', running: false })
  })

  it('surfaces an Android process-tree stop failure from the cancel response', async () => {
    const context = new Context()
    contexts.push(context)
    const { service, origin } = await mountEnvironment(context)
    const stopFailure = new Error('taskkill refused the Android process tree')
    const provider: AndroidEnvironmentProvider = {
      snapshot: () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      refresh: async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      prepare: async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      start: async () => ({ kind: 'ready', plan: ANDROID_PLAN, running: false }),
      cancel: vi.fn(),
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
    expect(provider.cancel).toHaveBeenCalled()
    unregister()
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
    const context = new Context()
    contexts.push(context)
    let releaseActivation: (() => void) | undefined
    const calls: string[] = []
    const activation = new Promise<void>((resolve) => { releaseActivation = resolve })
    const { service } = await mountEnvironment(context, {
      activateExecutable: async () => { calls.push('activate'); await activation },
      deactivate: async () => { calls.push('deactivate') },
    })
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
})
