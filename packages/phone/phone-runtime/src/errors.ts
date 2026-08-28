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
