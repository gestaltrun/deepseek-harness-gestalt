/**
 * Value types for the project-membership capability. This module contains
 * only types — no runtime code.
 * @module @deepseek-ai/dsh-project-membership/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'

/** Durable cloud-project identifier, unique inside one environment namespace. */
export type ProjectId = Branded<'ProjectId'>

/** One membership row binding an account to a project with a role. */
export type MembershipId = Branded<'MembershipId'>

/** One invitation capability connecting a project to a prospective member. */
export type InvitationId = Branded<'InvitationId'>

/** Project-defined label describing what a member covers; display and routing metadata only. */
export type FunctionTag = Branded<'FunctionTag'>

/** Permission role vocabulary. Roles govern this collaboration plane only and never derive from or into Git-provider permissions. */
export type ProjectRole = 'owner' | 'admin' | 'member'

/** Lifecycle of one invitation. Acceptance is atomic with workspace linking. */
export type InvitationState = 'pending' | 'accepted' | 'declined' | 'retracted'

/** The local workspace a member linked while accepting an invitation. */
export interface WorkspaceLink {
  /** Member-chosen local name of the linked workspace. */
  readonly workspaceName: string
  /** Normalized git remote recorded for the linked checkout when it has one. */
  readonly normalizedRemoteUrl?: string
}

/** Stored view of one cloud project. */
export interface ProjectView {
  /** Unique project identifier. */
  readonly id: ProjectId
  /** Caller-chosen unique project name within the environment namespace. */
  readonly name: string
  /** Normalized git remote bound to the workspace this project projects. */
  readonly boundRemoteUrl: string
  /** Epoch milliseconds of creation. */
  readonly createdAt: number
}

/** Stored view of one membership. */
export interface MemberView {
  /** Membership identifier. */
  readonly id: MembershipId
  /** Member's durable platform account. */
  readonly accountId: PlatformAccountId
  /** Current permission role. */
  readonly role: ProjectRole
  /** Project-defined function tags; never permission-bearing. */
  readonly tags: readonly FunctionTag[]
  /**
   * The workspace linked at acceptance time. Absent only on a project
   * creator's founding row, which no invitation acceptance produced; every
   * joined row carries exactly one link.
   */
  readonly link?: WorkspaceLink
  /** Epoch milliseconds of joining. */
  readonly joinedAt: number
}

/** Stored view of one invitation in its current state. */
export interface InvitationView {
  /** Invitation identifier. */
  readonly id: InvitationId
  /** Target project. */
  readonly projectId: ProjectId
  /** Account that issued the invitation. */
  readonly inviterAccountId: PlatformAccountId
  /** Account invited to join. */
  readonly inviteeAccountId: PlatformAccountId
  /** Current lifecycle state. */
  readonly state: InvitationState
  /** Epoch milliseconds of issuance. */
  readonly invitedAt: number
  /** Epoch milliseconds of reaching a terminal state, once settled. */
  readonly settledAt?: number
}

/** Full roster projection for one project. */
export interface RosterView {
  /** The queried project. */
  readonly project: ProjectView
  /** Every membership row, ordered by join time. */
  readonly members: readonly MemberView[]
}
