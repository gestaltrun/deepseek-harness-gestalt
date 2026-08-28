/**
 * Stable error taxonomy for member-question sender failures.
 * @module @deepseek-ai/dsh-member-question-sender/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable failure codes of `ctx.memberQuestionSender.send()`. */
export type MemberQuestionSenderErrorCode =
  | 'DELIVERY_UNAVAILABLE'
  | 'GRANT_UNAVAILABLE'
  | 'ENCODE_FAILED'

/** Sender failure with a stable code safe for model and client branching. */
export class MemberQuestionSenderError extends HarnessError {
  constructor(message: string, code: MemberQuestionSenderErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'MemberQuestionSenderError'
  }
}
