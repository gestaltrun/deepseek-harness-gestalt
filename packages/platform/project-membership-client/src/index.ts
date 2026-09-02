/**
 * Browser client for Project Membership: one transport over the membership
 * HTTP consumer's `/v1/projects` routes (project creation, roster reads,
 * invitation issue/decision/retraction/poll, presence heartbeat and close,
 * and member role, tag, and removal). Authorization rides the caller-supplied
 * Account session presentation headers (bearer token plus installation
 * proof); this client never touches the signing key. Error answers keep the
 * domain envelope: non-OK responses reject with the stable code and HTTP
 * status, so a 403 role gate surfaces as `ROLE_REQUIRED`/403 rather than a
 * generic failure.
 * @module @deepseek-ai/dsh-project-membership-client
 */

import type {
  FunctionTag,
  InvitationId,
  InvitationView,
  MemberView,
  MembershipId,
  ProjectId,
  ProjectRole,
  ProjectView,
  WorkspaceLink,
} from '@deepseek-ai/dsh-project-membership'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'

export {
  type FunctionTag, type InvitationId, type InvitationView, type MemberView,
  type MembershipId, type ProjectId, type ProjectRole, type ProjectView,
  type WorkspaceLink, normalizeGitRemoteUrl,
} from '@deepseek-ai/dsh-project-membership'
export type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'

/** Stable failure of one membership route call: envelope code plus HTTP status. */
export class ProjectMembershipClientError extends Error {
  /** Stable envelope code (domain code, or `HTTP_<status>` without a JSON envelope). */
  readonly code: string
  /** HTTP status of the failed response. */
  readonly status: number

  /** @param code - stable envelope code. @param status - HTTP status. @param message - envelope message. */
  constructor(code: string, status: number, message: string) {
    super(`Project Membership request failed (${status} ${code}): ${message}`)
    this.name = 'ProjectMembershipClientError'
    this.code = code
    this.status = status
  }
}

/** Account session presentation headers for one authenticated request. */
export type MembershipAuthorization = HeadersInit

/** One roster member with presence and public identity attached by the roster read. */
export type RosterMemberView = MemberView & {
  /** Presence verdict of the aggregation plane. */
  readonly presence: 'online' | 'offline'
  /** Current public GitHub login; empty when the Account plane does not know the account. */
  readonly displayName: string
  /** Current public avatar URL; empty when the Account plane does not know the account. */
  readonly avatarRef: string
}

/** Roster read response: the project plus its presence-decorated members. */
export interface RosterReadView {
  /** The queried project. */
  readonly project: ProjectView
  /** Every membership row ordered by join time, each with presence and identity. */
  readonly members: readonly RosterMemberView[]
}

/** One Project together with the authenticated Account whose membership authorized the read. */
export type AuthenticatedProjectView = ProjectView & {
  readonly receivingAccountId: PlatformAccountId
}

/** Trusted invitation card returned before the local Account joins a project. */
export interface PendingInvitationView {
  readonly invitationId: InvitationId
  readonly receivingAccountId: PlatformAccountId
  readonly projectId: ProjectId
  readonly projectName: string
  readonly remoteUrl: string
  readonly inviterName: string
  readonly invitedAt: number
}

/** One pending invitation issued from a Project with the invitee's public login. */
export interface IssuedInvitationView {
  readonly invitationId: InvitationId
  readonly inviteeName: string
  readonly invitedAt: number
}

/** One invitation decision body: decline, or accept joined atomically with the workspace link. */
export type InvitationDecisionInput =
  | { decision: 'decline' }
  | { decision: 'accept-with-link'; link: WorkspaceLink }

/** Transport operations used by the workspace upgrade and invite surfaces. */
export interface ProjectMembershipTransport {
  createProject(authorization: MembershipAuthorization, input: { name: string; remoteUrl: string }): Promise<AuthenticatedProjectView>
  projectByRemote(
    authorization: MembershipAuthorization,
    normalizedRemoteUrl: string,
  ): Promise<AuthenticatedProjectView | undefined>
  roster(authorization: MembershipAuthorization, projectId: ProjectId): Promise<RosterReadView>
  heartbeat(authorization: MembershipAuthorization): Promise<void>
  closePresence(authorization: MembershipAuthorization): Promise<void>
  invite(
    authorization: MembershipAuthorization,
    input: { projectId: ProjectId; githubLogin: string },
  ): Promise<InvitationView>
  decideInvitation(
    authorization: MembershipAuthorization,
    invitationId: InvitationId,
    input: InvitationDecisionInput,
  ): Promise<MemberView | undefined>
  retractInvitation(authorization: MembershipAuthorization, invitationId: InvitationId): Promise<void>
  pendingInvitations(authorization: MembershipAuthorization): Promise<readonly PendingInvitationView[]>
  issuedInvitations(
    authorization: MembershipAuthorization,
    projectId: ProjectId,
  ): Promise<readonly IssuedInvitationView[]>
  changeRole(authorization: MembershipAuthorization, membershipId: MembershipId, role: ProjectRole): Promise<void>
  setMemberTags(authorization: MembershipAuthorization, membershipId: MembershipId, tags: readonly FunctionTag[]): Promise<void>
  removeMember(authorization: MembershipAuthorization, membershipId: MembershipId): Promise<void>
}

