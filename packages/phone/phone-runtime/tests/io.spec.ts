import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import {
  ioParams,
  iosScreenScale,
} from '../src/io.ts'
import { phoneSwipeActions } from '../src/swipe.ts'
import { stageFake, wireDevice } from './helpers.ts'

const contexts: Context[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

describe('iOS input coordinate normalization', () => {
  it('parses the official mobilecli 1.0.5 device.info screen size', () => {
    expect(iosScreenScale({
      device: { screenSize: { width: 402, height: 874, scale: 3 } },
    })).toBe(3)
  })

  it.each([
    null,
    {},
    { device: null },
    { device: {} },
    { device: { screenSize: { width: 0, height: 874, scale: 3 } } },
    { device: { screenSize: { width: 402, height: Number.NaN, scale: 3 } } },
    { device: { screenSize: { width: 402, height: 874, scale: '3' } } },
  ])('rejects malformed device.info result %#', (result) => {
    expect(() => iosScreenScale(result)).toThrow(PhoneDevicesError)
  })

  it('scales tap and gesture coordinates while preserving other action fields', () => {
    expect(ioParams({ deviceId: deviceId('ios'), method: 'tap', x: 984, y: 1_228 }, 3)).toEqual({
      deviceId: 'ios', x: 328, y: 409,
    })
    expect(ioParams({
      deviceId: deviceId('ios'),
      method: 'gesture',
      actions: [
        { type: 'pointerDown', x: 3, y: 6, pressure: 0.5 },
        { type: 'pause', duration: 100 },
        { type: 'pointerUp', x: 'upstream-validates', y: null },
      ],
    }, 3)).toEqual({
      deviceId: 'ios',
      actions: [
        { type: 'pointerDown', x: 1, y: 2, pressure: 0.5 },
        { type: 'pause', duration: 100 },
        { type: 'pointerUp', x: 'upstream-validates', y: null },
      ],
    })
  })

  it('encodes a swipe as WDA positioning, destination move, and travel pause', () => {
    expect(phoneSwipeActions([])).toEqual([])
    expect(phoneSwipeActions([{ x: 10, y: 20 }, { x: 11, y: 21 }, { x: 30, y: 80 }])).toEqual([
      { type: 'pointerMove', x: 10, y: 20 },
      { type: 'pointerDown' },
      { type: 'pointerMove', x: 30, y: 80 },
      { type: 'pause', duration: 150 },
      { type: 'pointerUp' },
    ])
  })

  it('records destination-move swipe offset and leaves Speak Selection at 0', async () => {
    const fake = await stageFake({
      devices: [wireDevice('SIM-UDID', 'ios', 'simulator', 'online')],
    })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneDevices, {
      executablePath: fake.executablePath,
      serverPort: fake.port,
      pollIntervalMs: 20,
      readyTimeoutMs: 6_000,
      requestTimeoutMs: 1_500,
    }).await()

    const tapShaped = [
      { type: 'pointerDown', x: 100, y: 400 },
      { type: 'pause', duration: 16 },
      { type: 'pointerUp' },
    ]
    await context.phoneDevices.io({
      deviceId: deviceId('SIM-UDID'),
      method: 'gesture',
      actions: tapShaped,
    })
    const afterTap = await fake.counters()
    expect(afterTap.io).toHaveLength(1)
    expect(afterTap.scroll['SIM-UDID'] ?? 0).toBe(0)

    await context.phoneDevices.io({
      deviceId: deviceId('SIM-UDID'),
      method: 'gesture',
      actions: [
        { type: 'pointerMove', x: 100, y: 400 },
        { type: 'pointerDown' },
        { type: 'pause', duration: 500 },
        { type: 'pointerMove', x: 100, y: 100 },
        { type: 'pointerUp' },
      ],
    })
    const afterSpeakSelection = await fake.counters()
    expect(afterSpeakSelection.io).toHaveLength(2)
    expect(afterSpeakSelection.scroll['SIM-UDID'] ?? 0).toBe(0)

    await context.phoneDevices.io({
      deviceId: deviceId('SIM-UDID'),
      method: 'gesture',
      actions: phoneSwipeActions([{ x: 100, y: 400 }, { x: 100, y: 100 }]),
    })
    const afterSwipe = await fake.counters()
    expect(afterSwipe.io).toHaveLength(3)
    expect(afterSwipe.scroll['SIM-UDID']).toBe(100)
  })

  it('forwards text and button requests without coordinate fields', () => {
    expect(ioParams({ deviceId: deviceId('ios'), method: 'text', text: 'hello' }, 3)).toEqual({
      deviceId: 'ios', text: 'hello',
    })
    expect(ioParams({ deviceId: deviceId('ios'), method: 'button', button: 'HOME' }, 3)).toEqual({
      deviceId: 'ios', button: 'HOME',
    })
  })
})
