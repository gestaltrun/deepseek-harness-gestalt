import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import { PhoneDevicesError } from '../src/errors.ts'
import { runMobilecliScreenshot } from '../src/screenshot-process.ts'
import { persistPhoneScreenshot } from '../src/screenshot-store.ts'
import { isPng } from '../src/png.ts'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { MobilecliProcessTree, MobilecliServerProcess } from '../src/server-process.ts'
import { pngDimensions, PNG_SIGNATURE, stageFake, wireDevice } from './helpers.ts'
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const contexts: CordisContext[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []
const homes: string[] = []
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-phone-shot-home-'))
  homes.push(home)
  process.env.DSH_HOME = home
})

afterEach(async () => {
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
const IOS_REAL = deviceId('REAL-UDID')

const BASE_DEVICES = [
  wireDevice('emulator-5554', 'android', 'emulator', 'online'),
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
  await context.plugin(PhoneDevices, {
    ...FAST_CONFIG,
    executablePath: fake.executablePath,
    serverPort: fake.port,
    ...overrides,
  }).await()
  return context
}

describe('phone runtime PNG screenshot', () => {
  it('classifies a locked-device screenshot onto the structured arm', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      screenshot: { failText: 'the device is locked; unlock it and try again' },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const locked = await errorOf(() => context.phoneDevices.screenshot(IOS_REAL))
    expect(locked.code).toBe('PHONE_REAL_DEVICE_ISSUE')
    expect(locked.issue).toBe('device-locked')
  })

  it('keeps a missing screenshot file a protocol failure', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, screenshot: { output: 'missing' } })
    fakes.push(fake)
    const context = await mountWith(fake)
    const missing = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR))
    expect(missing.code).toBe('PHONE_PROTOCOL')
  })

  it('keeps a non-PNG screenshot answer a protocol failure', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await fake.setScreenshot({ output: 'not-png' })
    const protocol = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR))
    expect(protocol.code).toBe('PHONE_PROTOCOL')
  })

  it('reports a vanished executable as PHONE_UNAVAILABLE', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await rename(fake.executablePath, `${fake.executablePath}.moved`)
    const vanished = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR))
    expect(vanished.code).toBe('PHONE_UNAVAILABLE')
    expect(vanished.message).toContain('could not start')
  })

  it('reports caller abort during a hung screenshot as PHONE_ABORTED', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, screenshot: { delayMs: 2_000 } })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 100)
    const cancelled = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR, controller.signal))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })

  it('reports pre-aborted screenshot operations as PHONE_ABORTED', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR, controller.signal))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })

  it('bounds a hung screenshot with the configured request ceiling', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, screenshot: { delayMs: 6_000 } })
    fakes.push(fake)
    const context = await mountWith(fake, { requestTimeoutMs: 300 })
    const timedOut = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR))
    expect(timedOut.code).toBe('PHONE_TIMEOUT')
    expect(timedOut.message).toContain('screenshot')
  })

  it.each([
    new Error('tree cleanup refused'),
    'non-error tree cleanup refusal',
  ])('preserves timeout while surfacing process-tree cleanup failure (%s)', async (failure) => {
    const fake = await stageFake({ screenshot: { delayMs: 5_000 } })
    fakes.push(fake)
    const descriptor = Object.getOwnPropertyDescriptor(MobilecliProcessTree.prototype, 'stop')
    if (typeof descriptor?.value !== 'function') throw new Error('process-tree stop method is unavailable')
    const originalStop = descriptor.value as (this: MobilecliProcessTree) => Promise<void>
    const stop = vi.spyOn(MobilecliProcessTree.prototype, 'stop').mockImplementation(async function (this: MobilecliProcessTree) {
      await originalStop.call(this)
      throw failure
    })
    try {
      const rejected = await errorOf(() => runMobilecliScreenshot({
        executablePath: fake.executablePath,
        deviceId: 'emulator-5554',
        signal: undefined,
        timeoutMs: 100,
      }))
      expect(rejected.code).toBe('PHONE_TIMEOUT')
      expect(rejected.message).toContain(failure instanceof Error ? failure.message : failure)
      expect(rejected.cause).toBeInstanceOf(AggregateError)
    } finally {
      stop.mockRestore()
    }
  })

  it('maps a missing-device screenshot CLI failure onto PHONE_DEVICE_NOT_FOUND', async () => {
    const fake = await stageFake({ devices: [] })
    fakes.push(fake)
    const missing = await errorOf(() => runMobilecliScreenshot({
      executablePath: fake.executablePath,
      deviceId: 'emulator-5554',
      signal: undefined,
      timeoutMs: 2_000,
    }))
    expect(missing.code).toBe('PHONE_DEVICE_NOT_FOUND')
  })

  it('keeps an unclassified nonzero screenshot failure on PHONE_UPSTREAM', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      screenshot: { failText: 'upstream screenshot failed without a known device arm' },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const upstream = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR))
    expect(upstream.code).toBe('PHONE_UPSTREAM')
  })

  it('keeps an empty nonzero screenshot failure on PHONE_UPSTREAM', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      screenshot: { failText: '' },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const upstream = await errorOf(() => context.phoneDevices.screenshot(ANDROID_EMULATOR))
    expect(upstream.code).toBe('PHONE_UPSTREAM')
    expect(upstream.message).toContain('(no output)')
  })

  it('persists a PNG under $DSH_HOME/phone/screenshots with owner-only modes', async () => {
    const path = await persistPhoneScreenshot('emulator-5554', PNG_SIGNATURE)
    expect(path.startsWith(join(process.env.DSH_HOME ?? '', 'phone', 'screenshots'))).toBe(true)
    expect(path).toMatch(/emulator-5554-\d+-[0-9a-f]+\.png$/u)
    expect(await readFile(path)).toEqual(Buffer.from(PNG_SIGNATURE))
    if (process.platform !== 'win32') {
      expect((await stat(join(process.env.DSH_HOME ?? '', 'phone', 'screenshots'))).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps unsafe device ids inside phone/screenshots', async () => {
    const path = await persistPhoneScreenshot('../a b:c', PNG_SIGNATURE)
    expect(path.startsWith(join(process.env.DSH_HOME ?? '', 'phone', 'screenshots'))).toBe(true)
    expect(path).toMatch(/\.\._a_b_c-\d+-[0-9a-f]+\.png$/u)
  })

  it('uses a fallback file-name fragment for an empty device id', async () => {
    const path = await persistPhoneScreenshot('', PNG_SIGNATURE)
    expect(path.startsWith(join(process.env.DSH_HOME ?? '', 'phone', 'screenshots'))).toBe(true)
    expect(path).toMatch(/device-\d+-[0-9a-f]+\.png$/u)
  })

  it('maps a screenshot persist failure onto PHONE_PROTOCOL', async () => {
    const blocked = process.env.DSH_HOME
    if (blocked === undefined) throw new Error('expected DSH_HOME to be pinned')
    await rm(blocked, { recursive: true, force: true })
    await writeFile(blocked, 'not-a-directory')
    const rejected = await errorOf(() => persistPhoneScreenshot('emulator-5554', PNG_SIGNATURE))
    expect(rejected.code).toBe('PHONE_PROTOCOL')
    expect(rejected.message).toContain('could not persist')
  })

  it('returns PNG bytes from the screenshot command itself', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const png = await runMobilecliScreenshot({
      executablePath: fake.executablePath,
      deviceId: 'emulator-5554',
      signal: undefined,
      timeoutMs: 2_000,
    })
    expect(isPng(png)).toBe(true)
    expect(Buffer.from(png).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(pngDimensions(Buffer.from(png))).toEqual({ width: 390, height: 844 })
  })
})
