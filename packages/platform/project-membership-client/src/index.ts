/**
 * Browser client for Project Membership: one transport over the membership
 * HTTP consumer's `/v1/projects` routes (project creation, roster reads,
 * invitation issue/decision/retraction/poll, and member role, tag, and
 * removal). Authorization rides the caller-supplied Account session
 * presentation headers (bearer token plus installation proof); this client
 * never touches the signing key. Error answers keep the domain envelope:
 * non-OK responses reject with the stable code and HTTP status, so a 403
 * role gate surfaces as `ROLE_REQUIRED`/403 rather than a generic failure.
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
  type WorkspaceLink,
} from '@deepseek-ai/dsh-project-membership'

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

/** One invitation decision body: decline, or accept joined atomically with the workspace link. */
export type InvitationDecisionInput =
  | { decision: 'decline' }
  | { decision: 'accept-with-link'; link: WorkspaceLink }

/** Transport operations used by the workspace upgrade and invite surfaces. */
export interface ProjectMembershipTransport {
  createProject(authorization: MembershipAuthorization, input: { name: string; remoteUrl: string }): Promise<ProjectView>
  roster(authorization: MembershipAuthorization, projectId: ProjectId): Promise<RosterReadView>
  invite(
    authorization: MembershipAuthorization,
    input: { projectId: ProjectId; inviteeAccountId: PlatformAccountId },
  ): Promise<InvitationView>
  decideInvitation(
    authorization: MembershipAuthorization,
    invitationId: InvitationId,
    input: InvitationDecisionInput,
  ): Promise<MemberView | undefined>
  retractInvitation(authorization: MembershipAuthorization, invitationId: InvitationId): Promise<void>
  pendingInvitations(authorization: MembershipAuthorization): Promise<readonly InvitationView[]>
  changeRole(authorization: MembershipAuthorization, membershipId: MembershipId, role: ProjectRole): Promise<void>
  setMemberTags(authorization: MembershipAuthorization, membershipId: MembershipId, tags: readonly FunctionTag[]): Promise<void>
  removeMember(authorization: MembershipAuthorization, membershipId: MembershipId): Promise<void>
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

  createProject(authorization: MembershipAuthorization, input: { name: string; remoteUrl: string }): Promise<ProjectView> {
    return this.json('/v1/projects', { method: 'POST', headers: authorization, body: JSON.stringify(input) }, parseProjectView)
  }

  roster(authorization: MembershipAuthorization, projectId: ProjectId): Promise<RosterReadView> {
    return this.json(`/v1/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'GET', headers: authorization,
    }, parseRosterReadView)
  }

  invite(
    authorization: MembershipAuthorization,
    input: { projectId: ProjectId; inviteeAccountId: PlatformAccountId },
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
        return parseMemberView(value)
      },
    )
  }

  async retractInvitation(authorization: MembershipAuthorization, invitationId: InvitationId): Promise<void> {
    await this.request(`/v1/projects/invitations/${encodeURIComponent(invitationId)}/retraction`, {
      method: 'POST', headers: authorization, body: '{}',
    })
  }

  async pendingInvitations(authorization: MembershipAuthorization): Promise<readonly InvitationView[]> {
    const rows = await this.json('/v1/projects/invitations/pending', {
      method: 'GET', headers: authorization,
    }, parseArray)
    return rows.map(parseInvitationView)
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
    const headers = headerRecord(init.headers)
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.fetch(`${this.origin}${path}`, { ...init, headers })
    if (response.ok) return response
    let message = `Project Membership request failed with HTTP ${response.status}`
    let code = `HTTP_${response.status}`
    let body: unknown
    try {
      body = await response.json()
    } catch {
      // A non-JSON proxy failure has no stable membership envelope.
    }
    if (isErrorBody(body)) {
      code = body.error.code
      message = body.error.message
    }
    throw new ProjectMembershipClientError(code, response.status, message)
  }
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

function parseMemberView(value: unknown): MemberView {
  const view = record(value, 'member view')
  const link = view.link === undefined
    ? undefined
    : parseWorkspaceLink(view.link)
  return {
    id: string(view, 'id', 'member view') as MembershipId,
    accountId: string(view, 'accountId', 'member view') as PlatformAccountId,
    role: parseRole(view.role),
    tags: parseArray(view.tags ?? []).map((tag) => {
      if (typeof tag !== 'string') throw new TypeError('member view tags must be strings')
      return tag as FunctionTag
    }),
    ...(link === undefined ? {} : { link }),
    joinedAt: epochMs(view, 'joinedAt', 'member view'),
  }
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
  const members = parseArray(view.members ?? []).map(parseRosterMemberView)
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
    displayName: optionalString(view, 'displayName') ?? '',
    avatarRef: optionalString(view, 'avatarRef') ?? '',
  }
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}
