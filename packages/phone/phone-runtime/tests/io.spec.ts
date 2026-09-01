import { describe, expect, it } from 'vitest'
import { PhoneDevicesError } from '../src/errors.ts'
import { ioParams, iosScreenScale } from '../src/io.ts'
import { deviceId } from '../src/ids.ts'

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

  it('forwards text and button requests without coordinate fields', () => {
    expect(ioParams({ deviceId: deviceId('ios'), method: 'text', text: 'hello' }, 3)).toEqual({
      deviceId: 'ios', text: 'hello',
    })
    expect(ioParams({ deviceId: deviceId('ios'), method: 'button', button: 'HOME' }, 3)).toEqual({
      deviceId: 'ios', button: 'HOME',
    })
  })
})