/** Authenticated current-installation client used by product UI consumers. */
export interface ProjectMembershipClient {
  /**
   * Create one Cloud Project for a Workspace remote.
   * @param input - unique name and Workspace remote.
   * @returns created Cloud Project.
   */
  createProject(input: { name: string; remoteUrl: string }): Promise<AuthenticatedProjectView>
  /**
   * Resolve the current Account's Project membership for one normalized Git remote.
   * @param normalizedRemoteUrl - canonical Workspace origin remote.
   * @returns authorized Project context, or no value when this Account has no membership.
   */
  projectByRemote(normalizedRemoteUrl: string): Promise<AuthenticatedProjectView | undefined>
  /**
   * Read one Project roster with public identity and presence.
   * @param projectId - Project to read.
   * @returns Project and complete decorated roster.
   */
  roster(projectId: ProjectId): Promise<RosterReadView>
  /**
   * Refresh this Desktop Installation's live presence heartbeat.
   * @returns fulfillment after Platform records the beat.
   */
  heartbeat(): Promise<void>
  /**
   * Clear this Desktop Installation immediately so roster readers see Offline
   * without waiting for presence TTL.
   * @returns fulfillment after Platform drops this installation.
   */
  closePresence(): Promise<void>
  /**
   * Invite one uniquely resolved public GitHub login.
   * @param input - Project and public GitHub login.
   * @returns created pending invitation.
   */
  invite(input: { projectId: ProjectId; githubLogin: string }): Promise<InvitationView>
  /**
   * Decline, or accept atomically with a local Workspace link.
   * @param invitationId - invitation to decide.
   * @param input - decline or linked acceptance.
   * @returns accepted member, or no value for decline.
   */
  decideInvitation(invitationId: InvitationId, input: InvitationDecisionInput): Promise<MemberView | undefined>
  /**
   * Retract one pending invitation as its Project administrator.
   * @param invitationId - pending invitation to retract.
   */
  retractInvitation(invitationId: InvitationId): Promise<void>
  /**
   * List trusted pending invitation cards for the current Account.
   * @returns trusted pending invitation cards.
   */
  pendingInvitations(): Promise<readonly PendingInvitationView[]>
  /**
   * List pending invitations issued from one administered Project.
   * @param projectId - Project whose issued invitations are requested.
   * @returns authoritative pending invitation rows.
   */
  issuedInvitations(projectId: ProjectId): Promise<readonly IssuedInvitationView[]>
  /**
   * Replace one member's collaboration role.
   * @param membershipId - membership to change.
   * @param role - replacement collaboration role.
   */
  changeRole(membershipId: MembershipId, role: ProjectRole): Promise<void>
  /**
   * Replace one member's non-permission function tags.
   * @param membershipId - membership to relabel.
   * @param tags - complete replacement function tags.
   */
  setMemberTags(membershipId: MembershipId, tags: readonly FunctionTag[]): Promise<void>
  /**
   * Remove one member from the Project.
   * @param membershipId - membership to remove.
   */
  removeMember(membershipId: MembershipId): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    projectMembershipClient: ProjectMembershipClient
  }
}

/** HTTP transport construction inputs. */
export interface ProjectMembershipHttpTransportOptions {
  /** Deployment origin owning every request (the Platform environment origin). */
  origin: string
  fetch?: typeof fetch
}

/** Browser HTTP transport for the Project Membership routes. */
export class ProjectMembershipHttpTransport implements ProjectMembershipTransport {
  private readonly origin: string
  private readonly fetch: typeof fetch

