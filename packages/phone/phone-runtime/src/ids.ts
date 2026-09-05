/**
 * Construction of the branded phone device identifier. The owning package
 * casts; the brand costs nothing at runtime and keeps device ids
 * non-interchangeable with plain strings across Consumer boundaries.
 * @module @deepseek-ai/dsh-phone-runtime/ids
 */

import type { DeviceId, PhoneCaptureId } from './types.ts'

/**
 * Brand one mobilecli device id (Android serial or iOS UDID).
 * @param value - Identifier exactly as the upstream listing reports it.
 * @returns the branded id accepted by `boot`, `shutdown`, `io`, `startCapture`,
 *   `screenshot`, `agentStatus`, `installAgent`, and change payloads.
 */
export function deviceId(value: string): DeviceId {
  return value as DeviceId
}

/**
 * Brand one validated non-empty capture identity.
 * @param value - Identity parsed from a signed grant or browser wire frame.
 * @returns the branded capture identity.
 */
export function phoneCaptureId(value: string): PhoneCaptureId {
  if (value.length === 0) throw new TypeError('phone capture id must not be empty')
  return value as PhoneCaptureId
}
