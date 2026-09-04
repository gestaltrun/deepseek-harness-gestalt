import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import type { DeviceId, PhoneDeviceChange } from '@deepseek-ai/dsh-phone-runtime'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { MobilecliProcessTree, MobilecliServerProcess } from '../src/server-process.ts'
import { assertRecognizableH264Picture, firstMjpegFrame, jpegDimensions, pngDimensions, PNG_SIGNATURE, stageFake, wireDevice } from './helpers.ts'
import { buildGradientH264 } from './fixtures/u3-visible-frames.ts'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAndroidLogicalDisplay } from '../src/android-display.ts'

vi.mock('../src/android-display.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/android-display.ts')>()
  return {
    ...actual,
    readAndroidLogicalDisplay: vi.fn(() => undefined),
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
    expect((await errorOf(() => context.phoneDevices.io({ method: 'tap', deviceId: missing, x: 1, y: 1 }))).code)
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

  it('forwards io tap, gesture, text, and button to the loopback JSON-RPC server', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR,
      method: 'tap',
      x: 12,
      y: 34,
    })
    await context.phoneDevices.io({
      deviceId: ANDROID_EMULATOR,
      method: 'gesture',
      actions: [{ type: 'pointerDown', x: 1, y: 2 }],
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
        method: 'device.io.gesture',
        params: { deviceId: 'emulator-5554', actions: [{ type: 'pointerDown', x: 1, y: 2 }] },
      },
      { method: 'device.io.text', params: { deviceId: 'emulator-5554', text: 'hello' } },
      { method: 'device.io.button', params: { deviceId: 'emulator-5554', button: 'HOME' } },
    ])
  })

  it('maps landscape iOS capture pixels onto swapped WDA bounds from sticky portrait screenSize', async () => {
    const fake = await stageFake({
      devices: [{
        ...wireDevice('REAL-UDID', 'ios', 'real', 'online'),
        screenSize: { width: 440, height: 956, scale: 3 },
      }],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'tap',
      x: 99,
      y: 660,
      captureWidth: 2_868,
      captureHeight: 1_320,
    })
    await context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'tap',
      x: 2_868,
      y: 660,
      captureWidth: 2_868,
      captureHeight: 1_320,
    })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.tap', params: { deviceId: 'REAL-UDID', x: 33, y: 220 } },
      { method: 'device.io.tap', params: { deviceId: 'REAL-UDID', x: 956, y: 220 } },
    ])
  })

  it('normalizes iOS screenshot pixels onto device logical points and caches the scale', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'tap',
      x: 984,
      y: 1_228,
    })
    await context.phoneDevices.io({
      deviceId: IOS_REAL,
      method: 'gesture',
      actions: [
        { type: 'pointerDown', x: 3, y: 6, pressure: 0.5 },
        { type: 'pointerUp', x: 984, y: 1_228 },
      ],
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
          method: 'device.io.gesture',
          params: {
            deviceId: 'REAL-UDID',
            actions: [
              { type: 'pointerDown', x: 1, y: 2, pressure: 0.5 },
              { type: 'pointerUp', x: 328, y: 409 },
            ],
          },
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
    const staleFailure = errorOf(() => context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', x: 12, y: 18 }))
    await waitFor(async () => (await fake.counters()).infoCount === 1)
    await fake.setLaunchDevices([
      { ...wireDevice('REAL-UDID', 'ios', 'real', 'online'), screenSize: { width: 402, height: 874, scale: 2 } },
    ])
    await context.phoneDevices.activateExecutable(fake.executablePath)
    await expect(staleFailure).resolves.toMatchObject({ code: 'PHONE_ABORTED' })

    await context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', x: 12, y: 18 })
    expect((await fake.counters())).toMatchObject({
      infoCount: 1,
      io: [{ method: 'device.io.tap', params: { deviceId: 'REAL-UDID', x: 6, y: 9 } }],
    })
  })

  it('refuses io and capture for ids absent from the latest listing', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const unknownIo = await errorOf(() => context.phoneDevices.io({
      deviceId: deviceId('emulator-nope'),
      method: 'tap',
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
      preferAndroidH264(
        capture: { contentType: string; body: ReadableStream<Uint8Array> },
        id: DeviceId,
        signal: AbortSignal,
      ): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }>
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

    const cancelled = await errorOf(() => captured.preferAndroidH264({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>(),
    }, ANDROID_EMULATOR, controller.signal))
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
      preferAndroidH264(
        capture: { contentType: string; body: ReadableStream<Uint8Array> },
        id: DeviceId,
        signal: AbortSignal,
      ): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }>
      inspectAndroidH264(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<never>
    }
    vi.spyOn(captured, 'inspectAndroidH264').mockImplementation(async () => {
      controller.abort(new DOMException('runtime replaced', 'AbortError'))
      throw controller.signal.reason
    })

    const cancelled = await errorOf(() => captured.preferAndroidH264({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>(),
    }, ANDROID_EMULATOR, controller.signal))
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
      preferAndroidH264(
        capture: { contentType: string; body: ReadableStream<Uint8Array> },
        id: DeviceId,
        signal: AbortSignal,
      ): Promise<{ contentType: string; body: ReadableStream<Uint8Array> }>
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

    const cancelled = await errorOf(() => captured.preferAndroidH264({
      contentType: 'video/h264',
      body: new ReadableStream<Uint8Array>(),
    }, ANDROID_EMULATOR, controller.signal))
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
      teardown(): void | Promise<void>
    }
    await context.fiber.dispose()
    // Re-entering the private lifecycle entrypoints after disposal must be a
    // silence-preserving no-op for each guard.
    captured.enqueuePoll({ refreshOnly: false })
    captured.markLost(new PhoneDevicesError('PHONE_UNAVAILABLE', 'synthetic second loss'))
    captured.markLost(new PhoneDevicesError('PHONE_UPSTREAM', 'synthetic third loss'))
    const secondTeardown = captured.teardown()
    expect(secondTeardown).toBeUndefined()
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

  it('cancels a replacement while its child is waiting for readiness', async () => {
    const initial = await stageFake({ devices: BASE_DEVICES })
    const hanging = await stageFake({ hang: true })
    fakes.push(initial, hanging)
    const context = await mountWith(initial)
    const controller = new AbortController()
    const startedAt = Date.now()
    const activating = context.phoneDevices.activateExecutable(hanging.executablePath, controller.signal)
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
      roundTrip(): Promise<unknown>
      pollAttempt(required?: boolean, signal?: AbortSignal): Promise<void>
    }
    captured.roundTrip = async () => { throw new PhoneDevicesError('PHONE_TIMEOUT', 'temporary miss') }
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
    if (captured.child === undefined) throw new Error('ready runtime did not retain its child')
    captured.child.stop = vi.fn(async () => { throw new Error('stop failed') })
    captured.markLost(new PhoneDevicesError('PHONE_UNAVAILABLE', 'synthetic loss'))
    await vi.waitFor(() => {
      expect(warnings).toContain('phone-runtime: failed to stop the lost mobilecli child')
    })
    expect(warnings).toContain('phone-runtime: a readiness observer failed')
    expect(survivor).toHaveBeenCalledWith(false)
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
