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
    expect(upstreamIo(tap(0), 'android')).toEqual({
      method: 'device.io.tap', params: { deviceId: 'ios', x: 603, y: 1311 },
    })
    expect(upstreamIo({ deviceId: deviceId('android'), method: 'swipe', source: { kind: 'fresh-probe' }, x1: 1, y1: 2, x2: 3, y2: 4 }, 'android')).toEqual({
      method: 'device.io.swipe', params: { deviceId: 'android', x1: 1, y1: 2, x2: 3, y2: 4 },
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
