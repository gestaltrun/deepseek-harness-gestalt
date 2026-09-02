/**
 * Service Definition for cloud-project membership: projects bound to a
 * workspace's git remote, owner/admin/member roles, project-defined function
 * tags, and invitations whose acceptance is atomic with workspace linking.
 * Providers own durable environment-namespaced state behind this interface.
 * @module @deepseek-ai/dsh-project-membership
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { ProjectMembershipError } from './errors.ts'
export * from './events.ts'
export * from './errors.ts'
export * from './invite-role.ts'
export * from './remote-url.ts'
export * from './types.ts'

import type {
  FunctionTag,
  InvitationId,
  InvitationView,
  MemberView,
  MembershipId,
  ProjectId,
  ProjectRole,
  ProjectView,
  RosterView,
  WorkspaceLink,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    projectMembership: ProjectMembershipService
  }
}

/** Inputs for creating one project. */
export interface CreateProjectInput {
  /** Caller-chosen unique name within the environment namespace. */
  readonly name: string
  /** Git remote URL of the workspace this project projects; stored normalized. */
  readonly remoteUrl: string
}

/** Inputs for issuing one invitation. */
export interface InviteInput {
  /** Target project; the actor must hold the admin role or above. */
  readonly projectId: ProjectId
  /** Platform account invited to join. */
  readonly inviteeAccountId: PlatformAccountId
  /**
   * Role conferred when the invitee completes accept-with-workspace-link.
   * The executor refuses `owner` and any role the actor cannot grant.
   */
  readonly grantedRole: ProjectRole
}

/** Inputs for accepting one pending invitation; linking is mandatory and atomic. */
export interface AcceptInvitationInput {
  /** The pending invitation addressed to the accepting account. */
  readonly invitationId: InvitationId
  /** The local workspace linked at acceptance. */
  readonly link: WorkspaceLink
}

/** Inputs for changing one membership's permission role. */
export interface ChangeRoleInput {
  /** The membership row to change. */
  readonly membershipId: MembershipId
  /** The new role. */
  readonly role: ProjectRole
}

/** Inputs for replacing one membership's project-defined function tags. */
export interface SetMemberTagsInput {
  /** The membership row to relabel. */
  readonly membershipId: MembershipId
  /** Replacement tag set; never permission-bearing. */
  readonly tags: readonly FunctionTag[]
}

/** Pending invitation paired with the project facts needed for a trusted acceptance decision. */
export interface PendingInvitationContext {
  readonly invitation: InvitationView
  readonly project: ProjectView
}

/**
 * Project-membership capability. Every mutation executes its role gate inside
 * the operation itself: schema omission or listener order never substitutes
 * for the check that decides the outcome.
 */
export abstract class ProjectMembershipService extends Service {
  /** @param ctx - Platform composition context receiving this service. */
  constructor(ctx: Context) {
    super(ctx, 'projectMembership')
  }

  /**
   * Create one project; the actor becomes its first owner.
   * @param actor - authenticated account performing the mutation.
   * @param input - unique project name and git remote to bind.
   * @returns the stored project view.
   * @throws {ProjectMembershipError} `PROJECT_NAME_TAKEN` when the name is in use,
   * `PROJECT_REMOTE_TAKEN` when another Project owns the normalized remote,
   * or `INVALID_REMOTE_URL` when normalization fails.
   */
  abstract createProject(actor: PlatformAccountId, input: CreateProjectInput): Promise<ProjectView>

  /**
   * Issue one invitation to a platform account.
   * @param actor - authenticated account holding admin or owner on the project.
   * @param input - target project, invitee account, and the role granted at accept time.
   * @returns the invitation in `pending` state, carrying that granted role.
   * @throws {ProjectMembershipError} `ROLE_REQUIRED` below admin or when the actor cannot grant the requested role,
   *   `DUPLICATE_INVITEE` when the account already holds membership or a pending invitation, or `NOT_A_MEMBER`
   *   when the actor holds no membership.
   */
  abstract invite(actor: PlatformAccountId, input: InviteInput): Promise<InvitationView>

  /**
   * Retract one invitation issued by the caller while it is still pending.
   * @param actor - authenticated account; must be the invitation's issuer or an owner of the project.
   * @param invitationId - invitation to retract.
   * @returns nothing; the stored state moves to `retracted`.
   * @throws {ProjectMembershipError} `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, or `ROLE_REQUIRED`.
   */
  abstract retractInvitation(actor: PlatformAccountId, invitationId: InvitationId): Promise<void>

