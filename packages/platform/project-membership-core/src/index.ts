/**
 * Project Membership provider: durable environment-namespaced JSON state,
 * every mutation executed under one serialized write chain so concurrent
 * callers observe all-or-nothing commits — a failed durable write commits
 * nothing, rolling its batch back before the rejection returns — with each
 * operation enforcing its own role gate before anything persists.
 * @module @deepseek-ai/dsh-project-membership-core
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  duplicateInvitee,
  normalizeGitRemoteUrl,
  ProjectMembershipError,
  ProjectMembershipService,
  type AcceptInvitationInput,
  type ChangeRoleInput,
  type CreateProjectInput,
  type FunctionTag,
  type InvitationId,
  type InvitationState,
  type InvitationView,
  type InviteInput,
  type MemberView,
  type MembershipId,
  type ProjectId,
  type ProjectRole,
  type ProjectView,
  type RosterInvalidation,
  type RosterView,
  type SetMemberTagsInput,
  type WorkspaceLink,
} from '@deepseek-ai/dsh-project-membership'
import { parse, serialize, type PersistedInvitation, type PersistedMembership, type PersistedState } from './persisted-state.ts'

/** Absolute document path for one environment namespace. */
function stateFilePath(storagePath: string, environment: string): string {
  return join(resolve(storagePath), environment, 'project-membership.json')
}

/** Plugin config: where committed state lives and which environment owns it. */
export interface Config {
  /**
   * Directory holding this deployment's durable membership corpus. Each
   * validated environment keeps its own subdirectory below it.
   */
  storagePath: string
  /** Deployment identity isolating project and account namespaces. */
  environment: 'development' | 'production'
}

/** Fixed function-tag vocabulary bounds of the collaboration plane. */
export const FUNCTION_TAG_LIMITS = {
  /** Maximum distinct tags on one membership. */
  count: 8,
  /** Maximum characters in one trimmed tag. */
  length: 32,
} as const

/**
 * Validate plugin config loudly for both Loader-normalized and programmatic
 * construction.
 * @param config - raw plugin config.
 * @returns the same config once its shape is proven.
 */
function resolveConfig(config: Config): Config {
  if (typeof config.storagePath !== 'string' || config.storagePath.trim() === '') {
    throw new TypeError('project-membership-core: config.storagePath must be a non-empty directory path')
  }
  const environment: string = config.environment
  if (environment !== 'development' && environment !== 'production') {
    throw new TypeError(
      `project-membership-core: config.environment must be 'development' or 'production', got ${JSON.stringify(environment)}`,
    )
  }
  return config
}

/** Mutable founding-owner or joined-member row backing one {@link MemberView}. */
interface MembershipRow {
  id: MembershipId
  projectId: ProjectId
  accountId: PlatformAccountId
  role: ProjectRole
  tags: FunctionTag[]
  link?: WorkspaceLink | undefined
  joinedAt: number
}

/** Mutable project row backing one {@link ProjectView}. */
interface ProjectRow {
  id: ProjectId
  name: string
  boundRemoteUrl: string
  createdAt: number
  rosterVersion: number
}

/** Mutable invitation row backing one {@link InvitationView}. */
interface InvitationRow {
  id: InvitationId
  projectId: ProjectId
  inviterAccountId: PlatformAccountId
  inviteeAccountId: PlatformAccountId
  state: InvitationState
  invitedAt: number
  settledAt?: number | undefined
}

const noop = (): void => {}
const duplicateKey = (projectId: ProjectId, accountId: PlatformAccountId): string => `${projectId}:${accountId}`

/**
 * Mutation payload of one published roster invalidation, mirroring the
 * `RosterInvalidation` variant vocabulary without the shared identity fields.
 */
type RosterMutationDetail =
  | { readonly reason: 'joined' }
  | { readonly reason: 'removed' }
  | { readonly reason: 'role-changed'; readonly role: ProjectRole }
  | { readonly reason: 'tags-changed'; readonly tags: readonly FunctionTag[] }

/**
 * File-backed Project Membership provider mounted once per composition.
 * Reads derive from the authoritative in-memory state; writes serialize
 * through one chain, republish the whole document atomically, and only then
 * emit their roster-invalidation record. Memory publishes state only at its
 * durable commit point: a rejected write rolls the operation's exact
 * mutation batch back, so no later commit can publish a row the document
 * refused.
 */
