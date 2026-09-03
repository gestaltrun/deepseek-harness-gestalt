/**
 * Event vocabulary of the project-membership capability. The provider emits
 * one roster-invalidation record per committed membership-set or per-member
 * mutation, strictly after durability; consumers rebuild cached roster views
 * from it instead of polling.
 * @module @deepseek-ai/dsh-project-membership/events
 */

import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { FunctionTag, MembershipId, ProjectId, ProjectRole } from './types.ts'

/** What one committed membership mutation changed. */
export type RosterChangeReason = 'joined' | 'removed' | 'role-changed' | 'tags-changed'

/** Project-scoped tags carried by the mutated membership after a `tags-changed` commit. */
export interface RosterTagsChanged {
  readonly reason: 'tags-changed'
  /** Replacement tag set now carried by the membership. */
  readonly tags: readonly FunctionTag[]
}

/** Role held by the mutated membership after a `role-changed` commit. */
export interface RosterRoleChanged {
  readonly reason: 'role-changed'
  /** The role now held by the membership. */
  readonly role: ProjectRole
}

/** Payload shared by every committed membership mutation. */
export interface RosterInvalidationBase {
  /** Project whose roster projection is invalidated. */
  readonly projectId: ProjectId
  /** Membership row the mutation touched. */
  readonly membershipId: MembershipId
  /** Platform account holding the membership after the commit. */
  readonly accountId: PlatformAccountId
  /**
   * Roster projection version before this commit. Zero marks the founding
   * `joined` commit of a new project.
   */
  readonly rosterVersionBefore: number
  /** Roster projection version published by this commit. */
  readonly rosterVersionAfter: number
}

/**
 * One committed membership mutation. A closed union — switch on `reason`;
 * `removed` rows are gone, so they carry no post-state member.
 */
export type RosterInvalidation = RosterInvalidationBase & (RosterTagsChanged | RosterRoleChanged | { readonly reason: 'joined' } | { readonly reason: 'removed' })

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A membership mutation committed durably and its project's roster view
     * must be re-derived. One event per commit in write order.
     * @param change - project, membership, account, both roster versions, and the change discriminant with any post-state payload.
     * @mode emit
     */
    'project-membership/roster-invalidated'(change: RosterInvalidation): void
  }
}
