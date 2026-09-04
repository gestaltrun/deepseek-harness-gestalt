/**
 * Public error vocabulary for the phone device fleet Service.
 * @module @deepseek-ai/dsh-phone-runtime/errors
 */

import type { PhoneErrorCode, PhoneRealDeviceIssue } from './types.ts'

/** Normalized failure raised by every phone fleet Service operation. */
export class PhoneDevicesError extends Error {
  /** Structured real-device failure arm; present exactly on `PHONE_REAL_DEVICE_ISSUE`. */
  readonly issue?: PhoneRealDeviceIssue

  /**
   * Construct one normalized failure.
   * @param code - Closed error-code union member naming the failure class.
   * @param message - Complete failure description shown to operators and consumers.
   * @param options - Standard `Error` options; `cause` preserves the original
   *   failure and `issue` names the structured real-device arm when the code is
   *   `PHONE_REAL_DEVICE_ISSUE`.
   */
  constructor(readonly code: PhoneErrorCode, message: string, options?: { cause?: unknown; issue?: PhoneRealDeviceIssue }) {
    super(message, options)
    this.name = 'PhoneDevicesError'
    if (options?.issue !== undefined) this.issue = options.issue
  }
}

/**
 * Preserve an authoritative phone failure while attaching a separate cleanup failure.
 * @param failure - Operation failure whose public code and structured issue remain authoritative.
 * @param cleanup - Later teardown failure that must remain independently inspectable.
 * @param label - Cleanup operation named in the operator-facing diagnostic.
 * @returns a normalized error carrying both failures in an {@link AggregateError} cause.
 */
export function phoneFailureWithCleanup(
  failure: PhoneDevicesError,
  cleanup: unknown,
  label: string,
): PhoneDevicesError {
  return new PhoneDevicesError(
    failure.code,
    `${failure.message}\n${label}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
    {
      cause: new AggregateError([failure, cleanup], `${label} after ${failure.code}`),
      ...(failure.issue !== undefined ? { issue: failure.issue } : {}),
    },
  )
}
