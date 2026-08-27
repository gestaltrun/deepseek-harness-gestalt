/**
 * Stable error taxonomy for project-membership failures.
 * @module @deepseek-ai/dsh-project-membership/errors
 */

import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'

/** Stable failure categories safe for client branching. */
export type ProjectMembershipErrorCode =
  | 'DUPLICATE_INVITEE'
  | 'ROLE_REQUIRED'
  | 'NOT_A_MEMBER'
  | 'PROJECT_NOT_FOUND'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_NOT_PENDING'
  | 'PROJECT_NAME_TAKEN'
  | 'INVALID_PROJECT_NAME'
  | 'INVALID_REMOTE_URL'
  | 'INVALID_TAGS'
  | 'LAST_OWNER'
  | 'INVALID_LINK'

/** Project membership failure with a stable code safe for client branching. */
export class ProjectMembershipError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: ProjectMembershipErrorCode

  /**
   * @param code - stable failure category.
   * @param message - safe diagnostic without credentials or signed values.
   */
  constructor(code: ProjectMembershipErrorCode, message: string) {
    super(message)
    this.name = 'ProjectMembershipError'
    this.code = code
  }
}

/**
 * Build the atomic duplicate-invitee rejection: one account may hold at most one membership or pending invitation per project.
 * @param accountId - rejected platform account.
 * @returns the `DUPLICATE_INVITEE` error carrying no signed values.
 */
export const duplicateInvitee = (accountId: PlatformAccountId): ProjectMembershipError =>
  new ProjectMembershipError('DUPLICATE_INVITEE', `account ${accountId} already holds a membership or a pending invitation in this project`)
