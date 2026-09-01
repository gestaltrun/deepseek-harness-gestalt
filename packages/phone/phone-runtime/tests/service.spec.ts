import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import type { PhoneDeviceChange } from '@deepseek-ai/dsh-phone-runtime'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { MobilecliServerProcess } from '../src/server-process.ts'
import { assertRecognizableH264Picture, firstMjpegFrame, jpegDimensions, stageFake, wireDevice } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const contexts: CordisContext[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  console.error('child diagnostics:', MobilecliServerProcess.diagnostics.splice(0))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
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
    expect((await fake.counters()).io).toEqual([])
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
