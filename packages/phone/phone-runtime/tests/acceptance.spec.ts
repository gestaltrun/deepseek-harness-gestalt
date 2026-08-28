import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import { PhoneDevicesError } from '../src/errors.ts'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { MobilecliServerProcess } from '../src/server-process.ts'
import { assertStructurallyDecodableJpeg, firstMjpegFrame, stageFake, wireDevice } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const contexts: CordisContext[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  console.error('child diagnostics:', MobilecliServerProcess.diagnostics.splice(0))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

const IOS_REAL = deviceId('REAL-UDID')
const ANDROID_EMULATOR = deviceId('emulator-5554')

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
  fake.claim()
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

describe('acceptance: phone capture and io semantics over the fake stack', () => {
  it('emits a structurally decodable first MJPEG frame whose Content-Length matches its payload', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const capture = await context.phoneDevices.startCapture({ deviceId: ANDROID_EMULATOR, format: 'mjpeg' })
    expect(capture.contentType).toMatch(/multipart\/x-mixed-replace; boundary=frame/)

    const { headers, payload } = await firstMjpegFrame(capture.body)
    expect(headers.get('content-type')).toBe('image/jpeg')
    expect(headers.get('content-length')).toBe(String(payload.length))
    assertStructurallyDecodableJpeg(payload)
  })

  it('shows an io tap round trip in the fixture counters', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', x: 5, y: 6 })
    expect((await fake.counters()).io).toEqual([
      { method: 'device.io.tap', params: { deviceId: 'REAL-UDID', x: 5, y: 6 } },
    ])
  })

  it('keeps an unauthorized handset visible as unauthorized and refuses io without claiming an arm', async () => {
    const fake = await stageFake({ devices: [wireDevice('REAL-UDID', 'ios', 'real', 'unauthorized')] })
    fakes.push(fake)
    const context = await mountWith(fake)
    const list = await context.phoneDevices.listDevices()
    expect(list.ios.reals.map(ref => [ref.id, ref.state, ref.online])).toEqual([
      ['REAL-UDID', 'unauthorized', false],
    ])

    const refused = await errorOf(() => context.phoneDevices.io({ deviceId: IOS_REAL, method: 'tap', x: 1, y: 2 }))
    expect(refused.code).toBe('PHONE_UPSTREAM')
    expect(refused.message).toContain('unauthorized')
    // The structured fact lives on the listing's state field; the #362 arm
    // classifier must not claim this failure and mask the real cause.
    expect(refused.issue).toBeUndefined()
  })

  it('publishes a change when only the state flips between two non-online values', async () => {
    const fake = await stageFake({ devices: [wireDevice('REAL-UDID', 'ios', 'real', 'unauthorized')] })
    fakes.push(fake)
    const context = await mountWith(fake)
    const changes: Array<{ state: string | undefined; online: boolean | undefined }> = []
    context.phoneDevices.onChanged((change) => {
      const real = change.list.ios.reals[0]
      changes.push({ state: real?.state, online: real?.online })
    })
    await fake.setDevices([wireDevice('REAL-UDID', 'ios', 'real', 'offline')])
    const deadline = Date.now() + 3_000
    while (changes.length === 0 && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 5))
    }
    expect(changes).toEqual([{ state: 'offline', online: false }])
  })
})
