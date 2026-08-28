/**
 * Short-lived HMAC capability tokens for same-origin phone capture URLs.
 * The token is not authentication: the `/api` trust fence still runs first,
 * and capture URLs additionally refuse a non-loopback Host.
 * @module @deepseek-ai/dsh-phone-stream/token
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PhoneCaptureFormat } from '@deepseek-ai/dsh-phone-runtime'

/** Canonical capture encodings a signed URL may name. */
const FORMATS: readonly PhoneCaptureFormat[] = ['mjpeg', 'h264']

/** One verified capture grant. */
export interface PhoneStreamGrant {
  /** Device id exactly as it was signed, still unbranded. */
  readonly deviceId: string
  /** Capture encoding bound into the signature. */
  readonly format: PhoneCaptureFormat
  /** Unix epoch milliseconds after which this grant is refused. */
  readonly expiresAt: number
}

/**
 * Sign one capture URL capability.
 * @param secret - Process-local HMAC key that never leaves the Host.
 * @param deviceId - Upstream device id string bound into the signature.
 * @param format - Capture encoding bound into the signature.
 * @param expiresAt - Unix epoch milliseconds after which verification fails.
 * @returns the opaque token placed on the signed URL.
 */
export function signPhoneStreamToken(
  secret: Buffer,
  deviceId: string,
  format: PhoneCaptureFormat,
  expiresAt: number,
): string {
  const signature = createHmac('sha256', secret).update(payload(deviceId, format, expiresAt)).digest('base64url')
  return `${String(expiresAt)}.${signature}`
}

/**
 * Verify one capture URL capability.
 * @param secret - Process-local HMAC key that minted the token.
 * @param deviceId - Device id from the request path.
 * @param format - Encoding from the request path.
 * @param token - Opaque token from the query string.
 * @param now - Evaluation instant in Unix epoch milliseconds.
 * @returns the grant when the signature matches, the path matches, and `now` is at or before expiry.
 */
export function verifyPhoneStreamToken(
  secret: Buffer,
  deviceId: string,
  format: string,
  token: string,
  now: number,
): PhoneStreamGrant | undefined {
  if (!isCaptureFormat(format)) return undefined
  const separator = token.indexOf('.')
  if (separator <= 0 || separator === token.length - 1) return undefined
  const expiryText = token.slice(0, separator)
  if (!/^[0-9]+$/.test(expiryText)) return undefined
  const expiresAt = Number(expiryText)
  if (!Number.isSafeInteger(expiresAt) || now > expiresAt) return undefined
  const actual = Buffer.from(token.slice(separator + 1), 'base64url')
  const expected = createHmac('sha256', secret).update(payload(deviceId, format, expiresAt)).digest()
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  return { deviceId, format, expiresAt }
}

/**
 * Whether a path segment names a capture encoding this package signs.
 * @param value - Untrusted path segment.
 * @returns true for `mjpeg` or `h264`.
 */
export function isCaptureFormat(value: string): value is PhoneCaptureFormat {
  return (FORMATS as readonly string[]).includes(value)
}

function payload(deviceId: string, format: PhoneCaptureFormat, expiresAt: number): string {
  return `${deviceId}\n${format}\n${String(expiresAt)}`
}
