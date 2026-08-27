/**
 * Public error vocabulary for the phone device fleet Service.
 * @module @deepseek-ai/dsh-phone-runtime/errors
 */

import type { PhoneErrorCode } from './types.ts'

/** Normalized failure raised by every phone fleet Service operation. */
export class PhoneDevicesError extends Error {
  /**
   * Construct one normalized failure.
   * @param code - Closed error-code union member naming the failure class.
   * @param message - Complete failure description shown to operators and consumers.
   * @param options - Standard `Error` options; `cause` preserves the original failure.
   */
  constructor(readonly code: PhoneErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PhoneDevicesError'
  }
}
