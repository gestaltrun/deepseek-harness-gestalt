import type { PhoneCaptureId } from '@deepseek-ai/dsh-phone-runtime'

/** Brand one non-empty capture identity after browser JSON validation.
 * @param value - Validated non-empty capture identity text.
 * @returns the branded capture identity.
 */
export function phoneCaptureIdOf(value: string): PhoneCaptureId {
  if (value.length === 0) throw new TypeError('phone capture id must not be empty')
  return value as PhoneCaptureId
}
