/** Platform input projection for mobilecli device-control calls. */

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

/** Current Android `dumpsys display` `logicalFrame` pixels. */
export interface AndroidLogicalDisplay {
  readonly width: number
  readonly height: number
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
    /* v8 ignore next -- PhoneRotation is the closed 0|90|180|270 union. */
    default: return assertNever(rotation)
  }
}

/* v8 ignore next -- closed PhoneIoRequest / PhoneCoordinateSource / PhoneRotation exhaustiveness. */
function assertNever(value: never): never { throw new TypeError(`unexpected phone io value: ${String(value)}`) }

/**
 * Project one semantic request onto the upstream method and parameters.
 * @param request - semantic tap, swipe, text, or button request.
 * @param platform - listed device platform.
 * @param rotation - exact capture rotation for coordinate actions.
 * @param screen - iOS portrait logical bounds for coordinate actions.
 * @param logicalDisplay - current Android logical display for capture-source coordinate actions.
 * @returns one upstream mobilecli IO call.
 * @throws {@link PhoneDevicesError} with `PHONE_PROTOCOL` when Android capture-source
 *   coordinates lack a current logical display or the capture plane is not the
 *   same aspect as that display.
 */
export function upstreamIo(
  request: PhoneIoRequest,
  platform: 'android' | 'ios',
  rotation?: PhoneRotation,
  screen?: IosScreenSize,
  logicalDisplay?: AndroidLogicalDisplay,
): PhoneUpstreamIo {
  switch (request.method) {
    case 'text':
      return { method: 'device.io.text', params: { deviceId: request.deviceId, text: request.text } }
    case 'button':
      return { method: 'device.io.button', params: { deviceId: request.deviceId, button: request.button } }
    case 'tap':
    case 'swipe':
      break
    /* v8 ignore next -- PhoneIoRequest is the closed tap|swipe|text|button union. */
    default:
      return assertNever(request)
  }
  if (platform === 'android') return androidUpstreamIo(request, logicalDisplay)
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
  return iosPortraitGesture(request, point, rotation)
}

/**
 * Project one Android tap or swipe. Fresh-probe pixels stay unscaled. Capture
 * pixels are the decoded plane and scale onto the current logical display
 * under the uniform full-frame aspect assumption; missing or incompatible
 * aspect fails before any RPC.
 * @param request - Semantic tap or swipe.
 * @param logicalDisplay - Current incarnation logical display, when known.
 * @returns one upstream tap or swipe call.
 */
function androidUpstreamIo(
  request: Extract<PhoneIoRequest, { method: 'tap' | 'swipe' }>,
  logicalDisplay: AndroidLogicalDisplay | undefined,
): PhoneUpstreamIo {
  const point = androidCoordinateProjector(request.source, logicalDisplay)
  switch (request.method) {
    case 'tap': {
      const target = point(request.x, request.y)
      return { method: 'device.io.tap', params: { deviceId: request.deviceId, x: target.x, y: target.y } }
    }
    case 'swipe': {
      const start = point(request.x1, request.y1)
      const end = point(request.x2, request.y2)
      return {
        method: 'device.io.swipe',
        params: { deviceId: request.deviceId, x1: start.x, y1: start.y, x2: end.x, y2: end.y },
      }
    }
    /* v8 ignore next -- Android coordinate methods are the closed tap|swipe union. */
    default:
      return assertNever(request)
  }
}

function androidCoordinateProjector(
  source: Extract<PhoneIoRequest, { method: 'tap' | 'swipe' }>['source'],
  logicalDisplay: AndroidLogicalDisplay | undefined,
): (x: number, y: number) => { readonly x: number; readonly y: number } {
  switch (source.kind) {
    case 'fresh-probe':
      return (x, y) => ({ x, y })
    case 'capture': {
      if (logicalDisplay === undefined) {
        throw new PhoneDevicesError(
          'PHONE_PROTOCOL',
          'Android capture-source input requires the current logical display',
        )
      }
      const captureWidth = source.captureWidth
      const captureHeight = source.captureHeight
      assertSameAspect(captureWidth, captureHeight, logicalDisplay.width, logicalDisplay.height)
      return (x, y) => ({
        x: scaledAxis(x, captureWidth, logicalDisplay.width),
        y: scaledAxis(y, captureHeight, logicalDisplay.height),
      })
    }
    /* v8 ignore next -- PhoneCoordinateSource is the closed capture|fresh-probe union. */
    default:
      return assertNever(source)
  }
}

/**
 * Treat capture and logical display as the same aspect when each reconstructed
 * logical axis, rounded to an integer pixel, lands within 1 logical pixel of
 * the known display. That bound is integer reconstruction of a uniform
 * full-frame scale, not a ratio epsilon and not proof of bar-free pixels.
 * @param captureWidth - Decoded capture width.
 * @param captureHeight - Decoded capture height.
 * @param displayWidth - Current logical display width.
 * @param displayHeight - Current logical display height.
 */
function assertSameAspect(
  captureWidth: number,
  captureHeight: number,
  displayWidth: number,
  displayHeight: number,
): void {
  if (!Number.isFinite(displayWidth) || displayWidth <= 0 || !Number.isFinite(displayHeight) || displayHeight <= 0) {
    throw new PhoneDevicesError('PHONE_PROTOCOL', 'Android logical display must be positive finite numbers')
  }
  if (!Number.isFinite(captureWidth) || captureWidth <= 0 || !Number.isFinite(captureHeight) || captureHeight <= 0) {
    throw new PhoneDevicesError('PHONE_PROTOCOL', 'capture dimensions must be positive finite numbers')
  }
  const reconstructedWidth = Math.round(captureWidth * displayHeight / captureHeight)
  const reconstructedHeight = Math.round(captureHeight * displayWidth / captureWidth)
  if (Math.abs(reconstructedWidth - displayWidth) > 1 || Math.abs(reconstructedHeight - displayHeight) > 1) {
    throw new PhoneDevicesError(
      'PHONE_PROTOCOL',
      'Android capture plane is not the same aspect as the current logical display',
    )
  }
}

/**
 * Project one iOS tap or swipe into portrait event space. Upright taps stay
 * taps; non-upright taps are a zero-length swipe at the same point. Swipes
 * remain swipes at both projected endpoints.
 * @param request - Semantic tap or swipe after capture extents are resolved.
 * @param point - Portrait event-space projector for one displayed coordinate.
 * @param rotation - Exact clockwise display rotation.
 * @returns one upstream tap or swipe call.
 */
function iosPortraitGesture(
  request: Extract<PhoneIoRequest, { method: 'tap' | 'swipe' }>,
  point: (x: number, y: number) => { readonly x: number; readonly y: number },
  rotation: PhoneRotation,
): PhoneUpstreamIo {
  switch (request.method) {
    case 'tap': {
      const target = point(request.x, request.y)
      if (rotation === 0) {
        return { method: 'device.io.tap', params: { deviceId: request.deviceId, x: target.x, y: target.y } }
      }
      return {
        method: 'device.io.swipe',
        params: { deviceId: request.deviceId, x1: target.x, y1: target.y, x2: target.x, y2: target.y },
      }
    }
    case 'swipe': {
      const start = point(request.x1, request.y1)
      const end = point(request.x2, request.y2)
      return {
        method: 'device.io.swipe',
        params: { deviceId: request.deviceId, x1: start.x, y1: start.y, x2: end.x, y2: end.y },
      }
    }
    /* v8 ignore next -- iOS coordinate methods are the closed tap|swipe union. */
    default:
      return assertNever(request)
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
