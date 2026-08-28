import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import type { PhoneDeviceChange } from '@deepseek-ai/dsh-phone-runtime'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { MobilecliServerProcess } from '../src/server-process.ts'
import { stageFake, wireDevice } from './helpers.ts'

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
  fake.claim()
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
  it('searches PATH and fails composition with install guidance when absent', async () => {
    const context = new Context()
    contexts.push(context)
    const previousPath = process.env.PATH
    process.env.PATH = ''
    let message: string | undefined
    try {
      await context.plugin(PhoneDevices, { ...FAST_CONFIG }).await()
    } catch (error) {
      message = (error as Error).message
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
    expect(message).toContain('npm install -g mobilecli@latest')
    expect(message).toContain('(PATH is empty)')
  })

  it('refuses lifecycle verbs that arrive before the first baseline exists', async () => {
    const fake = await stageFake({ hang: true })
    fakes.push(fake)
    fake.claim()
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
    fake.claim()
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

  it('fails composition loudly when the mobilecli executable cannot be resolved', async () => {
    const context = new Context()
    contexts.push(context)
    const first = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: '/no-such-directory/mobilecli',
    })
    void Promise.resolve(first).catch(() => undefined)
    await expect(first.await()).rejects.toThrow(/executablePath.*not an executable file/s)
    // The failed plugin unloaded its Service registration with the fiber.
    const second = context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: '/no-such-directory/mobilecli',
    })
    void Promise.resolve(second).catch(() => undefined)
    await expect(second.await()).rejects.toThrow(/not an executable file/)
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
    fake.claim()
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
    const mjpegReader = mjpeg.body.getReader()
    const mjpegBytes = Buffer.from((await mjpegReader.read()).value ?? new Uint8Array())
    expect(mjpegBytes.includes(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true)
    await mjpegReader.cancel()
    const h264 = await context.phoneDevices.startCapture({
      deviceId: ANDROID_EMULATOR,
      format: 'h264',
    })
    expect(h264.contentType).toMatch(/video\/h264/)
    const h264Reader = h264.body.getReader()
    const h264Bytes = Buffer.from((await h264Reader.read()).value ?? new Uint8Array())
    expect(h264Bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x00, 0x01]))).toBe(true)
    await h264Reader.cancel()
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
    const fake = await stageFake({ devices: BASE_DEVICES, listDelayMs: 1_500 })
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
    // The fake answers the readiness probe and the baseline listing, then exits.
    const fake = await stageFake({ devices: BASE_DEVICES, exitAfter: 2 })
    fakes.push(fake)
    const context = await mountWith(fake)
    await new Promise(resolveSettle => setTimeout(resolveSettle, 200))
    const unavailable = await errorOf(() => context.phoneDevices.listDevices())
    expect(unavailable.code).toBe('PHONE_UNAVAILABLE')
    expect(unavailable.message).toMatch(/exited unexpectedly|socket is gone/)
  })

  it('fails initialization loudly when the server exits before answering readiness', async () => {
    const fake = await stageFake({ devices: [], exitFast: true })
    fakes.push(fake)
    fake.claim()
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
    fake.claim()
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
  })
})
