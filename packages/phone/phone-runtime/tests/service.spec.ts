import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Config, PhoneDeviceChange, PhoneDeviceList } from '@deepseek-ai/dsh-phone-runtime'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { MobilecliProcessTree, MobilecliServerProcess } from '../src/server-process.ts'
import PhoneDevices, { deviceId, phoneCaptureId, PhoneDevicesError } from '../src/index.ts'
import { assertRecognizableH264Picture, firstMjpegFrame, jpegDimensions, pngDimensions, PNG_SIGNATURE, stageFake, wireDevice } from './helpers.ts'
import { buildGradientH264, buildGradientJpeg } from './fixtures/u3-visible-frames.ts'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAndroidLogicalDisplay } from '../src/android-display.ts'
import { openAndroidSystemH264 } from '../src/android-h264-process.ts'
import { assertIoDispatchAuthority } from '../src/io-authorization.ts'

function syntheticAndroidH264(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buildGradientH264())
      controller.close()
    },
  })
}

function nativeLaunchDiagnostics(): string {
  return MobilecliServerProcess.diagnostics.join('\n')
}

vi.mock('../src/android-display.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/android-display.ts')>()
  return {
    ...actual,
    readAndroidLogicalDisplay: vi.fn(() => undefined),
  }
})

vi.mock('../src/io-authorization.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/io-authorization.ts')>()
  return {
    ...actual,
    assertIoDispatchAuthority: vi.fn((options: Parameters<typeof actual.assertIoDispatchAuthority>[0]) => {
      actual.assertIoDispatchAuthority(options)
    }),
  }
})

vi.mock('../src/android-h264-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/android-h264-process.ts')>()
  const { buildGradientH264: syntheticH264 } = await import('./fixtures/u3-visible-frames.ts')
  return {
    ...actual,
    openAndroidSystemH264: vi.fn((...args: Parameters<typeof actual.openAndroidSystemH264>) => {
      void args
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(syntheticH264())
          controller.close()
        },
      })
    }),
  }
})

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const contexts: CordisContext[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []
const homes: string[] = []
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-phone-service-home-'))
  homes.push(home)
  process.env.DSH_HOME = home
})

afterEach(async () => {
  vi.mocked(readAndroidLogicalDisplay).mockReturnValue(undefined)
  vi.mocked(openAndroidSystemH264).mockReset()
  vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
  vi.mocked(assertIoDispatchAuthority).mockClear()
  console.error('child diagnostics:', MobilecliServerProcess.diagnostics.splice(0))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function errorOf(run: () => Promise<unknown>): Promise<PhoneDevicesError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PhoneDevicesError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

const ANDROID_EMULATOR = deviceId('emulator-5554')
const IOS_SIMULATOR = deviceId('SIM-UDID')
const IOS_REAL = deviceId('REAL-UDID')

const BASE_DEVICES = [
  wireDevice('emulator-5554', 'android', 'emulator', 'online'),
  wireDevice('SIM-UDID', 'ios', 'simulator', 'offline'),
  wireDevice('REAL-UDID', 'ios', 'real', 'online'),
]

const FAST_CONFIG: Partial<Config> = {
  pollIntervalMs: 20,
  readyTimeoutMs: 6_000,
  requestTimeoutMs: 1_500,
  bootTimeoutMs: 2_000,
}

async function mountWith(fake: Awaited<ReturnType<typeof stageFake>>, overrides: Partial<Config> = {}): Promise<CordisContext> {
  await fake.claim()
  const context = new Context()
  contexts.push(context)
  try {
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: fake.executablePath,
      serverPort: fake.port,
      ...overrides,
    }).await()
  } catch (error) {
    console.error('child diagnostics:', MobilecliServerProcess.diagnostics)
    throw error
  }
  return context
}

function laterAbort(): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => {
    controller.abort()
  }, 40)
  return controller.signal
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
}

