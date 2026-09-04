/**
 * Input coordinate normalization for mobilecli device-control calls, plus
 * re-export of the browser-safe WDA swipe encoder.
 * @module @deepseek-ai/dsh-phone-runtime/io
 */

import { PhoneDevicesError } from './errors.ts'
import type { PhoneIoRequest } from './types.ts'

export {
  PHONE_SWIPE_MOVE_DURATION_MS,
  phoneSwipeActions,
} from './swipe.ts'

/** Official `device.info.screenSize` logical points plus device-pixel scale. */
export interface IosScreenSize {
  readonly width: number
  readonly height: number
  readonly scale: number
}

/**
 * Parse mobilecli 1.0.5's `device.info` screen size. Width and height stay
 * the sticky portrait logical bounds on a rotated real iPhone; callers swap
 * them from the live capture surface.
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
 * Parse the logical-point scale from mobilecli 1.0.5's `device.info` result.
 * @param result - Upstream JSON-RPC result value.
 * @returns the positive device-pixel to logical-point scale.
 */
export function iosScreenScale(result: unknown): number {
  return iosScreenSize(result).scale
}

/**
 * Project one input request onto mobilecli parameters. iOS callers pass the
 * device-info screen size so capture pixels become the logical points WDA
 * accepts in the matching orientation; Android callers pass `1` because ADB
 * consumes capture pixels.
 * @param request - Public screen-pixel or non-coordinate input request.
 * @param screen - device-pixel scale, or iOS logical size plus scale.
 * @returns upstream `device.io.*` parameters without the method discriminant.
 */
export function ioParams(request: PhoneIoRequest, screen: number | IosScreenSize): Record<string, unknown> {
  const scale = typeof screen === 'number' ? screen : screen.scale
  const bounds = typeof screen === 'number' ? undefined : wdaLogicalBounds(request, screen)
  switch (request.method) {
    case 'tap':
      return {
        deviceId: request.deviceId,
        x: scaledCoordinate(request.x, scale, bounds?.width),
        y: scaledCoordinate(request.y, scale, bounds?.height),
      }
    case 'gesture':
      return {
        deviceId: request.deviceId,
        actions: request.actions.map(action => ({
          ...action,
          ...scaledActionField(action, 'x', scale, bounds?.width),
          ...scaledActionField(action, 'y', scale, bounds?.height),
        })),
      }
    case 'text':
      return { deviceId: request.deviceId, text: request.text }
    case 'button':
      return { deviceId: request.deviceId, button: request.button }
  }
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

function scaledCoordinate(value: number, scale: number, max?: number): number {
  const point = Math.round(value / scale)
  return max === undefined ? point : Math.min(max, Math.max(0, point))
}

function scaledActionField(
  action: Readonly<Record<string, unknown>>,
  field: 'x' | 'y',
  scale: number,
  max?: number,
): Readonly<Record<string, number>> {
  const value = action[field]
  return typeof value === 'number' && Number.isFinite(value)
    ? { [field]: scaledCoordinate(value, scale, max) }
    : {}
}

/**
 * WDA logical bounds for this request. Sticky `device.info.screenSize` stays
 * portrait on a landscape iPhone. A live capture surface (width greater than
 * height) always swaps those bounds; omitted size falls back to overflow of
 * one scaled point.
 */
function wdaLogicalBounds(request: PhoneIoRequest, screen: IosScreenSize): IosScreenSize {
  const unswapped = { width: screen.width, height: screen.height }
  const swapped = { width: screen.height, height: screen.width }
  const surface = captureSurface(request)
  if (surface !== undefined) {
    return surface.width > surface.height && screen.width < screen.height
      ? { ...screen, ...swapped }
      : { ...screen, ...unswapped }
  }
  const hint = capturePixelHint(request)
  if (hint === undefined) return screen
  const x = hint.x / screen.scale
  const y = hint.y / screen.scale
  if (x <= unswapped.width && y <= unswapped.height) return { ...screen, ...unswapped }
  return { ...screen, ...swapped }
}

function captureSurface(
  request: PhoneIoRequest,
): { readonly width: number; readonly height: number } | undefined {
  if (request.method !== 'tap' && request.method !== 'gesture') return undefined
  const width = request.captureWidth
  const height = request.captureHeight
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height }
}

function capturePixelHint(
  request: PhoneIoRequest,
): { readonly x: number; readonly y: number } | undefined {
  if (request.method === 'tap') return { x: request.x, y: request.y }
  if (request.method !== 'gesture') return undefined
  let x = 0
  let y = 0
  let found = false
  for (const action of request.actions) {
    if (typeof action.x === 'number' && Number.isFinite(action.x)) {
      x = Math.max(x, action.x)
      found = true
    }
    if (typeof action.y === 'number' && Number.isFinite(action.y)) {
      y = Math.max(y, action.y)
      found = true
    }
  }
  return found ? { x, y } : undefined
}
