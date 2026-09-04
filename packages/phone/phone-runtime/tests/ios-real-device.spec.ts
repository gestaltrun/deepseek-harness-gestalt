import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import { PhoneDevicesError } from '../src/errors.ts'
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

const IOS_REAL = deviceId('REAL-UDID')

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

async function errorOf(run: () => Promise<unknown>): Promise<PhoneDevicesError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PhoneDevicesError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
}

describe('phone runtime iOS real-device link', () => {
  it('publishes real-group online transitions through the reals group', async () => {
    const fake = await stageFake({
      devices: [wireDevice('REAL-UDID', 'ios', 'real', 'offline')],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const changes: PhoneDeviceChange[] = []
    context.phoneDevices.onChanged(change => changes.push(change))
    await fake.setDevices([wireDevice('REAL-UDID', 'ios', 'real', 'online')])
    await waitFor(() => changes.length >= 1)
    const change = changes[0]
    expect(change?.added).toEqual([])
    expect(change?.removed).toEqual([])
    expect(change?.list.ios.reals.map(device => [device.id, device.online])).toEqual([[IOS_REAL, true]])
  })

  it('maps a locked-device io failure onto the structured arm', async () => {
    const fake = await stageFake({
      devices: [wireDevice('REAL-UDID', 'ios', 'real', 'online')],
      failArm: { method: 'device.io.tap', code: -32000, message: 'the device is locked; unlock it and try again' },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const locked = await errorOf(() => context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', x: 1, y: 2 }))
    expect(locked.code).toBe('PHONE_REAL_DEVICE_ISSUE')
    expect(locked.issue).toBe('device-locked')
  })

  it('maps a failed capture tunnel onto the structured arm', async () => {
    const fake = await stageFake({
      devices: [wireDevice('REAL-UDID', 'ios', 'real', 'online')],
      failArm: { method: 'device.screencapture', code: -32000, message: 'the device tunnel could not be established' },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const tunneled = await errorOf(() => context.phoneDevices.startCapture({ deviceId: IOS_REAL, format: 'mjpeg' }))
    expect(tunneled.code).toBe('PHONE_REAL_DEVICE_ISSUE')
    expect(tunneled.issue).toBe('tunnel-failed')
  })

  it('keeps upstream -32010 on PHONE_DEVICE_NOT_FOUND so Host 404 semantics survive', async () => {
    const fake = await stageFake({
      devices: [wireDevice('REAL-UDID', 'ios', 'real', 'online')],
      failArm: { method: 'device.io.tap', code: -32010, message: 'the device was unplugged' },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const gone = await errorOf(() => context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', x: 1, y: 2 }))
    expect(gone.code).toBe('PHONE_DEVICE_NOT_FOUND')
  })

  it('refuses lifecycle verbs for offline real handsets exactly as for online ones', async () => {
    const fake = await stageFake({
      devices: [wireDevice('REAL-UDID', 'ios', 'real', 'offline')],
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const refused = await errorOf(() => context.phoneDevices.boot(IOS_REAL))
    expect(refused.code).toBe('PHONE_REAL_DEVICE')
  })
})