export class FileProjectMembership extends ProjectMembershipService {
  static Config: z<Config> = z.object({
    storagePath: z.string(),
    environment: z.union(['development', 'production'] as const),
  })

  /** Durable document path; the environment segment is the namespace isolation. */
  readonly storageFile: string

  private readonly projects = new Map<ProjectId, ProjectRow>()
  private readonly projectNameIndex = new Map<string, ProjectId>()
  private readonly projectMemberships = new Map<ProjectId, Map<MembershipId, MembershipRow>>()
  private readonly membershipAccounts = new Map<string, MembershipRow>()
  private readonly invitations = new Map<InvitationId, InvitationRow>()
  private readonly pendingInvitees = new Map<string, InvitationRow>()
  /**
   * Single exclusive operation chain: load and every mutation run one at a
   * time in queue order (settled tail), so interleaved invites cannot both
   * pass the duplicate check and one commit never observes another's partial
   * state.
   */
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false
  /**
   * Corruption error from the one document load. Cordis cannot await a
   * constructor-era effect, so the store itself must carry the rejection to
   * every caller; non-Error throw values are normalized so the stored reason
   * is always an Error.
   */
  private loadFailure: { reason: Error } | undefined

  /**
   * @param ctx - Cordis context receiving the `projectMembership` service.
   * @param config - validated {@link Config}.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const validated = resolveConfig(config)
    this.storageFile = stateFilePath(validated.storagePath, validated.environment)
    ctx.effect(async () => {
      await this.enqueue(() => this.load())
      return async () => {
        this.disposed = true
        // Let any in-flight durable write finish instead of abandoning it.
        await this.chain
      }
    }, 'project-membership: durable-state lifecycle')
  }

  override createProject(actor: PlatformAccountId, input: CreateProjectInput): Promise<ProjectView> {
    return this.enqueue(() => this.createProjectOp(actor, input))
  }

  override invite(actor: PlatformAccountId, input: InviteInput): Promise<InvitationView> {
    return this.enqueue(() => this.inviteOp(actor, input))
  }

  override retractInvitation(actor: PlatformAccountId, invitationId: InvitationId): Promise<void> {
    return this.enqueue(() => this.retractOp(actor, invitationId))
  }

  override acceptInvitation(actor: PlatformAccountId, input: AcceptInvitationInput): Promise<MemberView> {
    return this.enqueue(() => this.acceptOp(actor, input))
  }

  override declineInvitation(actor: PlatformAccountId, invitationId: InvitationId): Promise<void> {
    return this.enqueue(() => this.declineOp(actor, invitationId))
  }

  override changeRole(actor: PlatformAccountId, input: ChangeRoleInput): Promise<void> {
    return this.enqueue(() => this.changeRoleOp(actor, input))
  }

  override setMemberTags(actor: PlatformAccountId, input: SetMemberTagsInput): Promise<void> {
    return this.enqueue(() => this.setMemberTagsOp(actor, input))
  }

  override removeMember(actor: PlatformAccountId, membershipId: MembershipId): Promise<void> {
    return this.enqueue(() => this.removeMemberOp(actor, membershipId))
  }

  override roster(actor: PlatformAccountId, projectId: ProjectId): Promise<RosterView> {
    return this.enqueue(() => {
      const project = this.requireProject(projectId)
      this.requireMembershipIn(actor, projectId)
      return this.rosterOf(project)
    })
  }

  override pendingInvitationsFor(actor: PlatformAccountId): Promise<readonly InvitationView[]> {
    return this.enqueue(() =>
      Promise.resolve([...this.invitations.values()]
        .filter(row => row.inviteeAccountId === actor && row.state === 'pending')
        .sort((left, right) => left.invitedAt - right.invitedAt)
        .map(cloneInvitation)))
  }

  override projectByRemote(actor: PlatformAccountId, normalizedRemoteUrl: string): Promise<ProjectView | undefined> {
    return this.enqueue(() => {
      const owned = [...this.projects.values()]
        .filter(project => this.requireMembershipRowOrUndefined(actor, project.id) !== undefined)
        .sort((left, right) => left.createdAt - right.createdAt)
      const found = owned.find(project => project.boundRemoteUrl === normalizedRemoteUrl)
      return found === undefined ? undefined : cloneProject(found)
    })
  }

  override rosterVersion(projectId: ProjectId): Promise<number> {
    return this.enqueue(() => this.requireProject(projectId).rosterVersion)
  }

  /** Run one exclusive operation behind the settled tail of the write chain. */
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('project-membership: store has been disposed'))
    // The load may still be in flight when an operation is enqueued, so the
    // corruption gate is re-checked at run time, not only at call time.
    const run = (): Promise<T> => {
      if (this.loadFailure !== undefined) return Promise.reject(this.loadFailure.reason)
      return Promise.resolve(operation())
    }
    const result = this.chain.then(run, run)
    this.chain = result.then(noop, noop)
    return result
  }

  /**
   * Load the environment document once; absence is the empty first boot. A
   * document that fails validation rejects the load before any row reaches
   * the in-memory maps, and the store records the corruption error so every
   * later operation rejects instead of serving or republishing an empty
   * corpus.
   */
  private async load(): Promise<void> {
    try {
      await this.loadDocument()
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error))
      this.loadFailure = { reason }
      throw reason
    }
  }

  private async loadDocument(): Promise<void> {
    let text: string | undefined
    try {
      text = await readFile(this.storageFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (text === undefined) return
    const state = parse(text)
    for (const project of state.projects) {
      const row: ProjectRow = { ...project, id: project.id as ProjectId }
      this.projects.set(row.id, row)
      this.projectNameIndex.set(row.name, row.id)
      this.projectMemberships.set(row.id, new Map())
    }
    for (const membership of state.memberships) {
      const row = restoreMembership(membership)
      // parse() already rejected dangling projectIds, so this guard only ever
      // fires on a document that reached the maps through another door.
      const memberships = this.projectMemberships.get(row.projectId)
      if (memberships === undefined) {
        throw new Error(
          `project-membership: durable state membership ${row.id} references unknown project ${row.projectId}`,
        )
      }
      memberships.set(row.id, row)
      this.membershipAccounts.set(duplicateKey(row.projectId, row.accountId), row)
    }
    for (const invitation of state.invitations) {
      const row = restoreInvitation(invitation)
      this.invitations.set(row.id, row)
      if (row.state === 'pending') this.pendingInvitees.set(duplicateKey(row.projectId, row.inviteeAccountId), row)
    }
  }

  /** Atomically publish the complete committed state. */
  private async persist(): Promise<void> {
    const state: PersistedState = {
      formatVersion: 0,
      projects: [...this.projects.values()].map(project => ({
        id: project.id,
        name: project.name,
        boundRemoteUrl: project.boundRemoteUrl,
        createdAt: project.createdAt,
        rosterVersion: project.rosterVersion,
      })),
      memberships: [...this.projectMemberships.values()]
        .flatMap(memberships => [...memberships.values()])
        .map(toPersistedMembership),
      invitations: [...this.invitations.values()].map(toPersistedInvitation),
    }
    await writeFileAtomic(this.storageFile, serialize(state), { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Commit the already-applied mutation batch at its durable point: the
   * document write must succeed before the batch stays in memory. A failed
   * write runs `rollback` — the exact inverse of the batch `persist` just
   * serialized — and rethrows, leaving memory and disk as if the operation
   * never ran. Serialization through the write chain makes the applied batch
   * invisible until this point, so the rollback restores the exact pre-call
   * state.
   * @param rollback - inverse of the one mutation batch awaiting durability.
   */
  private async commit(rollback: () => void): Promise<void> {
    try {
      await this.persist()
    } catch (error) {
      rollback()
      throw error
    }
  }

  private requireProject(projectId: ProjectId): ProjectRow {
    const project = this.projects.get(projectId)
    if (project === undefined) throw new ProjectMembershipError('PROJECT_NOT_FOUND', `project ${projectId} is unknown`)
    return project
  }

  private requireMembershipRowOrUndefined(accountId: PlatformAccountId, projectId: ProjectId): MembershipRow | undefined {
    return this.membershipAccounts.get(duplicateKey(projectId, accountId))
  }

  private requireMembershipIn(accountId: PlatformAccountId, projectId: ProjectId): MembershipRow {
    const row = this.requireMembershipRowOrUndefined(accountId, projectId)
    if (row === undefined) {
      throw new ProjectMembershipError('NOT_A_MEMBER', `account ${accountId} holds no membership in ${projectId}`)
    }
    return row
  }

  /** Admin-or-above gate enforced inside the mutating operation itself. */
  private requireAdmin(actor: PlatformAccountId, projectId: ProjectId): MembershipRow {
    const row = this.requireMembershipIn(actor, projectId)
    if (row.role === 'member') {
      throw new ProjectMembershipError('ROLE_REQUIRED', 'this operation requires the admin or owner role')
    }
    return row
  }

  /**
   * Owner-row gate: changing or removing a row whose current or target role
   * is owner answers only to owners.
   */
  private requireOwnerAuthority(
    actor: PlatformAccountId,
    projectId: ProjectId,
    targetRole: ProjectRole,
    nextRole?: ProjectRole,
  ): void {
    const touchesOwner = targetRole === 'owner' || nextRole === 'owner'
    if (!touchesOwner) return
    if (this.requireMembershipIn(actor, projectId).role !== 'owner') {
      throw new ProjectMembershipError('ROLE_REQUIRED', 'rows at or moving toward the owner role answer only to owners')
    }
  }

  private ownerCount(projectId: ProjectId): number {
    return [...(this.projectMemberships.get(projectId)?.values() ?? [])]
      .filter(row => row.role === 'owner').length
  }

  /** Refuse retiring the only remaining owner of one project. */
  private assertNotFinalOwner(projectId: ProjectId): void {
    if (this.ownerCount(projectId) > 1) return
    throw new ProjectMembershipError('LAST_OWNER', 'the final owner of a project cannot lose the owner role')
  }

  /**
   * Publish one committed membership mutation strictly after durability.
   * A synchronous `ctx.emit` inside a running operation delivers to listeners
   * inline: listener callbacks re-entering this service enqueue behind the
   * current operation (safe), while a listener awaiting the emit's return
   * value self-deadlocks on that same write chain.
   */
  private publish(
    project: ProjectRow,
    detail: RosterMutationDetail,
    identity: { projectId: ProjectId; membershipId: MembershipId; accountId: PlatformAccountId },
  ): void {
    const rosterVersionBefore = project.rosterVersion
    const rosterVersionAfter = project.rosterVersion + 1
    project.rosterVersion = rosterVersionAfter
    const base = { ...identity, rosterVersionBefore, rosterVersionAfter }
    const change: RosterInvalidation = buildInvalidation(base, detail)
    this.ctx.emit('project-membership/roster-invalidated', change)
  }

  private async createProjectOp(actor: PlatformAccountId, input: CreateProjectInput): Promise<ProjectView> {
    const name = input.name.trim()
    if (name === '') throw new ProjectMembershipError('INVALID_PROJECT_NAME', 'project name must contain visible characters')
    if (this.projectNameIndex.has(name)) {
      throw new ProjectMembershipError('PROJECT_NAME_TAKEN', `project name ${name} is already in use`)
    }
    const boundRemoteUrl = normalizeGitRemoteUrl(input.remoteUrl)
    const now = Date.now()
    const project: ProjectRow = { id: randomUUID() as ProjectId, name, boundRemoteUrl, createdAt: now, rosterVersion: 0 }
    const founder: MembershipRow = {
      id: randomUUID() as MembershipId,
      projectId: project.id,
      accountId: actor,
      role: 'owner',
      tags: [],
      link: undefined,
      joinedAt: now,
    }
    this.projects.set(project.id, project)
    this.projectNameIndex.set(name, project.id)
    this.projectMemberships.set(project.id, new Map([[founder.id, founder]]))
    this.membershipAccounts.set(duplicateKey(project.id, actor), founder)
    await this.commit(() => {
      this.projects.delete(project.id)
      this.projectNameIndex.delete(name)
      this.projectMemberships.delete(project.id)
      this.membershipAccounts.delete(duplicateKey(project.id, actor))
    })
    this.publish(project, { reason: 'joined' }, {
      projectId: project.id,
      membershipId: founder.id,
      accountId: actor,
    })
    return cloneProject(project)
  }

  private async inviteOp(actor: PlatformAccountId, input: InviteInput): Promise<InvitationView> {
    this.requireAdmin(actor, input.projectId)
    if (this.requireMembershipRowOrUndefined(input.inviteeAccountId, input.projectId) !== undefined
      || this.pendingInvitees.has(duplicateKey(input.projectId, input.inviteeAccountId))) {
      throw duplicateInvitee(input.inviteeAccountId)
    }
    const row: InvitationRow = {
      id: randomUUID() as InvitationId,
      projectId: input.projectId,
      inviterAccountId: actor,
      inviteeAccountId: input.inviteeAccountId,
      state: 'pending',
      invitedAt: Date.now(),
      settledAt: undefined,
    }
    this.invitations.set(row.id, row)
    this.pendingInvitees.set(duplicateKey(row.projectId, row.inviteeAccountId), row)
    await this.commit(() => {
      this.invitations.delete(row.id)
      this.pendingInvitees.delete(duplicateKey(row.projectId, row.inviteeAccountId))
    })
    return cloneInvitation(row)
  }

  private settlePending(row: InvitationRow, state: Exclude<InvitationState, 'pending'>): void {
    row.state = state
    row.settledAt = Date.now()
    this.pendingInvitees.delete(duplicateKey(row.projectId, row.inviteeAccountId))
  }

  /** Inverse of {@link settlePending}: restore the row to its pending spelling. */
  private unsettlePending(row: InvitationRow): void {
    row.state = 'pending'
    row.settledAt = undefined
    this.pendingInvitees.set(duplicateKey(row.projectId, row.inviteeAccountId), row)
  }

  /** Resolve one invitation to its row, proving addressee scope along the way. */
  private requireAddressedInvitation(actor: PlatformAccountId, invitationId: InvitationId, addresseeGate: boolean): InvitationRow {
    const row = this.invitations.get(invitationId)
    if (row === undefined || (addresseeGate && row.inviteeAccountId !== actor)) {
      // Addressee identity is private; other accounts see no such invitation.
      throw new ProjectMembershipError('INVITATION_NOT_FOUND', `invitation ${invitationId} is unknown`)
    }
    if (row.state !== 'pending') {
      throw new ProjectMembershipError('INVITATION_NOT_PENDING', `invitation ${invitationId} already reached ${row.state}`)
    }
    return row
  }

  private parseLink(link: WorkspaceLink): WorkspaceLink {
    // Wire/durable entry guard for the `INVALID_LINK` clause of the
    // acceptInvitation contract: the link crosses the tool-JSON surface, where
    // workspaceName can arrive blank or not a string at all.
    const workspaceName = typeof link.workspaceName === 'string' ? link.workspaceName.trim() : ''
    if (workspaceName === '') {
      throw new ProjectMembershipError('INVALID_LINK', 'accepting requires naming the linked local workspace')
    }
    if (link.normalizedRemoteUrl === undefined) return { workspaceName }
    return { workspaceName, normalizedRemoteUrl: normalizeGitRemoteUrl(link.normalizedRemoteUrl) }
  }

  private async acceptOp(actor: PlatformAccountId, input: AcceptInvitationInput): Promise<MemberView> {
    const invitation = this.requireAddressedInvitation(actor, input.invitationId, true)
    if (this.requireMembershipRowOrUndefined(invitation.inviteeAccountId, invitation.projectId) !== undefined) {
      throw duplicateInvitee(invitation.inviteeAccountId)
    }
    const link = this.parseLink(input.link)
    const member: MembershipRow = {
      id: randomUUID() as MembershipId,
      projectId: invitation.projectId,
      accountId: invitation.inviteeAccountId,
      role: 'member',
      tags: [],
      link,
      joinedAt: Date.now(),
    }
    this.projectMemberships.get(member.projectId)?.set(member.id, member)
    this.membershipAccounts.set(duplicateKey(member.projectId, member.accountId), member)
    this.settlePending(invitation, 'accepted')
    const project = this.requireProject(invitation.projectId)
    await this.commit(() => {
      this.projectMemberships.get(member.projectId)?.delete(member.id)
      this.membershipAccounts.delete(duplicateKey(member.projectId, member.accountId))
      this.unsettlePending(invitation)
    })
    this.publish(project, { reason: 'joined' }, {
      projectId: member.projectId,
      membershipId: member.id,
      accountId: member.accountId,
    })
    return cloneMembership(member)
  }

  private async declineOp(actor: PlatformAccountId, invitationId: InvitationId): Promise<void> {
    const invitation = this.requireAddressedInvitation(actor, invitationId, true)
    this.settlePending(invitation, 'declined')
    await this.commit(() => { this.unsettlePending(invitation) })
  }

  private async retractOp(actor: PlatformAccountId, invitationId: InvitationId): Promise<void> {
    const invitation = this.requireAddressedInvitation(actor, invitationId, false)
    if (invitation.inviterAccountId !== actor
      && this.requireMembershipIn(actor, invitation.projectId).role !== 'owner') {
      throw new ProjectMembershipError('ROLE_REQUIRED', 'only the issuing account or a project owner can retract')
    }
    this.settlePending(invitation, 'retracted')
    await this.commit(() => { this.unsettlePending(invitation) })
  }

  /** Locate a membership row among projects where the actor holds a membership. */
  private requireScopedMembershipRow(actor: PlatformAccountId, membershipId: MembershipId): MembershipRow {
    for (const [projectId, memberships] of this.projectMemberships) {
      if (this.requireMembershipRowOrUndefined(actor, projectId) === undefined) continue
      const row = memberships.get(membershipId)
      if (row !== undefined) return row
    }
    throw new ProjectMembershipError('MEMBERSHIP_NOT_FOUND', `membership ${membershipId} is unknown to your projects`)
  }

  private async changeRoleOp(actor: PlatformAccountId, input: ChangeRoleInput): Promise<void> {
    const target = this.requireScopedMembershipRow(actor, input.membershipId)
    if (this.requireMembershipIn(actor, target.projectId).role === 'member') {
      throw new ProjectMembershipError('ROLE_REQUIRED', 'this operation requires the admin or owner role')
    }
    this.requireOwnerAuthority(actor, target.projectId, target.role, input.role)
    if (target.role === 'owner' && input.role !== 'owner') {
      this.assertNotFinalOwner(target.projectId)
    }
    const previousRole = target.role
    target.role = input.role
    const project = this.requireProject(target.projectId)
    await this.commit(() => {
      target.role = previousRole
    })
    this.publish(project, { reason: 'role-changed', role: target.role }, {
      projectId: target.projectId,
      membershipId: target.id,
      accountId: target.accountId,
    })
  }

  private validateFunctionTags(tags: readonly FunctionTag[]): FunctionTag[] {
    const values = [...tags]
    if (values.length > FUNCTION_TAG_LIMITS.count) {
      throw new ProjectMembershipError('INVALID_TAGS', `at most ${FUNCTION_TAG_LIMITS.count} function tags are allowed`)
    }
    for (const value of values) {
      if (value === '' || value.trim() !== value || value.length > FUNCTION_TAG_LIMITS.length) {
        throw new ProjectMembershipError(
          'INVALID_TAGS',
          `function tags must carry 1..${FUNCTION_TAG_LIMITS.length} visible characters`,
        )
      }
    }
    if (new Set(values).size !== values.length) {
      throw new ProjectMembershipError('INVALID_TAGS', 'function tags must be distinct')
    }
    return values
  }

  private async setMemberTagsOp(actor: PlatformAccountId, input: SetMemberTagsInput): Promise<void> {
    const target = this.requireScopedMembershipRow(actor, input.membershipId)
    if (this.requireMembershipIn(actor, target.projectId).role === 'member') {
      throw new ProjectMembershipError('ROLE_REQUIRED', 'editing function tags requires the admin or owner role')
    }
    const previousTags = target.tags
    target.tags = this.validateFunctionTags(input.tags)
    const project = this.requireProject(target.projectId)
    await this.commit(() => {
      target.tags = previousTags
    })
    this.publish(project, { reason: 'tags-changed', tags: [...target.tags] }, {
      projectId: target.projectId,
      membershipId: target.id,
      accountId: target.accountId,
    })
  }

  private async removeMemberOp(actor: PlatformAccountId, membershipId: MembershipId): Promise<void> {
    const target = this.requireScopedMembershipRow(actor, membershipId)
    if (this.requireMembershipIn(actor, target.projectId).role === 'member') {
      throw new ProjectMembershipError('ROLE_REQUIRED', 'removing members requires the admin or owner role')
    }
    this.requireOwnerAuthority(actor, target.projectId, target.role)
    if (target.role === 'owner') this.assertNotFinalOwner(target.projectId)
    const removedAccount = target.accountId
    const removedMembershipId = target.id
    this.projectMemberships.get(target.projectId)?.delete(target.id)
    this.membershipAccounts.delete(duplicateKey(target.projectId, removedAccount))
    const project = this.requireProject(target.projectId)
    await this.commit(() => {
      this.projectMemberships.get(target.projectId)?.set(target.id, target)
      this.membershipAccounts.set(duplicateKey(target.projectId, removedAccount), target)
    })
    this.publish(project, { reason: 'removed' }, {
      projectId: target.projectId,
      membershipId: removedMembershipId,
      accountId: removedAccount,
    })
  }

  private rosterOf(project: ProjectRow): RosterView {
    const members = [...(this.projectMemberships.get(project.id)?.values() ?? [])]
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map(cloneMembership)
    return { project: cloneProject(project), members }
  }
}

/** Build the exact published variant for one committed mutation. */
function buildInvalidation(
  base: {
    projectId: ProjectId
    membershipId: MembershipId
    accountId: PlatformAccountId
    rosterVersionBefore: number
    rosterVersionAfter: number
  },
  detail: RosterMutationDetail,
): RosterInvalidation {
  switch (detail.reason) {
    case 'joined': return { ...base, reason: detail.reason }
    case 'removed': return { ...base, reason: detail.reason }
    case 'role-changed': return { ...base, reason: detail.reason, role: detail.role }
    case 'tags-changed': return { ...base, reason: detail.reason, tags: [...detail.tags] }
    default: return detail satisfies never
  }
}

/** Rehydrate one authoritative membership row from its durable spelling. */
function restoreMembership(persisted: PersistedMembership): MembershipRow {
  return {
    id: persisted.id as MembershipId,
    projectId: persisted.projectId as ProjectId,
    accountId: persisted.accountId as PlatformAccountId,
    role: persisted.role,
    tags: persisted.tags.map(tag => tag as FunctionTag),
    ...(persisted.link === undefined ? {} : { link: persisted.link }),
    joinedAt: persisted.joinedAt,
  }
}

/** Rehydrate one authoritative invitation row from its durable spelling. */
function restoreInvitation(persisted: PersistedInvitation): InvitationRow {
  return {
    id: persisted.id as InvitationId,
    projectId: persisted.projectId as ProjectId,
    inviterAccountId: persisted.inviterAccountId as PlatformAccountId,
    inviteeAccountId: persisted.inviteeAccountId as PlatformAccountId,
    state: persisted.state,
    invitedAt: persisted.invitedAt,
    ...(persisted.settledAt === undefined ? {} : { settledAt: persisted.settledAt }),
  }
}

/** Render one authoritative membership row into its exact durable spelling. */
function toPersistedMembership(row: MembershipRow): PersistedMembership {
  return {
    id: row.id,
    projectId: row.projectId,
    accountId: row.accountId,
    role: row.role,
    tags: [...row.tags],
    ...(row.link === undefined ? {} : { link: { ...row.link } }),
    joinedAt: row.joinedAt,
  }
}

/** Render one invitation row into its exact durable spelling. */
function toPersistedInvitation(row: InvitationRow): PersistedInvitation {
  return {
    id: row.id,
    projectId: row.projectId,
    inviterAccountId: row.inviterAccountId,
    inviteeAccountId: row.inviteeAccountId,
    state: row.state,
    invitedAt: row.invitedAt,
    ...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
  }
}

function cloneProject(project: ProjectRow): ProjectView {
  return {
    id: project.id,
    name: project.name,
    boundRemoteUrl: project.boundRemoteUrl,
    createdAt: project.createdAt,
  }
}

function cloneMembership(membership: MembershipRow): MemberView {
  return {
    id: membership.id,
    accountId: membership.accountId,
    role: membership.role,
    tags: [...membership.tags],
    ...(membership.link === undefined ? {} : { link: { ...membership.link } }),
    joinedAt: membership.joinedAt,
  }
}

function cloneInvitation(invitation: InvitationRow): InvitationView {
  return {
    id: invitation.id,
    projectId: invitation.projectId,
    inviterAccountId: invitation.inviterAccountId,
    inviteeAccountId: invitation.inviteeAccountId,
    state: invitation.state,
    invitedAt: invitation.invitedAt,
    ...(invitation.settledAt === undefined ? {} : { settledAt: invitation.settledAt }),
  }
}

export default FileProjectMembership
