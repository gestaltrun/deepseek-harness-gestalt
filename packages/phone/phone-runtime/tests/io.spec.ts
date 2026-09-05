import { describe, expect, it } from 'vitest'
import { deviceId, phoneCaptureId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import { iosPortraitEventPoint, iosScreenSize, upstreamIo } from '../src/io.ts'
import type { PhoneIoRequest, PhoneRotation } from '../src/types.ts'

const SCREEN = { width: 402, height: 874, scale: 3 }

function tap(rotation: PhoneRotation): Extract<PhoneIoRequest, { method: 'tap' }> {
  return {
    deviceId: deviceId('ios'),
    method: 'tap',
    x: rotation === 90 || rotation === 270 ? 1_590 : 603,
    y: rotation === 90 || rotation === 270 ? 1_080 : 1_311,
    source: {
      kind: 'capture', captureId: phoneCaptureId('capture'), captureFormat: 'mjpeg',
      captureWidth: rotation === 90 || rotation === 270 ? 2_622 : 1_206,
      captureHeight: rotation === 90 || rotation === 270 ? 1_206 : 2_622,
    },
  }
}

describe('exact iOS input rotation', () => {
  it('parses the official mobilecli screen size and rejects every malformed layer and field', () => {
    expect(iosScreenSize({ device: { screenSize: SCREEN } })).toEqual(SCREEN)
    for (const value of [undefined, null, 1, 'x', [], {}]) {
      expect(() => iosScreenSize(value)).toThrow(PhoneDevicesError)
    }
    for (const device of [undefined, null, 1, 'x', []]) {
      expect(() => iosScreenSize({ device })).toThrow(PhoneDevicesError)
    }
    for (const screenSize of [undefined, null, 1, 'x', []]) {
      expect(() => iosScreenSize({ device: { screenSize } })).toThrow(PhoneDevicesError)
    }
    for (const field of ['width', 'height', 'scale'] as const) {
      for (const value of [undefined, null, '3', Number.NaN, Infinity, 0, -1]) {
        expect(() => iosScreenSize({ device: { screenSize: { ...SCREEN, [field]: value } } }))
          .toThrow(PhoneDevicesError)
      }
    }
  })

  it.each([
    [0, [0, 0], [402, 874], [201, 437], [201, 874]],
    [90, [0, 874], [402, 0], [201, 437], [402, 437]],
    [180, [402, 874], [0, 0], [201, 437], [201, 0]],
    [270, [402, 0], [0, 874], [201, 437], [0, 437]],
  ] as const)('inverse-transforms corners, center, and an edge at %i°', (rotation, topLeft, bottomRight, center, edge) => {
    const width = rotation === 90 || rotation === 270 ? 874 : 402
    const height = rotation === 90 || rotation === 270 ? 402 : 874
    const point = (x: number, y: number) => iosPortraitEventPoint(x, y, width, height, SCREEN, rotation)
    expect(Object.values(point(0, 0))).toEqual(topLeft)
    expect(Object.values(point(width, height))).toEqual(bottomRight)
    expect(Object.values(point(width / 2, height / 2))).toEqual(center)
    expect(Object.values(point(width / 2, height))).toEqual(edge)
  })

  it('forwards text and button without coordinate metadata', () => {
    expect(upstreamIo({ deviceId: deviceId('ios'), method: 'text', text: 'hello' }, 'ios')).toEqual({
      method: 'device.io.text', params: { deviceId: 'ios', text: 'hello' },
    })
    expect(upstreamIo({ deviceId: deviceId('ios'), method: 'button', button: 'HOME' }, 'ios')).toEqual({
      method: 'device.io.button', params: { deviceId: 'ios', button: 'HOME' },
    })
  })

  it('dispatches Android semantic actions directly', () => {
    expect(upstreamIo({
      deviceId: deviceId('android'), method: 'tap', source: { kind: 'fresh-probe' }, x: 603, y: 1_311,
    }, 'android')).toEqual({
      method: 'device.io.tap', params: { deviceId: 'android', x: 603, y: 1311 },
    })
    expect(upstreamIo({ deviceId: deviceId('android'), method: 'swipe', source: { kind: 'fresh-probe' }, x1: 1, y1: 2, x2: 3, y2: 4 }, 'android')).toEqual({
      method: 'device.io.swipe', params: { deviceId: 'android', x1: 1, y1: 2, x2: 3, y2: 4 },
    })
  })

  it('scales Android capture-source taps and swipes onto the current logical display', () => {
    const captureId = phoneCaptureId('android-capture')
    const source = {
      kind: 'capture' as const,
      captureId,
      captureFormat: 'h264' as const,
      captureWidth: 1_124,
      captureHeight: 540,
    }
    const logical = { width: 2_248, height: 1_080 }
    expect(upstreamIo({
      deviceId: deviceId('android'), method: 'tap', x: 562, y: 270, source,
    }, 'android', undefined, undefined, logical)).toEqual({
      method: 'device.io.tap', params: { deviceId: 'android', x: 1_124, y: 540 },
    })
    expect(upstreamIo({
      deviceId: deviceId('android'), method: 'swipe',
      x1: 0, y1: 0, x2: 1_124, y2: 540, source,
    }, 'android', undefined, undefined, logical)).toEqual({
      method: 'device.io.swipe',
      params: { deviceId: 'android', x1: 0, y1: 0, x2: 2_248, y2: 1_080 },
    })
  })

  it('refuses Android capture-source coordinates whose plane is not the logical display aspect', () => {
    const source = {
      kind: 'capture' as const,
      captureId: phoneCaptureId('android-portrait'),
      captureFormat: 'h264' as const,
      captureWidth: 1_080,
      captureHeight: 2_248,
    }
    expect(() => upstreamIo({
      deviceId: deviceId('android'), method: 'tap', x: 540, y: 1_124, source,
    }, 'android', undefined, undefined, { width: 2_248, height: 1_080 }))
      .toThrow(/logical display/u)
    expect(upstreamIo({
      deviceId: deviceId('android'), method: 'button', button: 'HOME',
    }, 'android')).toEqual({
      method: 'device.io.button', params: { deviceId: 'android', button: 'HOME' },
    })
  })

  it('refuses Android capture-source coordinates without a current logical display', () => {
    expect(() => upstreamIo({
      deviceId: deviceId('android'),
      method: 'tap',
      x: 562,
      y: 270,
      source: {
        kind: 'capture',
        captureId: phoneCaptureId('android-missing'),
        captureFormat: 'h264',
        captureWidth: 1_124,
        captureHeight: 540,
      },
    }, 'android')).toThrow(/logical display/u)
  })

  it('accepts even-coded Android capture rounding onto the logical display', () => {
    const logical = { width: 2_248, height: 1_080 }
    expect(upstreamIo({
      deviceId: deviceId('android'),
      method: 'tap',
      x: 539,
      y: 259,
      source: {
        kind: 'capture',
        captureId: phoneCaptureId('android-even-round'),
        captureFormat: 'h264',
        captureWidth: 1_078,
        captureHeight: 518,
      },
    }, 'android', undefined, undefined, logical)).toEqual({
      method: 'device.io.tap', params: { deviceId: 'android', x: 1_124, y: 540 },
    })
    expect(upstreamIo({
      deviceId: deviceId('android'),
      method: 'tap',
      x: 541,
      y: 260,
      source: {
        kind: 'capture',
        captureId: phoneCaptureId('android-one-pixel'),
        captureFormat: 'h264',
        captureWidth: 1_082,
        captureHeight: 520,
      },
    }, 'android', undefined, undefined, logical)).toEqual({
      method: 'device.io.tap', params: { deviceId: 'android', x: 1_124, y: 540 },
    })
  })

  it('refuses Android capture rounding beyond one reconstructed logical pixel', () => {
    const logical = { width: 2_248, height: 1_080 }
    expect(() => upstreamIo({
      deviceId: deviceId('android'),
      method: 'tap',
      x: 542,
      y: 260,
      source: {
        kind: 'capture',
        captureId: phoneCaptureId('android-round-mismatch'),
        captureFormat: 'h264',
        captureWidth: 1_084,
        captureHeight: 520,
      },
    }, 'android', undefined, undefined, logical))
      .toThrow(/logical display/u)
    expect(() => upstreamIo({
      deviceId: deviceId('android'),
      method: 'tap',
      x: 200,
      y: 96,
      source: {
        kind: 'capture',
        captureId: phoneCaptureId('android-400x192'),
        captureFormat: 'h264',
        captureWidth: 400,
        captureHeight: 192,
      },
    }, 'android', undefined, undefined, logical))
      .toThrow(/logical display/u)
  })

  it('refuses non-positive Android logical display and capture extents', () => {
    const source = {
      kind: 'capture' as const,
      captureId: phoneCaptureId('android-extents'),
      captureFormat: 'h264' as const,
      captureWidth: 1_124,
      captureHeight: 540,
    }
    expect(() => upstreamIo({
      deviceId: deviceId('android'), method: 'tap', x: 562, y: 270, source,
    }, 'android', undefined, undefined, { width: 0, height: 1_080 }))
      .toThrow(/logical display must be positive/u)
    expect(() => upstreamIo({
      deviceId: deviceId('android'),
      method: 'tap',
      x: 562,
      y: 270,
      source: { ...source, captureWidth: 0 },
    }, 'android', undefined, undefined, { width: 2_248, height: 1_080 }))
      .toThrow(/capture dimensions must be positive/u)
  })

  it('forwards Android fresh-probe coordinates without a logical display', () => {
    expect(upstreamIo({
      deviceId: deviceId('android'), method: 'tap', source: { kind: 'fresh-probe' }, x: 562, y: 270,
    }, 'android')).toEqual({
      method: 'device.io.tap', params: { deviceId: 'android', x: 562, y: 270 },
    })
  })

  it('keeps iOS exact projection when an Android logical display is also supplied', () => {
    expect(upstreamIo(tap(0), 'ios', 0, SCREEN, { width: 2_248, height: 1_080 })).toEqual({
      method: 'device.io.tap', params: { deviceId: 'ios', x: 201, y: 437 },
    })
  })

  it.each([0, 90, 180, 270] as const)('dispatches iOS tap and swipe at %i°', (rotation) => {
    const request = tap(rotation)
    const tapCall = upstreamIo(request, 'ios', rotation, SCREEN)
    const swipeCall = upstreamIo({
      deviceId: request.deviceId,
      method: 'swipe',
      x1: request.x,
      y1: request.y,
      x2: 300,
      y2: 600,
      source: request.source,
    }, 'ios', rotation, SCREEN)
    expect(tapCall.method).toBe(rotation === 0 ? 'device.io.tap' : 'device.io.swipe')
    expect(swipeCall.method).toBe('device.io.swipe')
    if (rotation === 0) expect(tapCall.params).toMatchObject({ x: 201, y: 437 })
    if (rotation === 90) expect(tapCall.params).toMatchObject({ x1: 360, y1: 344, x2: 360, y2: 344 })
    if (rotation === 270) expect(tapCall.params).toMatchObject({ x1: 42, y1: 530, x2: 42, y2: 530 })
  })

  it('maps full-resolution and arbitrary scaled captures, clamps edges, and validates extents', () => {
    expect(iosPortraitEventPoint(603, 1_311, 1_206, 2_622, SCREEN, 0)).toEqual({ x: 201, y: 437 })
    expect(iosPortraitEventPoint(201, 437, 402, 874, SCREEN, 0)).toEqual({ x: 201, y: 437 })
    expect(iosPortraitEventPoint(500, 250, 1_000, 500, SCREEN, 0)).toEqual({ x: 201, y: 437 })
    expect(iosPortraitEventPoint(-10, 9_999, 402, 874, SCREEN, 0)).toEqual({ x: 0, y: 874 })
    expect(() => iosPortraitEventPoint(1, 2, 0, 10, SCREEN, 0)).toThrow(/capture dimensions/u)
    expect(() => iosPortraitEventPoint(1, 2, 10, Number.NaN, SCREEN, 0)).toThrow(/capture dimensions/u)
  })

  it('refuses unknown rotation and derives the model screenshot extent when dimensions are omitted', () => {
    expect(() => upstreamIo(tap(90), 'ios')).toThrow(/exact iOS capture rotation is unknown/u)
    expect(() => upstreamIo(tap(0), 'ios', 0)).toThrow(/iOS input requires device.info screenSize/u)
    expect(upstreamIo({ deviceId: deviceId('ios'), method: 'tap', source: { kind: 'fresh-probe' }, x: 603, y: 1_311 }, 'ios', 0, SCREEN))
      .toEqual({ method: 'device.io.tap', params: { deviceId: 'ios', x: 201, y: 437 } })
    expect(upstreamIo({ deviceId: deviceId('ios'), method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080 }, 'ios', 90, SCREEN))
      .toEqual({ method: 'device.io.swipe', params: { deviceId: 'ios', x1: 360, y1: 344, x2: 360, y2: 344 } })
    expect(upstreamIo({ deviceId: deviceId('ios'), method: 'tap', source: { kind: 'fresh-probe' }, x: 603, y: 1_311 }, 'ios', 180, SCREEN))
      .toEqual({ method: 'device.io.swipe', params: { deviceId: 'ios', x1: 201, y1: 437, x2: 201, y2: 437 } })
    expect(upstreamIo({ deviceId: deviceId('ios'), method: 'tap', source: { kind: 'fresh-probe' }, x: 1_590, y: 1_080 }, 'ios', 270, SCREEN))
      .toEqual({ method: 'device.io.swipe', params: { deviceId: 'ios', x1: 42, y1: 530, x2: 42, y2: 530 } })
  })
})
