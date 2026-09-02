/** Desktop-owned authenticated Project Membership client and hostile IPC parsers. */
import type { SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import {
  ProjectMembershipHttpTransport,
  type FunctionTag,
  type InvitationDecisionInput,
  type InvitationId,
  type MembershipId,
  type ProjectId,
  type ProjectMembershipClient,
  type ProjectRole,
} from '@deepseek-ai/dsh-project-membership-client'
import type { DesktopAccountActions } from './platform-account.ts'

interface DesktopProjectMembershipOptions {
  readonly account: () => DesktopAccountActions
  readonly environment: SelectedPlatformEnvironment
  readonly fetch: typeof globalThis.fetch
  readonly expectedAccountId?: string
  readonly signal?: AbortSignal
}

/**
 * Bind every Platform request to a fresh current-Installation proof retained only in Electron main.
 * @param options - live Account owner, selected Platform environment, and system-network fetch.
 * @returns renderer-safe authenticated operations with no credential parameters.
 */
export function createDesktopProjectMembershipClient(
  options: DesktopProjectMembershipOptions,
): ProjectMembershipClient {
  const transport = new ProjectMembershipHttpTransport({
    origin: options.environment.origin,
    fetch: (input, init) => {
      const signal = requestSignal(init?.signal, options.signal)
      return options.fetch(input, { ...init, ...(signal === undefined ? {} : { signal }) })
    },
  })
  const authorized = async <T>(
    run: (headers: Record<string, string>) => Promise<T>,
  ): Promise<T> => {
    const owner = options.account()
    assertExpectedAccount(owner, options.expectedAccountId)
    const authorization = await owner.authorizeCurrentInstallation()
    assertExpectedAccount(owner, options.expectedAccountId)
    return run({
      Authorization: `Bearer ${authorization.accessToken}`,
      'X-Gestalt-Proof-Jti': authorization.proof.jti,
      'X-Gestalt-Proof-Issued-At': String(authorization.proof.issuedAt),
      'X-Gestalt-Proof-Signature': authorization.proof.signature,
    })
  }
  return {
    createProject: input => authorized(headers => transport.createProject(headers, input)),
    projectByRemote: normalizedRemoteUrl => authorized(headers =>
      transport.projectByRemote(headers, normalizedRemoteUrl)),
    roster: projectId => authorized(headers => transport.roster(headers, projectId)),
    invite: input => authorized(headers => transport.invite(headers, input)),
    decideInvitation: (invitationId, input) => authorized(headers =>
      transport.decideInvitation(headers, invitationId, input)),
    retractInvitation: invitationId => authorized(headers => transport.retractInvitation(headers, invitationId)),
    pendingInvitations: () => authorized(headers => transport.pendingInvitations(headers)),
    issuedInvitations: projectId => authorized(headers => transport.issuedInvitations(headers, projectId)),
    changeRole: (membershipId, role) => authorized(headers =>
      transport.changeRole(headers, membershipId, role)),
    setMemberTags: (membershipId, tags) => authorized(headers =>
      transport.setMemberTags(headers, membershipId, tags)),
    removeMember: membershipId => authorized(headers => transport.removeMember(headers, membershipId)),
  }
}

function assertExpectedAccount(owner: DesktopAccountActions, expectedAccountId: string | undefined): void {
  if (expectedAccountId !== undefined && owner.getSnapshot().account?.id !== expectedAccountId) {
    throw new Error('Desktop Project Membership account changed before authorization completed')
  }
}

function requestSignal(
  first: AbortSignal | null | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (first === null || first === undefined) return second
  if (second === undefined) return first
  return AbortSignal.any([first, second])
}

/** Parse one Cloud Project creation IPC payload. */
export function parseProjectCreation(value: unknown): { name: string; remoteUrl: string } {
  const input = exactRecord(value, ['name', 'remoteUrl'], 'Project creation')
  return {
    name: nonEmptyString(input.name, 'Project name'),
    remoteUrl: nonEmptyString(input.remoteUrl, 'Project remote URL'),
  }
}

/** Parse one Project id IPC payload. */
export function parseProjectId(value: unknown): ProjectId {
  return nonEmptyString(value, 'Project id') as ProjectId
}

/** Parse one normalized Project remote IPC payload. */
export function parseProjectRemote(value: unknown): string {
  return nonEmptyString(value, 'Project remote URL')
}

/** Parse one GitHub-login invitation IPC payload. */
export function parseProjectInvitation(value: unknown): {
  projectId: ProjectId
  githubLogin: string
  grantedRole: ProjectRole
} {
  const input = exactRecord(value, ['projectId', 'githubLogin', 'grantedRole'], 'Project invitation')
  if (input.grantedRole !== 'owner' && input.grantedRole !== 'admin' && input.grantedRole !== 'member') {
    throw new TypeError('Project invitation grantedRole must be owner, admin, or member')
  }
  return {
    projectId: parseProjectId(input.projectId),
    githubLogin: nonEmptyString(input.githubLogin, 'GitHub login'),
    grantedRole: input.grantedRole,
  }
}

/** Parse one invitation decision IPC payload. */
export function parseInvitationDecision(value: unknown): {
  invitationId: InvitationId
  input: InvitationDecisionInput
} {
  const request = exactRecord(value, ['invitationId', 'input'], 'Invitation decision')
  const input = record(request.input, 'Invitation decision input')
  if (input.decision === 'decline') {
    exactKeys(input, ['decision'], 'Invitation decline')
    return { invitationId: parseInvitationId(request.invitationId), input: { decision: 'decline' } }
  }
  if (input.decision !== 'accept-with-link') {
    throw new TypeError('Invitation decision must be decline or accept-with-link')
  }
  exactKeys(input, ['decision', 'link'], 'Invitation acceptance')
  const link = record(input.link, 'Workspace link')
  exactKeys(link, ['workspaceName', 'normalizedRemoteUrl'], 'Workspace link')
  const normalizedRemoteUrl = link.normalizedRemoteUrl === undefined
    ? undefined
    : nonEmptyString(link.normalizedRemoteUrl, 'Workspace remote URL')
  return {
    invitationId: parseInvitationId(request.invitationId),
    input: {
      decision: 'accept-with-link',
      link: {
        workspaceName: nonEmptyString(link.workspaceName, 'Workspace name'),
        ...(normalizedRemoteUrl === undefined ? {} : { normalizedRemoteUrl }),
      },
    },
  }
}

/** Parse one invitation id IPC payload. */
export function parseInvitationId(value: unknown): InvitationId {
  return nonEmptyString(value, 'Invitation id') as InvitationId
}

/** Parse one membership role mutation IPC payload. */
export function parseMembershipRole(value: unknown): { membershipId: MembershipId; role: ProjectRole } {
  const input = exactRecord(value, ['membershipId', 'role'], 'Membership role mutation')
  if (input.role !== 'owner' && input.role !== 'admin' && input.role !== 'member') {
    throw new TypeError('Project role must be owner, admin, or member')
  }
  return { membershipId: parseMembershipId(input.membershipId), role: input.role }
}

/** Parse one membership tag replacement IPC payload. */
export function parseMembershipTags(value: unknown): { membershipId: MembershipId; tags: FunctionTag[] } {
  const input = exactRecord(value, ['membershipId', 'tags'], 'Membership tag mutation')
  if (!Array.isArray(input.tags)) throw new TypeError('Membership tags must be an array')
  return {
    membershipId: parseMembershipId(input.membershipId),
    tags: input.tags.map(tag => nonEmptyString(tag, 'Membership tag') as FunctionTag),
  }
}

/** Parse one membership id IPC payload. */
export function parseMembershipId(value: unknown): MembershipId {
  return nonEmptyString(value, 'Membership id') as MembershipId
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const parsed = record(value, name)
  exactKeys(parsed, keys, name)
  return parsed
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${JSON.stringify(key)}`)
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}
