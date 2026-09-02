/**
 * Input coordinate normalization for mobilecli device-control calls.
 * @module @deepseek-ai/dsh-phone-runtime/io
 */

import { PhoneDevicesError } from './errors.ts'
import type { PhoneIoRequest } from './types.ts'

/** Contact hold after press so iOS treats the path as a drag rather than a tap. */
const PHONE_SWIPE_PRESS_HOLD_MS = 500
/** Settle on the last move so devicekit can attach duration before release. */
const PHONE_SWIPE_RELEASE_SETTLE_MS = 200

/**
 * Encode a swipe path as the WDA action list mobilecli's iOS converter consumes.
 * Positioning `pointerMove` precedes `pointerDown`; pauses supply drag duration.
 * @param points - capture-pixel path; the first and last points bound the swipe.
 * @returns OpenRPC `device.io.gesture` actions, or empty when `points` is empty.
 */
export function phoneSwipeActions(
  points: readonly Readonly<{ x: number; y: number }>[],
): Array<Record<string, unknown>> {
  const start = points[0]
  const end = points[points.length - 1]
  if (start === undefined || end === undefined) return []
  return [
    { type: 'pointerMove', x: start.x, y: start.y },
    { type: 'pointerDown' },
    { type: 'pause', duration: PHONE_SWIPE_PRESS_HOLD_MS },
    { type: 'pointerMove', x: end.x, y: end.y },
    { type: 'pause', duration: PHONE_SWIPE_RELEASE_SETTLE_MS },
    { type: 'pointerUp' },
  ]
}

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
