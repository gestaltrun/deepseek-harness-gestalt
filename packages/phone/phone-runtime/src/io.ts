/** Exact-rotation input projection for mobilecli device-control calls. */

import { PhoneDevicesError } from './errors.ts'
import type { PhoneIoRequest, PhoneRotation } from './types.ts'

/** Official `device.info.screenSize` portrait logical points plus device-pixel scale. */
export interface IosScreenSize {
  readonly width: number
  readonly height: number
  readonly scale: number
}

/** One upstream mobilecli IO call after semantic platform projection. */
export interface PhoneUpstreamIo {
  readonly method: 'device.io.tap' | 'device.io.swipe' | 'device.io.text' | 'device.io.button'
  readonly params: Record<string, unknown>
}

/**
 * Parse mobilecli's positive portrait screen size.
 * @param result - Upstream JSON-RPC result value.
 * @returns the positive logical size and device-pixel scale.
 */
export function iosScreenSize(result: unknown): IosScreenSize {
  if (typeof result !== 'object' || result === null) throw screenSizeError('result')
  const device = (result as { device?: unknown }).device
  if (typeof device !== 'object' || device === null) throw screenSizeError('device')
  const screenSize = (device as { screenSize?: unknown }).screenSize
  if (typeof screenSize !== 'object' || screenSize === null) throw screenSizeError('screenSize')
  const record = screenSize as Record<string, unknown>
  return {
    width: positiveScreenSizeField(record, 'width'),
    height: positiveScreenSizeField(record, 'height'),
    scale: positiveScreenSizeField(record, 'scale'),
  }
}

/**
 * Convert one displayed capture point into the iOS portrait event space.
 * @param x - displayed capture x coordinate.
 * @param y - displayed capture y coordinate.
 * @param captureWidth - displayed capture width.
 * @param captureHeight - displayed capture height.
 * @param screen - portrait iOS logical bounds.
 * @param rotation - exact clockwise display rotation.
 * @returns the clamped portrait event coordinate.
 */
export function iosPortraitEventPoint(
  x: number,
  y: number,
  captureWidth: number,
  captureHeight: number,
  screen: IosScreenSize,
  rotation: PhoneRotation,
): { readonly x: number; readonly y: number } {
  const displayWidth = rotation === 90 || rotation === 270 ? screen.height : screen.width
  const displayHeight = rotation === 90 || rotation === 270 ? screen.width : screen.height
  const displayedX = scaledAxis(x, captureWidth, displayWidth)
  const displayedY = scaledAxis(y, captureHeight, displayHeight)
  switch (rotation) {
    case 0: return { x: displayedX, y: displayedY }
    case 90: return { x: displayedY, y: screen.height - displayedX }
    case 180: return { x: screen.width - displayedX, y: screen.height - displayedY }
    case 270: return { x: screen.width - displayedY, y: displayedX }
    default: return assertNever(rotation)
  }
}

function assertNever(value: never): never { throw new TypeError(`unexpected phone io value: ${String(value)}`) }

/**
 * Project one semantic request onto the upstream method and parameters.
 * @param request - semantic tap, swipe, text, or button request.
 * @param platform - listed device platform.
 * @param rotation - exact capture rotation for coordinate actions.
 * @param screen - iOS portrait logical bounds for coordinate actions.
 * @returns one upstream mobilecli IO call.
 */
export function upstreamIo(
  request: PhoneIoRequest,
  platform: 'android' | 'ios',
  rotation?: PhoneRotation,
  screen?: IosScreenSize,
): PhoneUpstreamIo {
  switch (request.method) {
    case 'text':
      return { method: 'device.io.text', params: { deviceId: request.deviceId, text: request.text } }
    case 'button':
      return { method: 'device.io.button', params: { deviceId: request.deviceId, button: request.button } }
    case 'tap':
    case 'swipe':
      break
    default:
      return assertNever(request)
  }
  switch (request.source.kind) {
    case 'capture':
    case 'fresh-probe':
      break
    default:
      return assertNever(request.source)
  }
  if (platform === 'android') {
    if (request.method === 'tap') {
      return { method: 'device.io.tap', params: { deviceId: request.deviceId, x: request.x, y: request.y } }
    }
    return {
      method: 'device.io.swipe',
      params: { deviceId: request.deviceId, x1: request.x1, y1: request.y1, x2: request.x2, y2: request.y2 },
    }
  }
  if (rotation === undefined) {
    throw new PhoneDevicesError('PHONE_PROTOCOL', 'exact iOS capture rotation is unknown; observe a current frame before input')
  }
  if (screen === undefined) {
    throw new PhoneDevicesError('PHONE_PROTOCOL', 'iOS input requires device.info screenSize')
  }
  const rotated = rotation === 90 || rotation === 270
  const captureWidth = request.source.kind === 'capture'
    ? request.source.captureWidth
    : (rotated ? screen.height : screen.width) * screen.scale
  const captureHeight = request.source.kind === 'capture'
    ? request.source.captureHeight
    : (rotated ? screen.width : screen.height) * screen.scale
  const point = (x: number, y: number) => iosPortraitEventPoint(
    x, y, captureWidth, captureHeight, screen, rotation,
  )
  if (rotation === 0) {
    if (request.method === 'tap') {
      const target = point(request.x, request.y)
      return { method: 'device.io.tap', params: { deviceId: request.deviceId, x: target.x, y: target.y } }
    }
    const start = point(request.x1, request.y1)
    const end = point(request.x2, request.y2)
    return {
      method: 'device.io.swipe',
      params: { deviceId: request.deviceId, x1: start.x, y1: start.y, x2: end.x, y2: end.y },
    }
  }
  if (request.method === 'tap') {
    const target = point(request.x, request.y)
    return {
      method: 'device.io.swipe',
      params: { deviceId: request.deviceId, x1: target.x, y1: target.y, x2: target.x, y2: target.y },
    }
  }
  const start = point(request.x1, request.y1)
  const end = point(request.x2, request.y2)
  return {
    method: 'device.io.swipe',
    params: { deviceId: request.deviceId, x1: start.x, y1: start.y, x2: end.x, y2: end.y },
  }
}

function scaledAxis(value: number, captureExtent: number, displayExtent: number): number {
  if (!Number.isFinite(captureExtent) || captureExtent <= 0) {
    throw new PhoneDevicesError('PHONE_PROTOCOL', 'capture dimensions must be positive finite numbers')
  }
  return Math.min(displayExtent, Math.max(0, Math.round(value * displayExtent / captureExtent)))
}

function positiveScreenSizeField(record: Record<string, unknown>, name: 'width' | 'height' | 'scale'): number {
  const value = record[name]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw screenSizeError(`screenSize.${name}`)
  return value
}

function screenSizeError(field: string): PhoneDevicesError {
  return new PhoneDevicesError(
    'PHONE_PROTOCOL',
    `mobilecli device.info ${field} must carry a positive finite screen size`,
  )
}