  /** @param options - deployment origin and HTTP adapter. */
  constructor(options: ProjectMembershipHttpTransportOptions) {
    this.origin = options.origin
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  createProject(authorization: MembershipAuthorization, input: { name: string; remoteUrl: string }): Promise<AuthenticatedProjectView> {
    return this.json('/v1/projects', { method: 'POST', headers: authorization, body: JSON.stringify(input) }, parseAuthenticatedProjectView)
  }

  async projectByRemote(
    authorization: MembershipAuthorization,
    normalizedRemoteUrl: string,
  ): Promise<AuthenticatedProjectView | undefined> {
    const path = `/v1/projects/by-remote?remoteUrl=${encodeURIComponent(normalizedRemoteUrl)}`
    const response = await this.request(path, { method: 'GET', headers: authorization })
    if (response.status === 204) return undefined
    return parseAuthenticatedProjectView(await response.json())
  }

  roster(authorization: MembershipAuthorization, projectId: ProjectId): Promise<RosterReadView> {
    return this.json(`/v1/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'GET', headers: authorization,
    }, parseRosterReadView)
  }

  async heartbeat(authorization: MembershipAuthorization): Promise<void> {
    await this.request('/v1/projects/presence/heartbeat', { method: 'POST', headers: authorization })
  }

  async closePresence(authorization: MembershipAuthorization): Promise<void> {
    await this.request('/v1/projects/presence/close', { method: 'POST', headers: authorization })
  }

  invite(
    authorization: MembershipAuthorization,
    input: { projectId: ProjectId; githubLogin: string },
  ): Promise<InvitationView> {
    return this.json('/v1/projects/invitations', {
      method: 'POST', headers: authorization, body: JSON.stringify(input),
    }, parseInvitationView)
  }

  async decideInvitation(
    authorization: MembershipAuthorization,
    invitationId: InvitationId,
    input: InvitationDecisionInput,
  ): Promise<MemberView | undefined> {
    return this.json(
      `/v1/projects/invitations/${encodeURIComponent(invitationId)}/decision`,
      { method: 'POST', headers: authorization, body: JSON.stringify(input) },
      (value) => {
        // A decline settles without joining: the route answers 204 No Content.
        if (value === undefined) return undefined
        return parseJoinedMemberView(value)
      },
    )
  }

  async retractInvitation(authorization: MembershipAuthorization, invitationId: InvitationId): Promise<void> {
    await this.request(`/v1/projects/invitations/${encodeURIComponent(invitationId)}/retraction`, {
      method: 'POST', headers: authorization, body: '{}',
    })
  }

  async pendingInvitations(authorization: MembershipAuthorization): Promise<readonly PendingInvitationView[]> {
    const rows = await this.json('/v1/projects/invitations/pending', {
      method: 'GET', headers: authorization,
    }, parseArray)
    return rows.map(parsePendingInvitationView)
  }

  async issuedInvitations(
    authorization: MembershipAuthorization,
    projectId: ProjectId,
  ): Promise<readonly IssuedInvitationView[]> {
    const rows = await this.json(`/v1/projects/${encodeURIComponent(projectId)}/invitations`, {
      method: 'GET', headers: authorization,
    }, parseArray)
    return rows.map(parseIssuedInvitationView)
  }

  async changeRole(authorization: MembershipAuthorization, membershipId: MembershipId, role: ProjectRole): Promise<void> {
    await this.request(`/v1/projects/memberships/${encodeURIComponent(membershipId)}/role`, {
      method: 'POST', headers: authorization, body: JSON.stringify({ role }),
    })
  }

  async setMemberTags(
    authorization: MembershipAuthorization,
    membershipId: MembershipId,
    tags: readonly FunctionTag[],
  ): Promise<void> {
    await this.request(`/v1/projects/memberships/${encodeURIComponent(membershipId)}/tags`, {
      method: 'POST', headers: authorization, body: JSON.stringify({ tags: [...tags] }),
    })
  }

  async removeMember(authorization: MembershipAuthorization, membershipId: MembershipId): Promise<void> {
    await this.request(`/v1/projects/memberships/${encodeURIComponent(membershipId)}`, {
      method: 'DELETE', headers: authorization,
    })
  }

  private async json<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
    const response = await this.request(path, init)
    if (response.status === 204) return parse(undefined)
    return parse(await response.json())
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetch(`${this.origin}${path}`, jsonRequest(init))
    if (response.ok) return response
    throw await projectMembershipRequestError(response)
  }
}

function jsonRequest(init: RequestInit): RequestInit {
  const headers = headerRecord(init.headers)
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return { ...init, headers }
}

async function projectMembershipRequestError(response: Response): Promise<ProjectMembershipClientError> {
  const body: unknown = await response.json().catch(() => undefined)
  const code = isErrorBody(body) ? body.error.code : `HTTP_${response.status}`
  const message = isErrorBody(body)
    ? body.error.message
    : `Project Membership request failed with HTTP ${response.status}`
  return new ProjectMembershipClientError(code, response.status, message)
}

function isErrorBody(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = value.error
  return typeof error === 'object' && error !== null
    && 'code' in error && typeof error.code === 'string'
    && 'message' in error && typeof error.message === 'string'
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(record: Record<string, unknown>, key: string, name: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new TypeError(`${name} ${key} must be a string`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function epochMs(record: Record<string, unknown>, key: string, name: string): number {
  const value = record[key]
  if (typeof value !== 'number') throw new TypeError(`${name} ${key} must be epoch milliseconds`)
  return value
}

function parseArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('membership response must be an array')
  return value
}

function parseProjectView(value: unknown): ProjectView {
  const view = record(value, 'project view')
  return {
    id: string(view, 'id', 'project view') as ProjectId,
    name: string(view, 'name', 'project view'),
    boundRemoteUrl: string(view, 'boundRemoteUrl', 'project view'),
    createdAt: epochMs(view, 'createdAt', 'project view'),
  }
}

function parseAuthenticatedProjectView(value: unknown): AuthenticatedProjectView {
  const view = record(value, 'authenticated project view')
  return {
    ...parseProjectView(value),
    receivingAccountId: string(view, 'receivingAccountId', 'authenticated project view') as PlatformAccountId,
  }
}

function parseInvitationView(value: unknown): InvitationView {
  const view = record(value, 'invitation view')
  const settledAt = typeof view.settledAt === 'number' ? view.settledAt : undefined
  return {
    id: string(view, 'id', 'invitation view') as InvitationId,
    projectId: string(view, 'projectId', 'invitation view') as ProjectId,
    inviterAccountId: string(view, 'inviterAccountId', 'invitation view') as PlatformAccountId,
    inviteeAccountId: string(view, 'inviteeAccountId', 'invitation view') as PlatformAccountId,
    state: parseInvitationState(view.state),
    invitedAt: epochMs(view, 'invitedAt', 'invitation view'),
    ...(settledAt === undefined ? {} : { settledAt }),
  }
}

function parseInvitationState(value: unknown): InvitationView['state'] {
  if (value !== 'pending' && value !== 'accepted' && value !== 'declined' && value !== 'retracted') {
    throw new TypeError('invitation view state must be a known lifecycle state')
  }
  return value
}

function parsePendingInvitationView(value: unknown): PendingInvitationView {
  const view = record(value, 'pending invitation view')
  return {
    invitationId: string(view, 'invitationId', 'pending invitation view') as InvitationId,
    receivingAccountId: string(view, 'receivingAccountId', 'pending invitation view') as PlatformAccountId,
    projectId: string(view, 'projectId', 'pending invitation view') as ProjectId,
    projectName: string(view, 'projectName', 'pending invitation view'),
    remoteUrl: string(view, 'remoteUrl', 'pending invitation view'),
    inviterName: string(view, 'inviterName', 'pending invitation view'),
    invitedAt: epochMs(view, 'invitedAt', 'pending invitation view'),
  }
}

function parseIssuedInvitationView(value: unknown): IssuedInvitationView {
  const view = record(value, 'issued invitation view')
  return {
    invitationId: string(view, 'invitationId', 'issued invitation view') as InvitationId,
    inviteeName: string(view, 'inviteeName', 'issued invitation view'),
    invitedAt: epochMs(view, 'invitedAt', 'issued invitation view'),
  }
}

function parseMemberView(value: unknown): MemberView {
  const view = record(value, 'member view')
  const link = view.link === undefined
    ? undefined
    : parseWorkspaceLink(view.link)
  return {
    id: string(view, 'id', 'member view') as MembershipId,
    accountId: string(view, 'accountId', 'member view') as PlatformAccountId,
    role: parseRole(view.role),
    tags: parseArray(view.tags).map((tag) => {
      if (typeof tag !== 'string') throw new TypeError('member view tags must be strings')
      return tag as FunctionTag
    }),
    ...(link === undefined ? {} : { link }),
    joinedAt: epochMs(view, 'joinedAt', 'member view'),
  }
}

function parseJoinedMemberView(value: unknown): MemberView {
  const member = parseMemberView(value)
  if (member.link === undefined) throw new TypeError('accepted member view link must be present')
  return member
}

function parseWorkspaceLink(value: unknown): WorkspaceLink {
  const link = record(value, 'workspace link')
  const normalizedRemoteUrl = optionalString(link, 'normalizedRemoteUrl')
  return {
    workspaceName: string(link, 'workspaceName', 'workspace link'),
    ...(normalizedRemoteUrl === undefined ? {} : { normalizedRemoteUrl }),
  }
}

function parseRole(value: unknown): ProjectRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'member') {
    throw new TypeError('member view role must be owner, admin, or member')
  }
  return value
}

function parseRosterReadView(value: unknown): RosterReadView {
  const view = record(value, 'roster view')
  const members = parseArray(view.members).map(parseRosterMemberView)
  return { project: parseProjectView(view.project), members }
}

function parseRosterMemberView(value: unknown): RosterMemberView {
  const view = record(value, 'roster member view')
  const presence = view.presence
  if (presence !== 'online' && presence !== 'offline') {
    throw new TypeError('roster member presence must be online or offline')
  }
  return {
    ...parseMemberView(view),
    presence,
    displayName: string(view, 'displayName', 'roster member view'),
    avatarRef: string(view, 'avatarRef', 'roster member view'),
  }
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}