  /**
   * Accept one pending invitation; joining and workspace linking commit atomically, so no joined-but-unlinked state can exist.
   * @param actor - authenticated account; must be the invitation's addressee.
   * @param input - invitation id plus the mandatory workspace link.
   * @returns the created member view.
   * @throws {ProjectMembershipError} `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, `DUPLICATE_INVITEE`, or
   *   `INVALID_LINK` when the link omits a workspace name.
   */
  abstract acceptInvitation(actor: PlatformAccountId, input: AcceptInvitationInput): Promise<MemberView>

  /**
   * Decline one pending invitation addressed to the caller.
   * @param actor - authenticated account; must be the invitation's addressee.
   * @param invitationId - invitation to decline.
   * @returns nothing; the stored state moves to `declined`.
   * @throws {ProjectMembershipError} `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, or `ROLE_REQUIRED`.
   */
  abstract declineInvitation(actor: PlatformAccountId, invitationId: InvitationId): Promise<void>

  /**
   * Change one membership's role. Rows whose current or target role is owner answer only to owners; admins may move
   * members between `member` and `admin`.
   * @param actor - authenticated account holding admin or owner.
   * @param input - membership row and new role.
   * @returns nothing; the stored row carries the new role.
   * @throws {ProjectMembershipError} `MEMBERSHIP_NOT_FOUND`, `ROLE_REQUIRED`, or `LAST_OWNER` when demoting the final owner.
   */
  abstract changeRole(actor: PlatformAccountId, input: ChangeRoleInput): Promise<void>

  /**
   * Replace one membership's project-defined function tags; tags are display and routing metadata and never gate permissions.
   * @param actor - authenticated account holding admin or owner.
   * @param input - membership row and replacement tags.
   * @returns nothing; the stored row carries the new tags.
   * @throws {ProjectMembershipError} `MEMBERSHIP_NOT_FOUND` or `ROLE_REQUIRED`.
   */
  abstract setMemberTags(actor: PlatformAccountId, input: SetMemberTagsInput): Promise<void>

  /**
   * Remove one membership. Removing an owner answers only to owners; when members remain after removal, every cached
   * roster projection for the project is invalidated by the same operation.
   * @param actor - authenticated account holding admin or owner.
   * @param membershipId - membership row to remove.
   * @returns nothing.
   * @throws {ProjectMembershipError} `MEMBERSHIP_NOT_FOUND`, `ROLE_REQUIRED`, or `LAST_OWNER` when removing the final owner.
   */
  abstract removeMember(actor: PlatformAccountId, membershipId: MembershipId): Promise<void>

  /**
   * Read one project's full roster; both caller and readers require an active membership, so removed accounts lose enumeration immediately.
   * @param actor - authenticated account whose active membership gates the read.
   * @param projectId - project to project.
   * @returns the roster view derived from current authority, not a stale cache.
   * @throws {ProjectMembershipError} `PROJECT_NOT_FOUND` or `NOT_A_MEMBER`.
   */
  abstract roster(actor: PlatformAccountId, projectId: ProjectId): Promise<RosterView>

  /**
   * List invitations addressed to the caller that still await a decision.
   * @param actor - authenticated account.
   * @returns pending invitations in issuance order.
   */
  abstract pendingInvitationsFor(actor: PlatformAccountId): Promise<readonly InvitationView[]>

  /**
   * List pending invitations issued for one Project after an admin-or-owner gate.
   * @param actor - authenticated Project administrator.
   * @param projectId - Project whose pending invitations are requested.
   * @returns pending invitations in issuance order.
   */
  abstract pendingInvitationsIssuedBy(
    actor: PlatformAccountId,
    projectId: ProjectId,
  ): Promise<readonly InvitationView[]>

  /**
   * List pending invitations with their authoritative project name and remote.
   * @param actor - authenticated invitee account.
   * @returns pending invitation/project pairs in issuance order.
   */
  abstract pendingInvitationContextsFor(actor: PlatformAccountId): Promise<readonly PendingInvitationContext[]>

  /**
   * Find the project bound to a normalized git remote, if the actor holds a membership there.
   * @param actor - authenticated account whose memberships scope the search.
   * @param normalizedRemoteUrl - normalized remote URL recorded at creation.
   * @returns the project view, or undefined when no such membership exists.
   */
  abstract projectByRemote(actor: PlatformAccountId, normalizedRemoteUrl: string): Promise<ProjectView | undefined>

  /**
   * Read one project's current roster projection version. Consumers key caches
   * on it; every committed membership-set or role-or-tag mutation publishes a
   * new strictly increasing value for that project.
   * @param projectId - project to read.
   * @returns the project's roster projection version.
   * @throws {ProjectMembershipError} `PROJECT_NOT_FOUND`.
   */
  abstract rosterVersion(projectId: ProjectId): Promise<number>
}

/** Re-exported so consumers can branch without importing the errors module directly. */
export { ProjectMembershipError }

export default ProjectMembershipService
