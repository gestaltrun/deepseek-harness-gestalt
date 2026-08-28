/**
 * Stable construction-time errors for `ask_user_question` routing parameters.
 * @module @deepseek-ai/dsh-tool-ask-user/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable failure codes of routed `ask_user_question` construction. */
export type AskUserQuestionErrorCode =
  | 'BACKGROUND_REQUIRED'
  | 'BACKGROUND_TOO_LONG'
  | 'REFERENCES_INVALID'
  | 'SENDER_UNAVAILABLE'

/** Construction-time failure of a routed or referenced ask. */
export class AskUserQuestionError extends HarnessError {
  constructor(message: string, code: AskUserQuestionErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'AskUserQuestionError'
  }
}

/** Unicode code-point ceiling of agent-authored background, matching the T4 codec. */
export const BACKGROUND_MAX_CODE_POINTS = 600

/** Unicode code-point ceiling of one reference reason, matching the T4 codec. */
export const REFERENCE_REASON_MAX_CODE_POINTS = 100

/** Maximum referenced documents in one ask, matching the T4 codec. */
export const REFERENCES_MAX_COUNT = 8