describe('phone runtime service lifecycle', () => {
  it('hot-activates and deactivates replaceable generations behind one Service', async () => {
    const fake = await stageFake({
      devices: [wireDevice('emulator-5554', 'android', 'emulator', 'online')],
    })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()

    const readiness: boolean[] = []
    context.phoneDevices.onReadinessChanged(ready => readiness.push(ready))
    const removedReadiness: boolean[] = []
    const removeReadiness = context.phoneDevices.onReadinessChanged(ready => removedReadiness.push(ready))
    expect(context.phoneDevices.isReady()).toBe(false)
    await context.phoneDevices.activateExecutable(fake.executablePath)
    expect(context.phoneDevices.isReady()).toBe(true)
    removeReadiness()
    expect((await context.phoneDevices.listDevices()).android.map(device => device.id))
      .toEqual(['emulator-5554'])

    await context.phoneDevices.deactivate()
    expect(context.phoneDevices.isReady()).toBe(false)
    await expect(context.phoneDevices.listDevices()).rejects.toMatchObject({ code: 'PHONE_UNRESOLVED' })
    await context.phoneDevices.activateExecutable(fake.executablePath)
    expect(context.phoneDevices.isReady()).toBe(true)
    expect(readiness).toEqual([true, false, true])
    expect(removedReadiness).toEqual([true])
  })

  it('answers an empty initial listing without a devices-changed event', async () => {
    const fake = await stageFake({ devices: [] })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 60_000 })
    const changes: PhoneDeviceChange[] = []
    context.phoneDevices.onChanged(change => changes.push(change))
    expect(context.phoneDevices.isReady()).toBe(true)
    const list = await context.phoneDevices.listDevices()
    expect(list).toEqual({
      android: [],
      ios: { simulators: [], reals: [] },
    })
    expect(changes).toEqual([])
    expect(context.phoneDevices.isReady()).toBe(true)
  })

  it('rejects activation whose caller is already cancelled', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()
    const controller = new AbortController()
    controller.abort()
    await expect(context.phoneDevices.activateExecutable(fake.executablePath, controller.signal))
      .rejects.toMatchObject({ code: 'PHONE_ABORTED' })
  })

  it('rejects a queued deactivation when teardown owns the Service first', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const captured = context.phoneDevices as unknown as {
      activationTail: Promise<void>
      deactivate(): Promise<void>
    }
    captured.activationTail = blocked
    const deactivating = captured.deactivate()
    const disposing = context.fiber.dispose()
    release()
    await expect(deactivating).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await disposing
  })

  it('does not publish readiness when activation is cancelled during the baseline hold', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      readyStabilityMs: 200,
      serverPort: fake.port,
    }).await()

    const readiness: boolean[] = []
    context.phoneDevices.onReadinessChanged(ready => readiness.push(ready))
    const controller = new AbortController()
    const activation = context.phoneDevices.activateExecutable(fake.executablePath, controller.signal)
    await fake.awaitOnline()
    await waitFor(async () => (await fake.counters()).requests >= 2)
    controller.abort(new Error('cancel during baseline hold'))

    await expect(activation).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(context.phoneDevices.isReady()).toBe(false)
    expect(readiness).toEqual([])
  })

  it('rejects a timed-out baseline listing without publishing readiness', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, listDelayMs: 300 })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      requestTimeoutMs: 50,
      serverPort: fake.port,
    }).await()

    const readiness: boolean[] = []
    context.phoneDevices.onReadinessChanged(ready => readiness.push(ready))
    await expect(context.phoneDevices.activateExecutable(fake.executablePath))
      .rejects.toMatchObject({ code: 'PHONE_TIMEOUT' })
    expect(context.phoneDevices.isReady()).toBe(false)
    expect(readiness).toEqual([])
  })

  it('cancels the in-flight baseline listing without publishing readiness', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, listDelayMs: 5_000 })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      requestTimeoutMs: 6_000,
      serverPort: fake.port,
    }).await()

    const readiness: boolean[] = []
    context.phoneDevices.onReadinessChanged(ready => readiness.push(ready))
    const controller = new AbortController()
    const activation = context.phoneDevices.activateExecutable(fake.executablePath, controller.signal)
    await fake.awaitOnline()
    await waitFor(async () => (await fake.counters()).requests >= 2)
    const abortedAt = Date.now()
    controller.abort(new Error('cancel during baseline listing'))

    await expect(activation).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    // The five-second fake response delay makes sub-second rejection prove
    // that caller cancellation reached the in-flight RPC.
    expect(Date.now() - abortedAt).toBeLessThan(1_000)
    expect(context.phoneDevices.isReady()).toBe(false)
    expect(readiness).toEqual([])
  })

  it('activates with an unavailable service when PATH carries no mobilecli', async () => {
    const context = new Context()
    contexts.push(context)
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const previousNpmPrefix = process.env.npm_config_prefix
    process.env.PATH = ''
    process.env.HOME = ''
    delete process.env.USERPROFILE
    delete process.env.npm_config_prefix
    try {
      // Composition survives: the Host must not die for an optional provider.
      await context.plugin(PhoneDevices, { ...FAST_CONFIG }).await()
      const unavailable = await errorOf(() => context.phoneDevices.listDevices())
      expect(unavailable.code).toBe('PHONE_UNRESOLVED')
      expect(unavailable.message).toContain('npm install -g mobilecli@latest')
      expect(unavailable.message).toContain('(no candidate directories)')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      if (previousNpmPrefix === undefined) delete process.env.npm_config_prefix
      else process.env.npm_config_prefix = previousNpmPrefix
    }
  })

  it('refuses lifecycle verbs that arrive before the first baseline exists', async () => {
    const fake = await stageFake({ hang: true })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    const pending = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      readyTimeoutMs: 2_000,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    }).await().then(() => undefined, () => undefined)
    // One macrotask lets the class plugin's constructor register the service.
    await new Promise(resolveTick => setTimeout(resolveTick, 0))
    const early = await errorOf(() => context.phoneDevices.boot(deviceId('SIM-UDID')))
    expect(early.code).toBe('PHONE_DEVICE_NOT_FOUND')
    context.fiber.dispose().catch(() => undefined)
    await pending
  })

  it('times the readiness wait out with PHONE_TIMEOUT when no caller signal exists', async () => {
    const fake = await stageFake({ hang: true })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    const pending = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      readyTimeoutMs: 5_000,
      requestTimeoutMs: 300,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    }).await().then(() => undefined, () => undefined)
    await new Promise(resolveTick => setTimeout(resolveTick, 0))
    const timedOut = await errorOf(() => context.phoneDevices.listDevices())
    expect(timedOut.code).toBe('PHONE_TIMEOUT')
    expect(timedOut.message).toContain('READY_WAIT')
    context.fiber.dispose().catch(() => undefined)
    await pending
  })

  it('keeps the Host alive when a configured executablePath is unusable', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: '/no-such-directory/mobilecli',
    }).await()
    const unavailable = await errorOf(() => context.phoneDevices.listDevices())
    expect(unavailable.code).toBe('PHONE_UNRESOLVED')
    expect(unavailable.message).toContain('/no-such-directory/mobilecli')
    expect(unavailable.message).toContain('not an executable file')
    expect(unavailable.message).toContain('npm install -g mobilecli@latest')
    const missing = deviceId('x')
    const capture = await errorOf(() => context.phoneDevices.startCapture({ deviceId: missing, format: 'mjpeg' }))
    expect(capture.code).toBe('PHONE_UNRESOLVED')
    expect((await errorOf(() => context.phoneDevices.boot(missing))).code).toBe('PHONE_UNRESOLVED')
    expect((await errorOf(() => context.phoneDevices.shutdown(missing))).code).toBe('PHONE_UNRESOLVED')
    expect((await errorOf(() => context.phoneDevices.io({ method: 'tap', deviceId: missing, source: { kind: 'fresh-probe' }, x: 1, y: 1 }))).code)
      .toBe('PHONE_UNRESOLVED')
  })

  it('answers listDevices with grouped Android/iOS listings including offline devices', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const list = await context.phoneDevices.listDevices(AbortSignal.timeout(2_000))
    expect(list.android.map(device => [device.id, device.kind, device.online])).toEqual([
      [ANDROID_EMULATOR, 'emulator', true],
    ])
    expect(list.ios.simulators.map(device => [device.id, device.online])).toEqual([[IOS_SIMULATOR, false]])
    expect(list.ios.reals.map(device => [device.id, device.online])).toEqual([[IOS_REAL, true]])
    expect(list.android[0]?.logicalDisplay).toBeUndefined()
    // Offline entries are present because every listing query sends includeOffline.
    const counters = await fake.counters()
    expect(counters.requests).toBeGreaterThanOrEqual(2)
  })

  it('publishes deltas only after a poll observes a real difference', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const changes: PhoneDeviceChange[] = []
    const unsubscribe = context.phoneDevices.onChanged(change => changes.push(change))

    // Identical reality stays silent across many polls.
    const watermark = (await fake.counters()).requests
    await waitFor(async () => (await fake.counters()).requests > watermark + 3, 4_000)
    expect(changes).toHaveLength(0)

    // Booting the offline simulator upstream flips its online fact.
    await context.phoneDevices.boot(IOS_SIMULATOR)
    await waitFor(() => changes.length >= 1)
    const published = changes[0]
    expect(published?.added).toEqual([])
    expect(published?.removed).toEqual([])
    expect(published?.list.ios.simulators[0]?.online).toBe(true)

    unsubscribe()
    unsubscribe()
  })

  it('contains a throwing subscriber and keeps notifying the rest', async () => {
    const fake = await stageFake({ devices: [wireDevice('SIM-UDID', 'ios', 'simulator', 'offline')] })
    fakes.push(fake)
    const context = await mountWith(fake)
    const healthy: number[] = []
    context.phoneDevices.onChanged(() => {
      throw new Error('observer boom')
    })
    context.phoneDevices.onChanged(() => healthy.push(healthy.length))
    await context.phoneDevices.boot(deviceId('SIM-UDID'))
    await waitFor(() => healthy.length >= 1)
    expect(healthy.length).toBeLessThan(5)
  })

  it('refuses a captured service handle once its fiber is disposed', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices
    await context.fiber.dispose()
    const refused = await errorOf(() => captured.listDevices())
    expect(refused.code).toBe('PHONE_DISPOSED')
  })

  it('reports cancellation arriving during the readiness wait as PHONE_ABORTED', async () => {
    const fake = await stageFake({ hang: true })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    const pending = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      readyTimeoutMs: 400,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    }).await()
    await new Promise(resolveTick => setTimeout(resolveTick, 30))
    const outcome = (await context.phoneDevices.listDevices(laterAbort()).then(
      () => null,
      (error: unknown) => error,
    )) as PhoneDevicesError | null
    expect(outcome?.code).toBe('PHONE_ABORTED')
    const windowed: unknown = await pending.then(() => null, (error: unknown) => error)
    expect((windowed as Error | null)?.message).toMatch(/did not become ready within/)
  })

  it('refuses real-device lifecycle verbs locally and unknown ids before any RPC', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)

    const shutdownRefused = await errorOf(() => context.phoneDevices.shutdown(IOS_REAL))
    expect(shutdownRefused.code).toBe('PHONE_REAL_DEVICE')
    expect((await fake.counters()).shutdownCount).toBe(0)

    const bootRefused = await errorOf(() => context.phoneDevices.boot(IOS_REAL))
    expect(bootRefused.code).toBe('PHONE_REAL_DEVICE')

    const unknown = await errorOf(() => context.phoneDevices.boot(deviceId('emulator-nope')))
    expect(unknown.code).toBe('PHONE_DEVICE_NOT_FOUND')
  })

  it('forwards semantic tap, swipe, text, and button to the loopback JSON-RPC server', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR,
      method: 'tap',
      source: { kind: 'fresh-probe' },
      x: 12,
      y: 34,
    })
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR,
      method: 'swipe',
      source: { kind: 'fresh-probe' },
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
    })
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR,
      method: 'text',
      text: 'hello',
    })
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR,
      method: 'button',
      button: 'HOME',
    })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.tap', params: { deviceId: 'emulator-5554', x: 12, y: 34 } },
      {
        method: 'device.io.swipe',
        params: { deviceId: 'emulator-5554', x1: 1, y1: 2, x2: 3, y2: 4 },
      },
      { method: 'device.io.text', params: { deviceId: 'emulator-5554', text: 'hello' } },
      { method: 'device.io.button', params: { deviceId: 'emulator-5554', button: 'HOME' } },
    ])
  })

  it('scales Android capture-source io onto the listed logical display before RPC', async () => {
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('android-logical')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    expect(vi.mocked(openAndroidSystemH264)).toHaveBeenCalled()
    expect(nativeLaunchDiagnostics()).not.toMatch(/\badb\b|screenrecord/u)
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    })
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'swipe',
      x1: 0, y1: 0, x2: 1_124, y2: 540,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.tap', params: { deviceId: 'emulator-5554', x: 1_124, y: 540 } },
      {
        method: 'device.io.swipe',
        params: { deviceId: 'emulator-5554', x1: 0, y1: 0, x2: 2_248, y2: 1_080 },
      },
    ])
    await reader.cancel()
  })

  it('refuses Android capture-source io whose plane mismatches logical display and still accepts buttons', async () => {
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('android-portrait-plane')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    expect(vi.mocked(openAndroidSystemH264)).toHaveBeenCalled()
    expect(nativeLaunchDiagnostics()).not.toMatch(/\badb\b|screenrecord/u)
    const refused = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 540, y: 1_124,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_080, captureHeight: 2_248,
      },
    }))
    expect(refused.code).toBe('PHONE_PROTOCOL')
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'button', button: 'HOME',
    })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.button', params: { deviceId: 'emulator-5554', button: 'HOME' } },
    ])
    await reader.cancel()
  })

  it('refuses Android capture-source io when logical display is missing', async () => {
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('android-missing-logical')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    const refused = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    }))
    expect(refused.code).toBe('PHONE_PROTOCOL')
    expect((await fake.counters()).io).toEqual([])
    await reader.cancel()
  })

  it('revokes a stale Android capture after logical display replacement', async () => {
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 1080, height: 2248 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('android-stale-capture')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    expect(nativeLaunchDiagnostics()).not.toMatch(/\badb\b|screenrecord/u)
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    await context.phoneDevices.listDevices()
    const refused = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 540, y: 1_124,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_080, captureHeight: 2_248,
      },
    }))
    expect(refused.code).toBe('PHONE_PROTOCOL')
    expect(refused.message).toMatch(/trusted capture evidence is not active/u)
    expect((await fake.counters()).io).toEqual([])
    await reader.cancel()
  })

  it('revokes Android capture when known logical display height changes', async () => {
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('android-height-change')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    expect(nativeLaunchDiagnostics()).not.toMatch(/\badb\b|screenrecord/u)
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1081 })
    await context.phoneDevices.listDevices()
    const refused = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    }))
    expect(refused.code).toBe('PHONE_PROTOCOL')
    expect(refused.message).toMatch(/trusted capture evidence is not active/u)
    expect((await fake.counters()).io).toEqual([])
    await reader.cancel()
  })

  it('leaves a second Android capture active when another device logical display changes', async () => {
    const other = deviceId('emulator-5556')
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    vi.mocked(readAndroidLogicalDisplay).mockImplementation(options => (
      options.deviceId === other ? { width: 1080, height: 1920 } : { width: 2248, height: 1080 }
    ))
    const fake = await stageFake({
      devices: [
        ...BASE_DEVICES,
        wireDevice('emulator-5556', 'android', 'emulator', 'online'),
      ],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const keepId = phoneCaptureId('android-keep-other')
    const staleId = phoneCaptureId('android-stale-one')
    const keep = await context.phoneDevices.startCapture({
      deviceId: other, format: 'h264', captureId: keepId,
    })
    const stale = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId: staleId,
    })
    const keepReader = keep.body.getReader()
    const staleReader = stale.body.getReader()
    vi.mocked(readAndroidLogicalDisplay).mockImplementation(options => (
      options.deviceId === other ? { width: 1080, height: 1920 } : { width: 2248, height: 1081 }
    ))
    await context.phoneDevices.listDevices()
    const refused = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
      source: {
        kind: 'capture', captureId: staleId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    }))
    expect(refused.code).toBe('PHONE_PROTOCOL')
    expect(refused.message).toMatch(/trusted capture evidence is not active/u)
    await context.phoneDevices.io({
      deviceId: other, method: 'tap', x: 270, y: 480,
      source: {
        kind: 'capture', captureId: keepId, captureFormat: 'h264',
        captureWidth: 540, captureHeight: 960,
      },
    })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.tap', params: { deviceId: 'emulator-5556', x: 540, y: 960 } },
    ])
    await keepReader.cancel()
    await staleReader.cancel()
  })

  it.each([
    {
      name: 'A→miss→A',
      restore: { width: 2248, height: 1080 } as const,
      restoreSource: { captureWidth: 1_124, captureHeight: 540, x: 562, y: 270 },
      restoreRpc: { method: 'device.io.tap', params: { deviceId: 'emulator-5554', x: 1_124, y: 540 } },
    },
    {
      name: 'A→miss→B',
      restore: { width: 1080, height: 2248 } as const,
      restoreSource: { captureWidth: 1_080, captureHeight: 2_248, x: 540, y: 1_124 },
      restoreRpc: undefined,
    },
  ])('$name keeps the grant through a miss and restores or revokes by last-known size', async (scenario) => {
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId(`android-${scenario.name}`)
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    expect(vi.mocked(openAndroidSystemH264)).toHaveBeenCalled()
    expect(nativeLaunchDiagnostics()).not.toMatch(/\badb\b|screenrecord/u)
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue(undefined)
    const missing = await context.phoneDevices.listDevices()
    expect(missing.android[0]?.logicalDisplay).toBeUndefined()
    const refusedMissing = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    }))
    expect(refusedMissing.code).toBe('PHONE_PROTOCOL')
    expect(refusedMissing.message).toMatch(/logical display/u)
    expect(refusedMissing.message).not.toMatch(/trusted capture evidence is not active/u)
    expect((await fake.counters()).io).toEqual([])
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue(scenario.restore)
    const restored = await context.phoneDevices.listDevices()
    expect(restored.android[0]?.logicalDisplay).toEqual(scenario.restore)
    if (scenario.restoreRpc === undefined) {
      const refusedBridge = await errorOf(() => context.phoneDevices.io({
        deviceId: ANDROID_EMULATOR, method: 'tap',
        x: scenario.restoreSource.x, y: scenario.restoreSource.y,
        source: {
          kind: 'capture', captureId, captureFormat: 'h264',
          captureWidth: scenario.restoreSource.captureWidth,
          captureHeight: scenario.restoreSource.captureHeight,
        },
      }))
      expect(refusedBridge.code).toBe('PHONE_PROTOCOL')
      expect(refusedBridge.message).toMatch(/trusted capture evidence is not active/u)
      expect((await fake.counters()).io).toEqual([])
      const nextId = phoneCaptureId(`${scenario.name}-B`)
      const nextCapture = await context.phoneDevices.startCapture({
        deviceId: ANDROID_EMULATOR, format: 'h264', captureId: nextId,
      })
      const nextReader = nextCapture.body.getReader()
      await context.phoneDevices.io({
        deviceId: ANDROID_EMULATOR, method: 'tap', x: 540, y: 1_124,
        source: {
          kind: 'capture', captureId: nextId, captureFormat: 'h264',
          captureWidth: 1_080, captureHeight: 2_248,
        },
      })
      expect((await fake.counters()).io).toEqual([
        { method: 'device.io.tap', params: { deviceId: 'emulator-5554', x: 540, y: 1_124 } },
      ])
      await nextReader.cancel()
    } else {
      await context.phoneDevices.io({
        deviceId: ANDROID_EMULATOR, method: 'tap',
        x: scenario.restoreSource.x, y: scenario.restoreSource.y,
        source: {
          kind: 'capture', captureId, captureFormat: 'h264',
          captureWidth: scenario.restoreSource.captureWidth,
          captureHeight: scenario.restoreSource.captureHeight,
        },
      })
      expect((await fake.counters()).io).toEqual([scenario.restoreRpc])
    }
    await reader.cancel()
  })

  it('revokes a portrait capture after dumpsys miss then landscape logical display', async () => {
    vi.mocked(openAndroidSystemH264).mockImplementation(() => syntheticAndroidH264())
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 1080, height: 2248 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('android-portrait-to-landscape')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue(undefined)
    const missing = await context.phoneDevices.listDevices()
    expect(missing.android[0]?.logicalDisplay).toBeUndefined()
    const refusedMissing = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 540, y: 1_124,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_080, captureHeight: 2_248,
      },
    }))
    expect(refusedMissing.code).toBe('PHONE_PROTOCOL')
    expect(refusedMissing.message).toMatch(/logical display/u)
    expect(refusedMissing.message).not.toMatch(/trusted capture evidence is not active/u)
    expect((await fake.counters()).io).toEqual([])
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    await context.phoneDevices.listDevices()
    const refusedOld = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
      source: {
        kind: 'capture', captureId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    }))
    expect(refusedOld.code).toBe('PHONE_PROTOCOL')
    expect(refusedOld.message).toMatch(/trusted capture evidence is not active/u)
    expect((await fake.counters()).io).toEqual([])
    const nextId = phoneCaptureId('android-portrait-to-landscape-B')
    const nextCapture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId: nextId,
    })
    const nextReader = nextCapture.body.getReader()
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
      source: {
        kind: 'capture', captureId: nextId, captureFormat: 'h264',
        captureWidth: 1_124, captureHeight: 540,
      },
    })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.tap', params: { deviceId: 'emulator-5554', x: 1_124, y: 540 } },
    ])
    await nextReader.cancel()
    await reader.cancel()
  })

  it('uses fresh probing when the caller chooses the model coordinate source', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 440, height: 956, scale: 3 },
      }],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 99, y: 660,
    })
    const counters = await fake.counters()
    expect(counters.captures).toContainEqual({ deviceId: 'REAL-UDID', format: 'mjpeg' })
    expect(counters.io).toHaveLength(1)
  })

  it('uses runtime-owned H264 evidence for exact landscape projection', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('h264-current')
    const capture = await context.phoneDevices.startCapture({ deviceId: IOS_REAL, format: 'h264', captureId })
    const reader = capture.body.getReader()
    await context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
      source: { kind: 'capture', captureWidth: 2_622, captureHeight: 1_206, captureId, captureFormat: 'h264', captureRotation: 90 },
    })
    expect((await fake.counters()).io).toEqual([{
      method: 'device.io.swipe', params: { deviceId: 'REAL-UDID', x1: 360, y1: 344, x2: 360, y2: 344 },
    }])
    await reader.cancel()
  })

  it('refuses H264 capture-source io when exact rotation is omitted', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('h264-missing-rotation')
    const capture = await context.phoneDevices.startCapture({ deviceId: IOS_REAL, format: 'h264', captureId })
    const reader = capture.body.getReader()
    try {
      const refused = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'h264',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(refused.code).toBe('PHONE_PROTOCOL')
      expect(refused.message).toBe('H264 capture evidence requires exact rotation')
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel()
    }
  })

  it('keeps unique MJPEG capture observations isolated on one device', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, streamFrameCount: 2, mjpegOrientations: [8, 6] })
    fakes.push(fake)
    const context = await mountWith(fake)
    const leftId = phoneCaptureId('mjpeg-left')
    const rightId = phoneCaptureId('mjpeg-right')
    const left = await context.phoneDevices.startCapture({ deviceId: IOS_REAL, format: 'mjpeg', captureId: leftId })
    const right = await context.phoneDevices.startCapture({ deviceId: IOS_REAL, format: 'mjpeg', captureId: rightId })
    const leftReader = left.body.getReader()
    const rightReader = right.body.getReader()
    await leftReader.read()
    await rightReader.read()
    await context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
      source: { kind: 'capture', captureWidth: 2_622, captureHeight: 1_206, captureId: leftId, captureFormat: 'mjpeg' },
    })
    await leftReader.cancel()
    await context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
      source: { kind: 'capture', captureWidth: 2_622, captureHeight: 1_206, captureId: rightId, captureFormat: 'mjpeg' },
    })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.swipe', params: { deviceId: 'REAL-UDID', x1: 42, y1: 530, x2: 42, y2: 530 } },
      { method: 'device.io.swipe', params: { deviceId: 'REAL-UDID', x1: 360, y1: 344, x2: 360, y2: 344 } },
    ])
    await rightReader.cancel()
  })

  it('delivers a JPEG after iOS listing incarnation change without republishing rotation', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }],
      streamFrameCount: 8,
      mjpegOrientations: [8, 8, 8, 8],
    })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 60_000 })
    const captureId = phoneCaptureId('ios-incarnation-jpeg')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value?.byteLength ?? 0).toBeGreaterThan(0)
      await context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      })
      await fake.setDevices([{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'offline'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }])
      await context.phoneDevices.listDevices()
      const second = await reader.read()
      expect(second.done).toBe(false)
      expect(second.value?.byteLength ?? 0).toBeGreaterThan(0)
      const inactive = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(inactive.code).toBe('PHONE_PROTOCOL')
    } finally {
      await reader.cancel().catch(() => {})
    }
  })

  it('delivers a JPEG after duplicate captureId revision replacement without touching a distinct capture', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      streamFrameCount: 8,
      mjpegOrientations: [8, 8, 8, 8, 8, 8],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const reused = phoneCaptureId('mjpeg-revision')
    const other = phoneCaptureId('mjpeg-distinct')
    const firstCapture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId: reused,
    })
    const otherCapture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId: other,
    })
    const firstReader = firstCapture.body.getReader()
    const otherReader = otherCapture.body.getReader()
    try {
      const first = await firstReader.read()
      expect(first.done).toBe(false)
      expect(first.value?.byteLength ?? 0).toBeGreaterThan(0)
      const otherFirst = await otherReader.read()
      expect(otherFirst.done).toBe(false)
      expect(otherFirst.value?.byteLength ?? 0).toBeGreaterThan(0)
      const secondCapture = await context.phoneDevices.startCapture({
        deviceId: IOS_REAL, format: 'mjpeg', captureId: reused,
      })
      const secondReader = secondCapture.body.getReader()
      try {
        const replaced = await secondReader.read()
        expect(replaced.done).toBe(false)
        expect(replaced.value?.byteLength ?? 0).toBeGreaterThan(0)
        const staleFrame = await firstReader.read()
        expect(staleFrame.done).toBe(false)
        expect(staleFrame.value?.byteLength ?? 0).toBeGreaterThan(0)
        await context.phoneDevices.io({
          deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
          source: {
            kind: 'capture', captureId: other, captureFormat: 'mjpeg',
            captureWidth: 2_622, captureHeight: 1_206,
          },
        })
        await context.phoneDevices.io({
          deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
          source: {
            kind: 'capture', captureId: reused, captureFormat: 'mjpeg',
            captureWidth: 2_622, captureHeight: 1_206,
          },
        })
      } finally {
        await secondReader.cancel().catch(() => {})
      }
    } finally {
      await firstReader.cancel().catch(() => {})
      await otherReader.cancel().catch(() => {})
    }
  })

  it('revokes published MJPEG rotation when a later complete JPEG has no supported EXIF', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      streamFrameCount: 2,
      mjpegOrientations: [8, 2],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('mjpeg-exif-then-none')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value?.byteLength ?? 0).toBeGreaterThan(0)
      await context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      })
      expect((await fake.counters()).io).toEqual([{
        method: 'device.io.swipe',
        params: { deviceId: 'REAL-UDID', x1: 42, y1: 530, x2: 42, y2: 530 },
      }])
      const second = await reader.read()
      expect(second.done).toBe(false)
      expect(second.value?.byteLength ?? 0).toBeGreaterThan(0)
      const unpublished = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(unpublished.code).toBe('PHONE_PROTOCOL')
      expect(unpublished.message).toMatch(/has not published exact rotation/u)
      expect((await fake.counters()).io).toHaveLength(1)
    } finally {
      await reader.cancel()
    }
  })

  it('does not republish MJPEG rotation after generation replacement while the reader is held', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      streamFrameCount: 80,
      mjpegOrientations: [8],
    })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()
    await context.phoneDevices.activateExecutable(fake.executablePath)
    const captureId = phoneCaptureId('mjpeg-stale-generation')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value?.byteLength ?? 0).toBeGreaterThan(0)
      await context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      })
      await context.phoneDevices.deactivate()
      await context.phoneDevices.activateExecutable(fake.executablePath)
      expect(context.phoneDevices.isReady()).toBe(true)
      await reader.read().catch(() => {})
      const refused = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(refused.code).toBe('PHONE_PROTOCOL')
      expect(refused.message).toMatch(/trusted capture evidence is not active/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel().catch(() => {})
    }
  })

  it('drains a finite public MJPEG capture until the body closes', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, streamFrameCount: 1 })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('mjpeg-drain')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      let bytes = 0
      let done = false
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          done = true
          break
        }
        bytes += next.value.byteLength
      }
      expect(bytes).toBeGreaterThan(0)
      expect(done).toBe(true)
      const inactive = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(inactive.code).toBe('PHONE_PROTOCOL')
      expect(inactive.message).toMatch(/trusted capture evidence is not active/u)
    } finally {
      await reader.cancel()
    }
  })

  it('drains a finite public H264 capture until the body closes', async () => {
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('h264-drain')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    try {
      let bytes = 0
      let done = false
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          done = true
          break
        }
        bytes += next.value.byteLength
      }
      expect(bytes).toBeGreaterThan(0)
      expect(done).toBe(true)
      const inactive = await errorOf(() => context.phoneDevices.io({
        deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
        source: {
          kind: 'capture', captureId, captureFormat: 'h264',
          captureWidth: 1_124, captureHeight: 540,
        },
      }))
      expect(inactive.code).toBe('PHONE_PROTOCOL')
      expect(inactive.message).toMatch(/trusted capture evidence is not active/u)
    } finally {
      await reader.cancel()
    }
  })

  it('refuses iOS capture-source io before EXIF rotation is published', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, streamFrameCount: 8 })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('mjpeg-before-exif')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const refused = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(refused.code).toBe('PHONE_PROTOCOL')
      expect(refused.message).toMatch(/has not published exact rotation/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel()
    }
  })

  it('refuses capture-source io after a first MJPEG frame with no supported EXIF', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      streamFrameCount: 2,
      mjpegOrientations: [2],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('mjpeg-first-unsupported-exif')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value?.byteLength ?? 0).toBeGreaterThan(0)
      const unpublished = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(unpublished.code).toBe('PHONE_PROTOCOL')
      expect(unpublished.message).toMatch(/has not published exact rotation/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel()
    }
  })

  it('refuses caller-supplied MJPEG captureRotation', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, streamFrameCount: 2 })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('mjpeg-caller-rotation')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const refused = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206, captureRotation: 90,
        },
      }))
      expect(refused.code).toBe('PHONE_PROTOCOL')
      expect(refused.message).toMatch(/MJPEG rotation is runtime-owned/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel()
    }
  })

  it('rejects a public H264 capture reader when the synthetic body errors', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
        recognizable: boolean
        body: ReadableStream<Uint8Array>
        failure?: Error
      }>
    }
    let pulls = 0
    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(Uint8Array.from([1, 2, 3]))
          return
        }
        controller.error(new Error('synthetic H264 body reset'))
      },
    })
    vi.spyOn(captured, 'inspectAndroidH264').mockResolvedValue({
      recognizable: true,
      body: failingBody,
    })
    const captureId = phoneCaptureId('h264-pull-error')
    const capture = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value?.byteLength ?? 0).toBeGreaterThan(0)
      await expect(reader.read()).rejects.toBeInstanceOf(Error)
      const inactive = await errorOf(() => context.phoneDevices.io({
        deviceId: ANDROID_EMULATOR, method: 'tap', x: 562, y: 270,
        source: {
          kind: 'capture', captureId, captureFormat: 'h264',
          captureWidth: 1_124, captureHeight: 540,
        },
      }))
      expect(inactive.code).toBe('PHONE_PROTOCOL')
      expect(inactive.message).toMatch(/trusted capture evidence is not active/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel().catch(() => {})
    }
  })

  it('rejects a public MJPEG capture reader after the upstream capture socket dies', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, streamFrameCount: 80 })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('mjpeg-pull-error')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value?.byteLength ?? 0).toBeGreaterThan(0)
      const pid = (await (await fetch(`${fake.baseUrl}/__test/pid`)).json() as { pid: number }).pid
      process.kill(pid, 'SIGKILL')
      await waitFor(async () => {
        try {
          await fetch(`${fake.baseUrl}/__test/counters`)
          return false
        } catch {
          return true
        }
      })
      await expect(reader.read()).rejects.toBeInstanceOf(Error)
      const inactive = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      expect(['PHONE_PROTOCOL', 'PHONE_UNAVAILABLE']).toContain(inactive.code)
      if (inactive.code === 'PHONE_PROTOCOL') {
        expect(inactive.message).toMatch(/trusted capture evidence is not active/u)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  })

  it('single-flights a model rotation probe while caller cancellation remains independent', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, screencaptureDelayMs: 100, mjpegOrientations: [8] })
    fakes.push(fake)
    const context = await mountWith(fake)
    const cancelled = new AbortController()
    const first = context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080 }, cancelled.signal)
    const second = context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080 })
    cancelled.abort()
    await expect(first).rejects.toBeInstanceOf(Error)
    await expect(second).resolves.toBeUndefined()
    const counters = await fake.counters()
    expect(counters.captures.filter(capture => capture.deviceId === 'REAL-UDID' && capture.format === 'mjpeg')).toHaveLength(1)
    expect(counters.io).toEqual([{
      method: 'device.io.swipe',
      params: { deviceId: 'REAL-UDID', x1: 42, y1: 530, x2: 42, y2: 530 },
    }])
  })

  it('aborts a pending iOS rotation probe on deactivate and starts a new probe after reactivation', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      screencaptureDelayMs: 400,
      mjpegOrientations: [8],
    })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 60_000 })
    const pending = errorOf(() => context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080,
    }))
    await waitFor(async () => (
      (await fake.counters()).rpc.filter(entry => entry.method === 'device.screencapture').length >= 1
    ))
    const deactivating = context.phoneDevices.deactivate()
    const aborted = await pending
    expect(aborted.code).toBe('PHONE_ABORTED')
    await deactivating
    expect(context.phoneDevices.isReady()).toBe(false)
    await context.phoneDevices.activateExecutable(fake.executablePath)
    await context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080,
    })
    // Replacement child has its own RPC journal; one screencapture proves the
    // aborted probe did not remain a zombie on the new generation.
    expect((await fake.counters()).rpc.filter(entry => entry.method === 'device.screencapture')).toHaveLength(1)
    expect((await fake.counters()).io).toEqual([{
      method: 'device.io.swipe',
      params: { deviceId: 'REAL-UDID', x1: 42, y1: 530, x2: 42, y2: 530 },
    }])
  })

  it('rejects ready-service io cancelled before the request is sent', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    controller.abort(new Error('cancelled before send'))
    const refused = await errorOf(() => context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR, method: 'tap', source: { kind: 'fresh-probe' }, x: 1, y: 1,
    }, controller.signal))
    expect(refused.code).toBe('PHONE_ABORTED')
    expect(refused.message).toMatch(/cancelled before the request was sent/u)
    expect((await fake.counters()).io).toEqual([])
  })

  it('single-flights a failed iOS fresh-probe and allows a later retry', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      mjpegOrientations: [8],
      screencaptureDelayMs: 200,
      failArm: { method: 'device.screencapture', message: 'probe capture refused', remaining: 1 },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const first = errorOf(() => context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080,
    }))
    const second = errorOf(() => context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080,
    }))
    const a = await first
    const b = await second
    expect(a.code).toBe('PHONE_UPSTREAM')
    expect(b.code).toBe('PHONE_UPSTREAM')
    expect(a.message).toMatch(/probe capture refused/u)
    expect(b.message).toMatch(/probe capture refused/u)
    expect((await fake.counters()).io).toEqual([])
    expect((await fake.counters()).rpc.filter(entry => entry.method === 'device.screencapture')).toHaveLength(1)
    await context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080,
    })
    expect((await fake.counters()).rpc.filter(entry => entry.method === 'device.screencapture')).toHaveLength(2)
    expect((await fake.counters()).io).toEqual([{
      method: 'device.io.swipe',
      params: { deviceId: 'REAL-UDID', x1: 42, y1: 530, x2: 42, y2: 530 },
    }])
  })

  it('removes a settled probe before a direct continuation starts the next model action', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080 }).then(async () => {
      await context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080 })
    })
    const counters = await fake.counters()
    expect(counters.captures.filter(capture => capture.deviceId === 'REAL-UDID' && capture.format === 'mjpeg')).toHaveLength(2)
    expect(counters.io).toHaveLength(2)
  })

  it('aborts and joins model probes on generation replacement and disposal', async () => {
    for (const stop of ['replace', 'dispose'] as const) {
      const fake = await stageFake({ devices: BASE_DEVICES, screencaptureDelayMs: 5_000 })
      fakes.push(fake)
      const context = await mountWith(fake)
      const pending = context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1, y: 2 })
      await new Promise(resolve => setTimeout(resolve, 20))
      const stopping = stop === 'replace'
        ? context.phoneDevices.deactivate()
        : context.fiber.dispose()
      await expect(pending).rejects.toMatchObject({ code: stop === 'replace' ? 'PHONE_ABORTED' : 'PHONE_DISPOSED' })
      await expect(stopping).resolves.toBeUndefined()
    }
  })

  it('normalizes iOS screenshot pixels onto device logical points and caches the scale', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'tap',
      source: { kind: 'fresh-probe' },
      x: 984,
      y: 1_228,
    })
    await context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'swipe',
      source: { kind: 'fresh-probe' },
      x1: 3,
      y1: 6,
      x2: 984,
      y2: 1_228,
    })
    await context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'button',
      button: 'HOME',
    })
    expect((await fake.counters())).toMatchObject({
      infoCount: 1,
      io: [
        { method: 'device.io.tap', params: { deviceId: 'REAL-UDID', x: 328, y: 409 } },
        {
          method: 'device.io.swipe',
          params: { deviceId: 'REAL-UDID', x1: 1, y1: 2, x2: 328, y2: 409 },
        },
        { method: 'device.io.button', params: { deviceId: 'REAL-UDID', button: 'HOME' } },
      ],
    })
  })

  it('rejects an invalid iOS device.info screen scale before sending io', async () => {
    const fake = await stageFake({
      devices: [{ ...wireDevice('REAL-UDID', 'ios', 'real', 'online'), screenSize: { width: 402, height: 874, scale: 0 } }],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const failure = await errorOf(() => context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'tap',
      source: { kind: 'fresh-probe' },
      x: 12,
      y: 34,
    }))
    expect(failure.code).toBe('PHONE_PROTOCOL')
    expect(failure.message).toMatch(/screenSize\.scale/u)
    expect((await fake.counters()).io).toEqual([])
  })

  it('keeps chained iOS info and io on one generation and re-queries after replacement', async () => {
    const fake = await stageFake({
      devices: [{ ...wireDevice('REAL-UDID', 'ios', 'real', 'online'), screenSize: { width: 402, height: 874, scale: 3 } }],
      infoDelayMs: 200,
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const staleFailure = errorOf(() => context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 12, y: 18,
    }))
    await waitFor(async () => (await fake.counters()).infoCount === 1)
    await fake.setLaunchDevices([
      { ...wireDevice('REAL-UDID', 'ios', 'real', 'online'), screenSize: { width: 402, height: 874, scale: 2 } },
    ])
    await context.phoneDevices.activateExecutable(fake.executablePath)
    await expect(staleFailure).resolves.toMatchObject({ code: 'PHONE_ABORTED' })

    await context.phoneDevices.io({
      deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 12, y: 18,
    })
    expect((await fake.counters())).toMatchObject({
      infoCount: 1,
      io: [{ method: 'device.io.tap', params: { deviceId: 'REAL-UDID', x: 6, y: 9 } }],
    })
  })

  it('aborts replacement activation after old generation teardown starts and before the new child is ready', async () => {
    const first = await stageFake({ devices: BASE_DEVICES, ignoreTerm: true })
    const second = await stageFake({ devices: BASE_DEVICES, hang: true })
    fakes.push(first, second)
    await first.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: first.port,
    }).await()
    await context.phoneDevices.activateExecutable(first.executablePath)
    expect(context.phoneDevices.isReady()).toBe(true)
    const readiness: boolean[] = []
    context.phoneDevices.onReadinessChanged(ready => readiness.push(ready))
    await second.claim()
    const controller = new AbortController()
    const replacing = context.phoneDevices.activateExecutable(second.executablePath, controller.signal)
    await first.awaitOnline()
    controller.abort(new Error('cancel after old generation teardown'))
    await expect(replacing).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(context.phoneDevices.isReady()).toBe(false)
    expect(readiness).not.toContain(true)
  })

  it('rejects iOS capture-source io when listing removes the device during delayed device.info', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }],
      infoDelayMs: 400,
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('ios-info-stale')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      const inflight = errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 201, y: 437,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 1_206, captureHeight: 2_622,
        },
      }))
      await waitFor(async () => (await fake.counters()).infoCount === 1)
      await fake.setDevices([])
      await context.phoneDevices.listDevices()
      const stale = await inflight
      expect(stale.code).toBe('PHONE_ABORTED')
      expect(stale.message).toMatch(/incarnation changed during screen observation/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel()
    }
  })

  it('authorizes io dispatch with live accessors after coordinate awaits', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }],
      streamFrameCount: 8,
      mjpegOrientations: [8],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('ios-live-authorization')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      vi.mocked(assertIoDispatchAuthority).mockClear()
      await context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      })
      expect(assertIoDispatchAuthority).toHaveBeenCalledOnce()
      const options = vi.mocked(assertIoDispatchAuthority).mock.calls[0]?.[0]
      expect(options?.admittedIncarnation).toEqual(expect.any(Object))
      expect(options?.getCurrentIncarnation()).toBe(options?.admittedIncarnation)
      expect(options?.capture.kind).toBe('capture')
      if (options?.capture.kind === 'capture') {
        expect(options.capture.getCurrent()).toBe(options.capture.admitted)
      }
      expect((await fake.counters()).io).toHaveLength(1)
    } finally {
      await reader.cancel()
    }
  })

  it('rejects capture-source io when the admitted capture is cancelled during delayed device.info', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }],
      infoDelayMs: 400,
      streamFrameCount: 8,
      mjpegOrientations: [8],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captureId = phoneCaptureId('ios-capture-authority')
    const capture = await context.phoneDevices.startCapture({
      deviceId: IOS_REAL, format: 'mjpeg', captureId,
    })
    const reader = capture.body.getReader()
    try {
      const first = await reader.read()
      expect(first.done).toBe(false)
      const inflight = errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', x: 1_590, y: 1_080,
        source: {
          kind: 'capture', captureId, captureFormat: 'mjpeg',
          captureWidth: 2_622, captureHeight: 1_206,
        },
      }))
      await waitFor(async () => (await fake.counters()).infoCount === 1)
      await reader.cancel()
      const stale = await inflight
      expect(stale.code).toBe('PHONE_PROTOCOL')
      expect(stale.message).toMatch(/^capture authority changed before io dispatch$/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      await reader.cancel().catch(() => {})
    }
  })

  it('rejects a queued listDevices when generation replacement wins before admission', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      listDelayMs: 800,
      delaySubsequentDeviceLists: true,
    })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 60_000 })
    expect(context.phoneDevices.isReady()).toBe(true)
    const baselineLists = (await fake.counters()).rpc.filter(entry => entry.method === 'devices.list').length
    const first = context.phoneDevices.listDevices().then(
      list => list,
      (error: unknown) => error,
    )
    const second = context.phoneDevices.listDevices().then(
      list => list,
      (error: unknown) => error,
    )
    await waitFor(async () => (
      (await fake.counters()).rpc.filter(entry => entry.method === 'devices.list').length >= baselineLists + 1
    ))
    await context.phoneDevices.activateExecutable(fake.executablePath)
    const later = await second
    expect(later).toBeInstanceOf(PhoneDevicesError)
    expect((later as PhoneDevicesError).code).toBe('PHONE_ABORTED')
    expect((later as PhoneDevicesError).message).toBe('device listing generation changed before admission')
    const earlier = await first
    if (earlier instanceof PhoneDevicesError) {
      expect(earlier.code).toBe('PHONE_ABORTED')
    }
    expect(context.phoneDevices.isReady()).toBe(true)
    expect((await context.phoneDevices.listDevices()).android[0]?.id).toBe(ANDROID_EMULATOR)
  })

  it('rejects in-flight listDevices when generation replacement wins before publication', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 60_000 })
    const captured = context.phoneDevices as unknown as {
      rpcClient: { call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> }
    }
    const original = captured.rpcClient.call.bind(captured.rpcClient)
    const spy = vi.spyOn(captured.rpcClient, 'call').mockImplementation(async (method, params, signal) => {
      const result = await original(method, params, signal)
      if (method === 'devices.list') {
        void context.phoneDevices.deactivate()
        await Promise.resolve()
        await Promise.resolve()
      }
      return result
    })
    try {
      const result = await errorOf(() => context.phoneDevices.listDevices())
      expect(result.code).toBe('PHONE_ABORTED')
      expect(result.message).toBe('device listing generation changed before publication')
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects a queued listDevices when deactivate aborts the current generation', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 60_000 })
    const queued = context.phoneDevices.listDevices().then(
      list => list,
      (error: unknown) => error,
    )
    const second = context.phoneDevices.listDevices().then(
      list => list,
      (error: unknown) => error,
    )
    await context.phoneDevices.deactivate()
    const later = await second
    expect(later).toBeInstanceOf(PhoneDevicesError)
    expect((later as PhoneDevicesError).code).toBe('PHONE_ABORTED')
    const abortedGeneration = new RegExp(
      'generation (retired before admission|changed before admission|changed before publication)'
      + '|generation was disabled',
      'u',
    )
    expect((later as PhoneDevicesError).message).toMatch(abortedGeneration)
    const first = await queued
    if (first instanceof PhoneDevicesError) {
      expect(first.code).toBe('PHONE_ABORTED')
    } else {
      expect(first).toHaveProperty('android.0.id', ANDROID_EMULATOR)
    }
    await context.phoneDevices.activateExecutable(fake.executablePath)
    expect(context.phoneDevices.isReady()).toBe(true)
    expect((await context.phoneDevices.listDevices()).android[0]?.id).toBe(ANDROID_EMULATOR)
  })

  it('refuses io and capture for ids absent from the latest listing', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const unknownIo = await errorOf(() => context.phoneDevices.io({
      deviceId: deviceId('emulator-nope'),
      method: 'tap',
      source: { kind: 'fresh-probe' },
      x: 0,
      y: 0,
    }))
    expect(unknownIo.code).toBe('PHONE_DEVICE_NOT_FOUND')
    const unknownCapture = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: deviceId('emulator-nope'),
      format: 'mjpeg',
    }))
    expect(unknownCapture.code).toBe('PHONE_DEVICE_NOT_FOUND')
    const unknownShot = await errorOf(() => context.phoneDevices.screenshot(deviceId('emulator-nope')))
    expect(unknownShot.code).toBe('PHONE_DEVICE_NOT_FOUND')
    expect((await fake.counters()).io).toEqual([])
  })

  it('returns a PNG screenshot from one MJPEG capture frame', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const android = await context.phoneDevices.screenshot(ANDROID_EMULATOR)
    expect(android.mediaType).toBe('image/png')
    expect(android.path.startsWith(join(process.env.DSH_HOME ?? '', 'phone', 'screenshots'))).toBe(true)
    const androidBytes = await readFile(android.path)
    expect(androidBytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(pngDimensions(androidBytes)).toEqual({ width: 390, height: 844 })

    const ios = await context.phoneDevices.screenshot(IOS_REAL)
    expect(ios.mediaType).toBe('image/png')
    expect(pngDimensions(await readFile(ios.path))).toEqual({ width: 390, height: 844 })
    expect((await fake.counters()).captures).toEqual([])
  })

  it('maps screenshot fleet errors onto PhoneDevicesError', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      screenshot: { failText: 'screenshot rejected upstream' },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const upstream = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR))
    expect(upstream.code).toBe('PHONE_UPSTREAM')
    expect(upstream.message).toContain('screenshot rejected upstream')
  })

  it('opens MJPEG and H264 capture streams from the loopback screencapture RPC', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const mjpeg = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'mjpeg',
    })
    expect(mjpeg.contentType).toMatch(/multipart\/x-mixed-replace/)
    const { payload } = await firstMjpegFrame(mjpeg.body)
    // Frame-level decodability is pinned structurally by acceptance.spec;
    // this opening-mechanics check only requires a complete SOI…EOI JPEG.
    expect(payload.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
    expect(payload.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true)
    expect(jpegDimensions(payload)).toEqual({ width: 390, height: 844 })
    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    expect(h264.contentType).toMatch(/video\/h264/)
    const h264Reader = h264.body.getReader()
    const h264Chunks: Buffer[] = []
    for (;;) {
      const next = await h264Reader.read()
      if (next.done) break
      h264Chunks.push(Buffer.from(next.value))
    }
    assertRecognizableH264Picture(Buffer.concat(h264Chunks))
  })

  it('keeps Android on H264 when mobilecli AVC fails and system screenrecord is recognizable', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      h264FailureDeviceIds: ['emulator-5554'],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    const native = vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(new ReadableStream({
      start(controller) {
        controller.enqueue(buildGradientH264())
        controller.close()
      },
    }))

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    const bytes = Buffer.from(await new Response(h264.body).arrayBuffer())

    expect(h264.contentType).toBe('video/h264')
    assertRecognizableH264Picture(bytes)
    expect(native).toHaveBeenCalledOnce()
    expect((await fake.counters()).captures).toContainEqual({
      deviceId: 'emulator-5554',
      format: 'avc',
    })
  })

  it('replaces recognizable mobilecli AVC with sized screenrecord when dumpsys is landscape', async () => {
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      openNativeAndroidH264(options: {
        deviceId: string
        signal: AbortSignal
        size?: { readonly width: number; readonly height: number }
      }): ReadableStream<Uint8Array>
    }
    const native = vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(new ReadableStream({
      start(controller) {
        controller.enqueue(buildGradientH264())
        controller.close()
      },
    }))

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    assertRecognizableH264Picture(Buffer.from(await new Response(h264.body).arrayBuffer()))
    expect(native).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: ANDROID_EMULATOR,
      size: { width: 2248, height: 1080 },
    }))
  })

  it('attaches dumpsys logicalDisplay to online Android listing rows', async () => {
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const list = await context.phoneDevices.listDevices()
    expect(list.android[0]?.logicalDisplay).toEqual({ width: 2248, height: 1080 })
    expect(list.ios.reals[0]?.logicalDisplay).toBeUndefined()
  })

  it('skips dumpsys for offline Android listing rows', async () => {
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({
      devices: [
        wireDevice('emulator-5554', 'android', 'emulator', 'offline'),
        wireDevice('SIM-UDID', 'ios', 'simulator', 'offline'),
        wireDevice('REAL-UDID', 'ios', 'real', 'online'),
      ],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    vi.mocked(readAndroidLogicalDisplay).mockClear()
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const list = await context.phoneDevices.listDevices()
    expect(list.android.map(device => [device.id, device.online, device.logicalDisplay])).toEqual([
      [ANDROID_EMULATOR, false, undefined],
    ])
    expect(vi.mocked(readAndroidLogicalDisplay)).not.toHaveBeenCalled()
  })

  it('uses the listed logicalDisplay for screenrecord --size when a live dumpsys miss happens', async () => {
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue({ width: 2248, height: 1080 })
    const fake = await stageFake({
      devices: BASE_DEVICES,
      h264FailureDeviceIds: ['emulator-5554'],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    vi.mocked(readAndroidLogicalDisplay).mockReturnValue(undefined)
    const captured = context.phoneDevices as unknown as {
      openNativeAndroidH264(options: {
        deviceId: string
        signal: AbortSignal
        size?: { readonly width: number; readonly height: number }
      }): ReadableStream<Uint8Array>
    }
    const native = vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(new ReadableStream({
      start(controller) {
        controller.enqueue(buildGradientH264())
        controller.close()
      },
    }))
    await context.phoneDevices.startCapture({ deviceId: ANDROID_EMULATOR, format: 'h264' })
    expect(native).toHaveBeenCalledWith(expect.objectContaining({
      size: { width: 2248, height: 1080 },
    }))
  })

  it('tries native Android H264 when the mobilecli key-unit probe times out', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
        recognizable: boolean
        body: ReadableStream<Uint8Array>
        failure?: Error
      }>
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    const nativeBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.from([4, 5, 6])); controller.close() },
    })
    vi.spyOn(captured, 'inspectAndroidH264')
      .mockRejectedValueOnce(new TimeoutReason('ANDROID_H264_PROBE', 15_000))
      .mockResolvedValueOnce({ recognizable: true, body: nativeBody })
    const native = vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(nativeBody)

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })

    expect(Buffer.from(await new Response(h264.body).arrayBuffer())).toEqual(Buffer.from([4, 5, 6]))
    expect(native).toHaveBeenCalledOnce()
  })

  it('tries native Android H264 when the mobilecli body read fails', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
        recognizable: boolean
        body: ReadableStream<Uint8Array>
        failure?: Error
      }>
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    const nativeBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.from([7])); controller.close() },
    })
    vi.spyOn(captured, 'inspectAndroidH264')
      .mockRejectedValueOnce('mobilecli reader refusal')
      .mockResolvedValueOnce({ recognizable: true, body: nativeBody })
    vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(nativeBody)

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    expect(Buffer.from(await new Response(h264.body).arrayBuffer())).toEqual(Buffer.from([7]))
  })

  it('propagates cancellation that wins during native Android H264 inspection', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    const mobilecliCancel = vi.fn(async () => { throw new Error('mobilecli cleanup refusal') })
    const nativeCancel = vi.fn(async () => {})
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
        recognizable: boolean
        body: ReadableStream<Uint8Array>
        failure?: Error
      }>
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    const mobilecliBody = new ReadableStream<Uint8Array>({ cancel: mobilecliCancel })
    const nativeBody = new ReadableStream<Uint8Array>({ cancel: nativeCancel })
    vi.spyOn(captured, 'inspectAndroidH264')
      .mockResolvedValueOnce({ recognizable: false, body: mobilecliBody, failure: new Error('invalid') })
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException('runtime replaced', 'AbortError'))
        throw controller.signal.reason
      })
    vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(nativeBody)

    const cancelled = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
      signal: controller.signal,
    }))
    expect(cancelled.code).toBe('PHONE_ABORTED')
    expect(nativeCancel).toHaveBeenCalledOnce()
    expect(mobilecliCancel).toHaveBeenCalledOnce()
  })

  it('propagates cancellation that rejects the mobilecli H264 inspection', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<never>
    }
    vi.spyOn(captured, 'inspectAndroidH264').mockImplementation(async () => {
      controller.abort(new DOMException('runtime replaced', 'AbortError'))
      throw controller.signal.reason
    })

    const cancelled = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
      signal: controller.signal,
    }))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })

  it('preserves mobilecli failure bytes when Android system H264 is unavailable', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      h264FailureDeviceIds: ['emulator-5554'],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    vi.spyOn(captured, 'openNativeAndroidH264').mockImplementation(() => {
      throw new PhoneDevicesError('PHONE_UNAVAILABLE', 'adb is absent')
    })

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })

    expect(await new Response(h264.body).text()).toBe('Error: Error 0x80001001')
  })

  it('normalizes cancellation after mobilecli H264 inspection and contains body cleanup failure', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
        recognizable: boolean
        body: ReadableStream<Uint8Array>
        failure?: Error
      }>
    }
    vi.spyOn(captured, 'inspectAndroidH264').mockImplementation(async () => {
      controller.abort(new DOMException('capture replaced', 'AbortError'))
      return {
        recognizable: false,
        body: new ReadableStream({ cancel() { throw new Error('mobilecli cleanup refusal') } }),
        failure: new Error('mobilecli invalid'),
      }
    })

    const cancelled = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
      signal: controller.signal,
    }))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })

  it('contains cleanup failures while preserving bytes after an unrecognizable native H264 stream', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
        recognizable: boolean
        body: ReadableStream<Uint8Array>
        failure?: Error
      }>
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    const mobilecliBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.from([1])); controller.close() },
    })
    const nativeBody = new ReadableStream<Uint8Array>({ cancel() { throw new Error('native source cleanup refusal') } })
    const nativeReplay = new ReadableStream<Uint8Array>({ cancel() { throw new Error('native replay cleanup refusal') } })
    vi.spyOn(captured, 'inspectAndroidH264')
      .mockResolvedValueOnce({ recognizable: false, body: mobilecliBody, failure: new Error('mobilecli invalid') })
      .mockResolvedValueOnce({ recognizable: false, body: nativeReplay })
    vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(nativeBody)

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    expect(Buffer.from(await new Response(h264.body).arrayBuffer())).toEqual(Buffer.from([1]))
  })

  it('keeps native H264 when mobilecli replay cleanup rejects', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
        recognizable: boolean
        body: ReadableStream<Uint8Array>
        failure?: Error
      }>
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    const mobilecliBody = new ReadableStream<Uint8Array>({ cancel() { throw new Error('mobilecli cleanup refusal') } })
    const nativeBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.from([9, 8, 7])); controller.close() },
    })
    vi.spyOn(captured, 'inspectAndroidH264')
      .mockResolvedValueOnce({ recognizable: false, body: mobilecliBody, failure: new Error('mobilecli invalid') })
      .mockResolvedValueOnce({ recognizable: true, body: nativeBody })
    vi.spyOn(captured, 'openNativeAndroidH264').mockReturnValue(nativeBody)

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    expect(Buffer.from(await new Response(h264.body).arrayBuffer())).toEqual(Buffer.from([9, 8, 7]))
  })

  it('preserves renderer fallback when native H264 throws a non-Error value', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      h264FailureDeviceIds: ['emulator-5554'],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      openNativeAndroidH264(options: { deviceId: string; signal: AbortSignal }): ReadableStream<Uint8Array>
    }
    vi.spyOn(captured, 'openNativeAndroidH264').mockImplementation(() => { throw 'adb refusal' })

    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    expect(await new Response(h264.body).text()).toBe('Error: Error 0x80001001')
  })

  it('reports capture cancellation that arrives before the request is sent as PHONE_ABORTED', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'mjpeg',
      signal: controller.signal,
    }))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })

  it('maps a refused capture socket onto PHONE_UNAVAILABLE after readiness', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const pid = (await (await fetch(`${fake.baseUrl}/__test/pid`)).json() as { pid: number }).pid
    process.kill(pid, 'SIGKILL')
    await waitFor(async () => {
      try {
        await fetch(`${fake.baseUrl}/__test/counters`)
        return false
      } catch {
        return true
      }
    })
    const unavailable = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'mjpeg',
    }))
    expect(unavailable.code).toBe('PHONE_UNAVAILABLE')
  })

  it('bounds a hung screencapture with the configured request ceiling', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, screencaptureDelayMs: 1_500 })
    fakes.push(fake)
    const context = await mountWith(fake, { requestTimeoutMs: 80, pollIntervalMs: 60_000 })
    const timedOut = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'mjpeg',
    }))
    expect(timedOut.code).toBe('PHONE_TIMEOUT')
    expect(timedOut.message).toContain('device.screencapture')
  })

  /**
   * Headers already arrived; disable the current generation so the post-header
   * stale check runs bounded capture-body cancel. `stream` is mocked because
   * a real RPC would abort before returning a body.
   */
  function mockStreamBody(
    context: CordisContext,
    body: ReadableStream<Uint8Array>,
  ): { mockRestore(): void } {
    const captured = context.phoneDevices as unknown as {
      rpcClient: { stream(...args: unknown[]): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }> }
    }
    return vi.spyOn(captured.rpcClient, 'stream').mockImplementation(async () => ({
      contentType: 'multipart/x-mixed-replace',
      body,
    }))
  }

  function mockStaleAfterHeaders(
    context: CordisContext,
    body: ReadableStream<Uint8Array>,
  ): { mockRestore(): void } {
    const captured = context.phoneDevices as unknown as {
      rpcClient: { stream(...args: unknown[]): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }> }
    }
    return vi.spyOn(captured.rpcClient, 'stream').mockImplementation(async () => {
      void context.phoneDevices.deactivate()
      await vi.waitFor(() => { expect(context.phoneDevices.isReady()).toBe(false) })
      return { contentType: 'multipart/x-mixed-replace', body }
    })
  }

  it('discards a completed iOS rotation probe after listing incarnation change', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }],
    })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 60_000 })
    const stream = mockStreamBody(context, new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(buildGradientJpeg(0, 8))
      },
      async cancel() {
        await fake.setDevices([{
          ...wireDevice('REAL-UDID', 'ios', 'real', 'offline'),
          screenSize: { width: 402, height: 874, scale: 3 },
        }])
        await context.phoneDevices.listDevices()
      },
    }))
    try {
      const stale = await errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080,
      }))
      expect(stale.code).toBe('PHONE_ABORTED')
      expect(stale.message).toMatch(/stale iOS rotation probe was discarded/u)
      expect((await fake.counters()).io).toEqual([])
    } finally {
      stream.mockRestore()
    }
  })

  it('logs abandoned rotation-probe cleanup after captureCleanupTimeoutMs', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }],
    })
    fakes.push(fake)
    const context = await mountWith(fake, { captureCleanupTimeoutMs: 20, pollIntervalMs: 60_000 })
    let rejectCancel!: (error: unknown) => void
    const cancel = new Promise<void>((_resolve, reject) => { rejectCancel = reject })
    let entered!: () => void
    const began = new Promise<void>((resolve) => { entered = resolve })
    const warnings: unknown[] = []
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation((value: unknown) => { warnings.push(value) })
    const stream = mockStreamBody(context, new ReadableStream<Uint8Array>({
      pull() {
        entered()
        return new Promise<void>(() => {})
      },
      cancel() { return cancel },
    }))
    try {
      const inflight = errorOf(() => context.phoneDevices.io({
        deviceId: IOS_REAL, method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080,
      }))
      await began
      await fake.setDevices([{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'offline'),
        screenSize: { width: 402, height: 874, scale: 3 },
      }])
      await context.phoneDevices.listDevices()
      const stale = await inflight
      expect(stale.code).toBe('PHONE_ABORTED')
      const failure = new Error('late probe cancel failure')
      rejectCancel(failure)
      await vi.waitFor(() => {
        expect(warnings).toContain('phone-runtime: abandoned rotation probe cleanup failed')
        expect(warnings).toContain(failure)
      })
    } finally {
      stream.mockRestore()
      warn.mockRestore()
    }
  })

  it('surfaces a prompt stale-capture cancel rejection and does not log later', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { captureCleanupTimeoutMs: 20, pollIntervalMs: 60_000 })
    const cancel = vi.fn(() => { throw new Error('cancel refused') })
    const warnings: unknown[] = []
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation((value: unknown) => { warnings.push(value) })
    const stream = mockStaleAfterHeaders(context, new ReadableStream<Uint8Array>({ cancel }))
    try {
      await expect(context.phoneDevices.startCapture({
        deviceId: ANDROID_EMULATOR, format: 'mjpeg',
      })).rejects.toThrow('cancel refused')
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(cancel).toHaveBeenCalledOnce()
      expect(warnings).toEqual([])
    } finally {
      stream.mockRestore()
      warn.mockRestore()
    }
  })

  it('completes stale-capture cancel once and refuses later io', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { captureCleanupTimeoutMs: 20, pollIntervalMs: 60_000 })
    const cancel = vi.fn(async () => {})
    const warnings: unknown[] = []
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation((value: unknown) => { warnings.push(value) })
    const stream = mockStaleAfterHeaders(context, new ReadableStream<Uint8Array>({ cancel }))
    try {
      const stale = await errorOf(() => context.phoneDevices.startCapture({
        deviceId: ANDROID_EMULATOR, format: 'mjpeg', captureId: phoneCaptureId('stale-success-cancel'),
      }))
      expect(stale.code).toBe('PHONE_ABORTED')
      expect(stale.message).toMatch(/capture generation changed before publication/u)
      expect(cancel).toHaveBeenCalledOnce()
      expect(warnings).toEqual([])
      const inactive = await errorOf(() => context.phoneDevices.io({
        deviceId: ANDROID_EMULATOR, method: 'tap', x: 1, y: 1,
        source: {
          kind: 'capture',
          captureId: phoneCaptureId('stale-success-cancel'),
          captureFormat: 'mjpeg',
          captureWidth: 390,
          captureHeight: 844,
        },
      }))
      expect(inactive.code).toBe('PHONE_UNRESOLVED')
    } finally {
      stream.mockRestore()
      warn.mockRestore()
    }
  })

  it('bounds a forever-hung stale-capture cancel within captureCleanupTimeoutMs', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { captureCleanupTimeoutMs: 20, pollIntervalMs: 60_000 })
    const stream = mockStaleAfterHeaders(context, new ReadableStream<Uint8Array>({
      cancel() { return new Promise<void>(() => {}) },
    }))
    try {
      const started = Date.now()
      const stale = await errorOf(() => context.phoneDevices.startCapture({
        deviceId: ANDROID_EMULATOR, format: 'mjpeg',
      }))
      expect(stale.code).toBe('PHONE_ABORTED')
      expect(stale.message).toMatch(/generation changed before publication/u)
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      stream.mockRestore()
    }
  })

  it('logs a stale-capture cancel rejection once after bounded abandonment', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { captureCleanupTimeoutMs: 20, pollIntervalMs: 60_000 })
    let rejectCancel!: (error: unknown) => void
    const cancel = new Promise<void>((_resolve, reject) => { rejectCancel = reject })
    const warnings: unknown[] = []
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation((value: unknown) => { warnings.push(value) })
    const stream = mockStaleAfterHeaders(context, new ReadableStream<Uint8Array>({ cancel() { return cancel } }))
    try {
      const stale = await errorOf(() => context.phoneDevices.startCapture({
        deviceId: ANDROID_EMULATOR, format: 'mjpeg',
      }))
      expect(stale.code).toBe('PHONE_ABORTED')
      const failure = new Error('late cancel failure')
      rejectCancel(failure)
      await vi.waitFor(() => { expect(warnings).toEqual([failure]) })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(warnings).toEqual([failure])
    } finally {
      stream.mockRestore()
      warn.mockRestore()
    }
  })

  it('preserves a non-timeout screencapture failure', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      rpcClient: { stream(...args: unknown[]): Promise<unknown> }
    }
    vi.spyOn(captured.rpcClient, 'stream').mockRejectedValue(
      new PhoneDevicesError('PHONE_PROTOCOL', 'capture protocol failed'),
    )
    const failure = await errorOf(() => context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR, format: 'h264',
    }))
    expect(failure.code).toBe('PHONE_PROTOCOL')
  })

  it('boots and shuts simulators down through mobilecli with refreshed listings', async () => {
    const fake = await stageFake({
      devices: [wireDevice('SIM-UDID', 'ios', 'simulator', 'offline')],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    expect((await context.phoneDevices.listDevices()).ios.simulators[0]?.online).toBe(false)
    await context.phoneDevices.boot(IOS_SIMULATOR)
    await waitFor(async () => (await context.phoneDevices.listDevices()).ios.simulators[0]?.online === true)
    expect((await fake.counters()).bootCount).toBe(1)
    await context.phoneDevices.shutdown(IOS_SIMULATOR)
    await waitFor(async () => (await context.phoneDevices.listDevices()).ios.simulators[0]?.online === false)
    expect((await fake.counters()).shutdownCount).toBe(1)
  })

  it('bounds a hung upstream answer with the configured method ceiling', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, listDelayMs: 1_500, listDelayAfterRequests: 2 })
    fakes.push(fake)
    const context = await mountWith(fake, { requestTimeoutMs: 60, pollIntervalMs: 60_000 })
    const timedOut = await errorOf(() => context.phoneDevices.listDevices())
    expect(timedOut.code).toBe('PHONE_TIMEOUT')
    expect(timedOut.message).toContain('"devices.list"')
  })

  it('reports caller cancellation as PHONE_ABORTED', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await errorOf(() => context.phoneDevices.listDevices(controller.signal))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })

  it('keeps a disposal racing an in-flight poll silent and crash-free', async () => {
    // ignoreTerm keeps the child through SIGTERM so the slow reply lands after
    // disposal and exercises the stale-result drop.
    const fake = await stageFake({ devices: BASE_DEVICES, listDelayMs: 500, ignoreTerm: true })
    fakes.push(fake)
    const context = await mountWith(fake, { pollIntervalMs: 100 })
    const captured = context.phoneDevices as unknown as {
      markLost(reason: PhoneDevicesError): void
    }
    const changes: PhoneDeviceChange[] = []
    context.phoneDevices.onChanged(change => changes.push(change))
    // Dispose while the very first poll is still awaiting its slow reply, and
    // pre-halt publication so the late reply must be dropped, not published.
    // Wait for the SECOND poll to be in flight (the first was the baseline).
    await waitFor(async () => (await fake.counters()).requests >= 2)
    await context.fiber.dispose()
    captured.markLost(new PhoneDevicesError('PHONE_PROTOCOL', 'synthetic halt before the slow reply'))
    await new Promise(resolveSettle => setTimeout(resolveSettle, 700))
    await fake.setDevices([]).catch(() => undefined)
    expect(changes).toEqual([])
  })

  it('keeps lifecycle guards idempotent under direct re-entry', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      enqueuePoll(options: { refreshOnly: boolean }): void
      markLost(reason: PhoneDevicesError): void
      teardown(): Promise<void>
    }
    const firstTeardown = captured.teardown()
    expect(captured.teardown()).toBe(firstTeardown)
    await firstTeardown
    await context.fiber.dispose()
    expect(captured.teardown()).toBe(firstTeardown)
    captured.enqueuePoll({ refreshOnly: false })
    captured.markLost(new PhoneDevicesError('PHONE_UNAVAILABLE', 'synthetic second loss'))
    captured.markLost(new PhoneDevicesError('PHONE_UPSTREAM', 'synthetic third loss'))
    expect(captured.teardown()).toBe(firstTeardown)
    await new Promise(resolveSettle => setTimeout(resolveSettle, 30))
  })

  it('halts polling when an externally killed server takes the socket down', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const pidResponse = await fetch(`${fake.baseUrl}/__test/pid`)
    const { pid } = await pidResponse.json() as { pid: number }
    process.kill(pid, 'SIGKILL')
    const unavailable = await errorOf(() => context.phoneDevices.listDevices())
    expect(unavailable.code).toBe('PHONE_UNAVAILABLE')
    expect(unavailable.message).toMatch(/socket is gone|transport failed|exited unexpectedly/)
  })

  it('turns an unexpected child exit into persistent unavailability', async () => {
    // The fake survives readiness, answers the first background poll, then exits.
    const fake = await stageFake({ devices: BASE_DEVICES, exitAfter: 3 })
    fakes.push(fake)
    const context = await mountWith(fake)
    await vi.waitFor(() => { expect(context.phoneDevices.isReady()).toBe(false) })
    const unavailable = await errorOf(() => context.phoneDevices.listDevices())
    expect(unavailable.code).toBe('PHONE_UNAVAILABLE')
    expect(unavailable.message).toMatch(/exited unexpectedly|socket is gone/)
  })

  it('marks the current ready generation lost when its child exit callback settles', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      child: MobilecliServerProcess | undefined
      onChildExit(child: MobilecliServerProcess, exit: { readonly code: number | null }): void
    }
    const child = captured.child
    if (child === undefined) throw new Error('ready phone runtime has no current child')

    captured.onChildExit(child, { code: 73 })

    const unavailable = await errorOf(() => context.phoneDevices.listDevices())
    expect(unavailable).toMatchObject({ code: 'PHONE_UNAVAILABLE' })
    expect(unavailable.message).toContain('exited unexpectedly (code 73)')
  })

  it('does not publish readiness when the first device listing violates the protocol', async () => {
    const fake = await stageFake({ devices: [{ id: 'malformed' }] as never })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    const fiber = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    })
    const outcome = await fiber.await().then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(PhoneDevicesError)
    expect((outcome as PhoneDevicesError).code).toBe('PHONE_PROTOCOL')
  })

  it('fails when the child exits after the baseline listing response but before readiness commits', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, exitAfter: 2 })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    const fiber = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    })
    const outcome = await fiber.await().then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(PhoneDevicesError)
    expect((outcome as PhoneDevicesError).code).toBe('PHONE_UNAVAILABLE')
  })

  it('publishes removals when a ready child is lost', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const changes: PhoneDeviceChange[] = []
    context.phoneDevices.onChanged(change => changes.push(change))
    const pidResponse = await fetch(`${fake.baseUrl}/__test/pid`)
    const { pid } = await pidResponse.json() as { pid: number }
    process.kill(pid, 'SIGKILL')
    await vi.waitFor(() => { expect(context.phoneDevices.isReady()).toBe(false) })
    expect(changes.at(-1)?.removed).toEqual([
      ANDROID_EMULATOR, IOS_SIMULATOR, IOS_REAL,
    ])
    expect(changes.at(-1)?.list).toEqual({
      android: [], ios: { simulators: [], reals: [] },
    })
  })

  it('disposes an unclaimed holder after a bounded identity probe', async () => {
    const fake = await stageFake()
    expect(await fake.answersAt(fake.baseUrl)).toBe(false)
    const first = fake.dispose()
    expect(fake.dispose()).toBe(first)
    await first
  })

  it('cancels a replacement while its child is waiting for readiness', async () => {
    const initial = await stageFake({ devices: BASE_DEVICES })
    const hanging = await stageFake({ hang: true })
    fakes.push(initial, hanging)
    const context = await mountWith(initial)
    const controller = new AbortController()
    const activating = context.phoneDevices.activateExecutable(hanging.executablePath, controller.signal)
    void activating.catch(() => {})
    await hanging.awaitOwnedOnlineAt(initial.baseUrl)
    const startedAt = Date.now()
    controller.abort()
    await expect(activating).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(context.phoneDevices.isReady()).toBe(false)
  })

  it('observes caller cancellation from inside the readiness probe loop', async () => {
    const fake = await stageFake({ hang: true })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()
    const controller = new AbortController()
    const activation = context.phoneDevices.activateExecutable(fake.executablePath, controller.signal)
    await fake.awaitOnline()
    await new Promise(resolveWait => setTimeout(resolveWait, 30))
    controller.abort()
    await expect(activation).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
  })

  it('lets a committed loss and readiness-window expiry win during the stability hold', async () => {
    const lostFake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(lostFake)
    await lostFake.claim()
    const lostContext = new Context()
    contexts.push(lostContext)
    await lostContext.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      readyStabilityMs: 200,
      serverPort: lostFake.port,
    }).await()
    const lostActivation = lostContext.phoneDevices.activateExecutable(lostFake.executablePath)
    await lostFake.awaitOnline()
    await waitFor(async () => (await lostFake.counters()).requests >= 2)
    ;(lostContext.phoneDevices as unknown as { lost?: PhoneDevicesError }).lost =
      new PhoneDevicesError('PHONE_UNAVAILABLE', 'lost during readiness hold')
    await expect(lostActivation).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })

    const timeoutFake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(timeoutFake)
    await timeoutFake.claim()
    const timeoutContext = new Context()
    contexts.push(timeoutContext)
    await timeoutContext.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      readyTimeoutMs: 1_000,
      readyStabilityMs: 1_500,
      serverPort: timeoutFake.port,
    }).await()
    await expect(timeoutContext.phoneDevices.activateExecutable(timeoutFake.executablePath))
      .rejects.toMatchObject({ code: 'PHONE_TIMEOUT' })
  })

  it('normalizes an unexpected startup exception as a protocol failure', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()
    const captured = context.phoneDevices as unknown as {
      pollAttempt(required?: boolean, signal?: AbortSignal): Promise<void>
    }
    captured.pollAttempt = async () => { throw 'unexpected startup value' }
    await expect(context.phoneDevices.activateExecutable(fake.executablePath))
      .rejects.toMatchObject({ code: 'PHONE_PROTOCOL' })
  })

  it('preserves the startup failure when process-tree cleanup also fails', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()
    const captured = context.phoneDevices as unknown as {
      pollAttempt(required?: boolean, signal?: AbortSignal): Promise<void>
    }
    captured.pollAttempt = async () => {
      throw new PhoneDevicesError('PHONE_TIMEOUT', 'startup listing timed out')
    }
    const descriptor = Object.getOwnPropertyDescriptor(MobilecliProcessTree.prototype, 'stop')
    if (typeof descriptor?.value !== 'function') throw new Error('server stop method is unavailable')
    const originalStop = descriptor.value as (this: MobilecliServerProcess) => Promise<void>
    const stop = vi.spyOn(MobilecliServerProcess.prototype, 'stop').mockImplementation(async function (this: MobilecliServerProcess) {
      await originalStop.call(this)
      throw new Error('startup cleanup refused')
    })
    try {
      const failure = await errorOf(() => context.phoneDevices.activateExecutable(fake.executablePath))
      expect(failure.code).toBe('PHONE_TIMEOUT')
      expect(failure.message).toContain('startup cleanup refused')
      expect(failure.cause).toBeInstanceOf(AggregateError)
    } finally {
      stop.mockRestore()
    }
  })

  it('halts after a malformed background listing', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await fake.setDevices([{ id: 'malformed' }])
    await vi.waitFor(() => { expect(context.phoneDevices.isReady()).toBe(false) })
    await expect(context.phoneDevices.listDevices()).rejects.toMatchObject({ code: 'PHONE_PROTOCOL' })
  })

  it('keeps the last listing after a retryable background poll miss', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const warnings: unknown[] = []
    vi.spyOn(context.logger, 'warn').mockImplementation((value: unknown) => { warnings.push(value) })
    const captured = context.phoneDevices as unknown as {
      acquireAndPublishDevicesNow(): Promise<PhoneDeviceList>
      pollAttempt(required?: boolean, signal?: AbortSignal): Promise<void>
    }
    vi.spyOn(captured, 'acquireAndPublishDevicesNow')
      .mockRejectedValueOnce(new PhoneDevicesError('PHONE_TIMEOUT', 'temporary miss'))
    await captured.pollAttempt()
    expect(context.phoneDevices.isReady()).toBe(true)
    expect(warnings).toContain('phone-runtime: device poll missed (PHONE_TIMEOUT); keeping the last listing')
  })

  it.each([false, true])('rejects an initial listing refused by publication (pre-lost: %s)', async (preLost) => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()
    const captured = context.phoneDevices as unknown as {
      lost?: PhoneDevicesError
      publish(change: PhoneDeviceChange): boolean
    }
    captured.publish = () => {
      if (preLost) captured.lost = new PhoneDevicesError('PHONE_UNAVAILABLE', 'publisher stopped')
      return false
    }
    await expect(context.phoneDevices.activateExecutable(fake.executablePath)).rejects.toMatchObject({
      code: preLost ? 'PHONE_UNAVAILABLE' : 'PHONE_PROTOCOL',
    })
  })

  it('contains lost-child stop failure and readiness subscriber failure', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const warnings: unknown[] = []
    vi.spyOn(context.logger, 'warn').mockImplementation((value: unknown) => { warnings.push(value) })
    const survivor = vi.fn()
    context.phoneDevices.onReadinessChanged(() => { throw new Error('bad readiness observer') })
    context.phoneDevices.onReadinessChanged(survivor)
    const captured = context.phoneDevices as unknown as {
      child?: { stop(): Promise<void> }
      markLost(reason: PhoneDevicesError): void
    }
    const child = captured.child
    if (child === undefined) throw new Error('ready runtime did not retain its child')
    const originalStop = child.stop.bind(child)
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockImplementationOnce(originalStop)
    child.stop = stop
    captured.markLost(new PhoneDevicesError('PHONE_UNAVAILABLE', 'synthetic loss'))
    await vi.waitFor(() => {
      expect(warnings).toContain('phone-runtime: failed to stop the lost mobilecli child')
    })
    expect(warnings).toContain('phone-runtime: a readiness observer failed')
    expect(survivor).toHaveBeenCalledWith(false)
    await context.fiber.dispose()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('records teardown stop failure on the activation tail', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as { child?: { stop(): Promise<void> } }
    if (captured.child === undefined) throw new Error('ready runtime did not retain its child')
    const originalStop = captured.child.stop.bind(captured.child)
    const stop = vi.fn(async () => { throw new Error('teardown stop failed') })
    captured.child.stop = stop
    await context.fiber.dispose()
    expect(stop).toHaveBeenCalledOnce()
    await originalStop()
  })

  it('retains a generation after failed deactivation so teardown can retry it', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      child?: { stop(): Promise<void> }
      deactivate(): Promise<void>
    }
    const child = captured.child
    if (child === undefined) throw new Error('ready runtime did not retain its child')
    const originalStop = child.stop.bind(child)
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic stop refusal'))
      .mockImplementationOnce(originalStop)
    child.stop = stop

    await expect(captured.deactivate()).rejects.toThrow('synthetic stop refusal')
    expect(captured.child).toBe(child)
    await captured.deactivate()
    expect(captured.child).toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('does not clear a replacement generation committed while an earlier stop settles', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const captured = context.phoneDevices as unknown as {
      child: { stop(): Promise<void> } | undefined
      stopRuntime(reason: PhoneDevicesError): Promise<void>
    }
    const child = captured.child
    if (child === undefined) throw new Error('ready runtime did not retain its child')
    const replacement = { stop: vi.fn(async () => {}) }
    const originalStop = child.stop.bind(child)
    child.stop = vi.fn(async () => {
      await originalStop()
      captured.child = replacement
    })

    await captured.stopRuntime(new PhoneDevicesError('PHONE_ABORTED', 'synthetic replacement'))
    expect(captured.child).toBe(replacement)
    captured.child = undefined
  })

  it('drains a replacement racing service disposal without leaving a child', async () => {
    const fake = await stageFake({ hang: true })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      deferStart: true,
      serverPort: fake.port,
    }).await()
    const activating = context.phoneDevices.activateExecutable(fake.executablePath)
    const disposing = context.fiber.dispose()
    await expect(activating).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await disposing
    await expect(fetch(`${fake.baseUrl}/__test/pid`)).rejects.toThrow()
  })

  it('fails initialization loudly when the server exits before answering readiness', async () => {
    const fake = await stageFake({ devices: [], exitFast: true })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    const failure = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    })
    const outcome: unknown = await failure.await().then(() => null, (error: unknown) => error)
    expect((outcome as Error | null)?.message).toMatch(/exited before becoming ready/)
  })

  it('fails initialization loudly when the server never answers within its window', async () => {
    const fake = await stageFake({ hang: true })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    const failure = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      readyTimeoutMs: 120,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    })
    const windowed: unknown = await failure.await().then(() => null, (error: unknown) => error)
    expect((windowed as Error | null)?.message).toMatch(/did not become ready within/)
  })

  it('disposes to child-exit quiescence, silences subscribers, and refuses later operations', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const pidResponse = await fetch(`${fake.baseUrl}/__test/pid`)
    const { pid } = await pidResponse.json() as { pid: number }
    try {
      process.kill(pid, 0)
    } catch {
      throw new Error('fake should be alive before disposal')
    }
    const changes: PhoneDeviceChange[] = []
    context.phoneDevices.onChanged(change => changes.push(change))
    await context.fiber.dispose()
    await waitFor(async () => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 6_000)
    // Disposal unregisters the Service; the ctx key answers nothing at all.
    expect(context.phoneDevices).toBeUndefined()
    await fake.setDevices([]).catch(() => undefined)
    await new Promise(resolveSettle => setTimeout(resolveSettle, 80))
    expect(changes).toEqual([])
  })

  it('accepts ports and intervals only inside their validated ranges', async () => {
    const badPort = new Context()
    contexts.push(badPort)
    await expect(badPort.plugin(PhoneDevices, { ...FAST_CONFIG, serverPort: 0 }).await())
      .rejects.toThrow(/serverPort/)

    const badInterval = new Context()
    contexts.push(badInterval)
    await expect(badInterval.plugin(PhoneDevices, { ...FAST_CONFIG, pollIntervalMs: -5 }).await())
      .rejects.toThrow(/pollIntervalMs/)

    const badStability = new Context()
    contexts.push(badStability)
    await expect(badStability.plugin(PhoneDevices, { ...FAST_CONFIG, readyStabilityMs: 0 }).await())
      .rejects.toThrow(/readyStabilityMs/)
  })
})
