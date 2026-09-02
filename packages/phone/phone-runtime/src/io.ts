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

/**
 * Parse the logical-point scale from mobilecli 1.0.5's `device.info` result.
 * @param result - Upstream JSON-RPC result value.
 * @returns the positive device-pixel to logical-point scale.
 */
export function iosScreenScale(result: unknown): number {
  if (typeof result !== 'object' || result === null) throw screenSizeError('result')
  const device = (result as { device?: unknown }).device
  if (typeof device !== 'object' || device === null) throw screenSizeError('device')
  const screenSize = (device as { screenSize?: unknown }).screenSize
  if (typeof screenSize !== 'object' || screenSize === null) throw screenSizeError('screenSize')
  const record = screenSize as Record<string, unknown>
  positiveScreenSizeField(record, 'width')
  positiveScreenSizeField(record, 'height')
  return positiveScreenSizeField(record, 'scale')
}

/**
 * Project one input request onto mobilecli parameters. iOS callers pass the
 * device-info scale so screenshot pixels become the logical points consumed
 * by XCTest; Android callers pass `1` because ADB consumes capture pixels.
 * @param request - Public screen-pixel or non-coordinate input request.
 * @param scale - device-pixel to logical-point scale.
 * @returns upstream `device.io.*` parameters without the method discriminant.
 */
export function ioParams(request: PhoneIoRequest, scale: number): Record<string, unknown> {
  switch (request.method) {
    case 'tap':
      return { deviceId: request.deviceId, x: scaledCoordinate(request.x, scale), y: scaledCoordinate(request.y, scale) }
    case 'gesture':
      return {
        deviceId: request.deviceId,
        actions: request.actions.map(action => ({
          ...action,
          ...scaledActionField(action, 'x', scale),
          ...scaledActionField(action, 'y', scale),
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

function scaledCoordinate(value: number, scale: number): number {
  return Math.round(value / scale)
}

function scaledActionField(
  action: Readonly<Record<string, unknown>>,
  field: 'x' | 'y',
  scale: number,
): Readonly<Record<string, number>> {
  const value = action[field]
  return typeof value === 'number' && Number.isFinite(value)
    ? { [field]: scaledCoordinate(value, scale) }
    : {}
}
