/** Web Host provider for Desktop-owned authenticated Project Membership reads. */
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parsePlatformAccountId, type PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  type FunctionTag,
  type MembershipId,
  type ProjectId,
  type RosterView,
} from '@deepseek-ai/dsh-project-membership'
import z from '@deepseek-ai/schemastery'

/** Same function-tag ceilings as the membership store. */
const FUNCTION_TAG_LIMITS = { count: 8, length: 32 } as const

/** Public identity and presence decorations accompanying one bridged roster member. */
export interface DesktopMemberPresentation {
  /** Aggregated live-Installation verdict. */
  readonly presence: 'online' | 'offline'
  /** Public GitHub login used for model-visible lookup. */
  readonly displayName: string
  /** Public avatar URL or provider-owned reference. */
  readonly avatarRef: string
}

/** Current Desktop Account and optional Cloud Project bound to one session Workspace. */
export interface DesktopProjectMembershipContext {
  readonly account: {
    readonly id: PlatformAccountId
    readonly githubLogin: string
    readonly avatarUrl: string
  }
  readonly project?: RosterView['project']
}

/** Origin facts assembled from the current account, project, and roster. */
export interface DesktopMemberQuestionOrigin {
  readonly projectName: string
  readonly originSessionTitle: string
  readonly askerAccountId: string
  readonly askerRole: 'owner' | 'admin' | 'member'
  readonly askerDisplayName: string
  readonly askerAvatarUrl: string
}

/** Authenticated member-question route derived from one bound-Project roster read. */
export interface DesktopMemberQuestionRoute {
  /** Bound Cloud Project containing both actor and addressee. */
  readonly projectId: ProjectId
  /** Durable Account id matched from the live roster, never the model-supplied login. */
  readonly toProjectMember: string
  /** Public Decision Brief origin for the asking Account. */
  readonly origin: DesktopMemberQuestionOrigin
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopProjectMembership: DesktopProjectMembershipService
  }
}

/** Desktop bridge location injected by the Desktop-only Web Host patch. */
export interface Config {
  /** Absolute loopback HTTP origin published by Desktop Host. */
  readonly baseUrl: string
  /** Owner-only bearer-token file read immediately before each request. */
  readonly tokenFile: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  tokenFile: z.string().required(),
})

/** Client-side Service Provider over the Desktop Host's token-protected loopback projection. */
export class DesktopProjectMembershipService extends Service {
  static Config = Config
  private readonly baseUrl: string
  private readonly presentations = new Map<string, readonly DesktopMemberPresentation[]>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'desktopProjectMembership')
    this.baseUrl = parseLoopbackOrigin(config.baseUrl)
    if (config.tokenFile.length === 0) throw new TypeError('project-membership-desktop: tokenFile must be non-empty')
  }

  /**
   * Resolve the signed-in Account and the current session Workspace's optional Cloud Project.
   * @param agent - live Agent whose immutable session cwd selects the Workspace.
   * @param signal - optional cancellation for the loopback read.
   * @returns current Desktop context, or no value for diagnostics without a cwd.
   */
  async context(agent?: Agent, signal?: AbortSignal): Promise<DesktopProjectMembershipContext | undefined> {
    const cwd = agent?.session.header.cwd
    if (cwd === undefined) return undefined
    return parseContext(await this.request('/v1/context', { cwd }, signal))
  }

  /**
   * Read the current signed-in Desktop Account independently of any Workspace.
   * @param signal - optional cancellation for the loopback read.
   * @returns current public Account identity.
   * @throws when Desktop has no signed-in Account or the bridge response is invalid.
   */
  async currentAccount(signal?: AbortSignal): Promise<DesktopProjectMembershipContext['account']> {
    return parseContext(await this.request('/v1/account', {}, signal)).account
  }

  /**
   * Read one complete authoritative roster and retain its identity/presence decorations for the presenter.
   * @param actor - current Desktop Account id.
   * @param projectId - Cloud Project to read.
   * @param signal - optional cancellation for the loopback read.
   * @returns canonical stored roster fields.
   * @throws when the actor differs from Desktop Account or the roster response is invalid.
   */
  async roster(actor: PlatformAccountId, projectId: ProjectId, signal?: AbortSignal): Promise<RosterView> {
    const parsed = parseRoster(
      await this.request('/v1/roster', { actorAccountId: actor, projectId }, signal),
      projectId,
    )
    this.presentations.set(rosterIdentity(parsed.view), parsed.presentations)
    return parsed.view
  }

  /**
   * Project the decorations retained by the exact roster read.
   * @param view - roster returned by {@link roster}.
   * @returns one presentation per member in stored order.
   * @throws when `view` was not returned by this service instance.
   */
  present(view: RosterView): Promise<readonly DesktopMemberPresentation[]> {
    const presentations = this.presentations.get(rosterIdentity(view))
    if (presentations === undefined) {
      throw new Error('project-membership-desktop: roster presentation requires the exact bridged roster read')
    }
    if (presentations.length !== view.members.length) {
      throw new Error('project-membership-desktop: roster presentation count must match the retained roster')
    }
    return Promise.resolve(presentations)
  }

  /**
   * Resolve one member-question route from the current bound-Project roster.
   * @param agent - live asking Agent.
   * @param addresseeLogin - public GitHub login from `to_project_member`.
   * @param originSessionTitle - latest public Session title, or the product fallback.
   * @param signal - optional cancellation for both route-authority reads.
   * @returns authenticated Project, matched Account, and origin, or no value when the login is not a current member.
   * @throws when the Workspace is unbound or the current Account is absent from the roster.
   */
  async questionRoute(
    agent: Agent | undefined,
    addresseeLogin: string,
    originSessionTitle: string,
    signal?: AbortSignal,
  ): Promise<DesktopMemberQuestionRoute | undefined> {
    const context = await this.context(agent, signal)
    if (context?.project === undefined) throw new Error('project-membership-desktop: current Workspace is not bound')
    const roster = await this.roster(context.account.id, context.project.id, signal)
    const presentations = this.presentations.get(rosterIdentity(roster))
    if (presentations === undefined) {
      throw new Error('project-membership-desktop: roster presentation requires the exact bridged roster read')
    }
    const actor = roster.members.find(member => member.accountId === context.account.id)
    if (actor === undefined) throw new Error('project-membership-desktop: current Account is absent from its bound Project roster')
    const matched = matchPublicLogin(roster, presentations, addresseeLogin)
    if (matched === undefined) return undefined
    return {
      projectId: context.project.id,
      toProjectMember: matched,
      origin: {
        projectName: context.project.name,
        originSessionTitle,
        askerAccountId: context.account.id,
        askerRole: actor.role,
        askerDisplayName: context.account.githubLogin,
        askerAvatarUrl: context.account.avatarUrl,
      },
    }
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const token = (await readFile(this.config.tokenFile, 'utf8')).trim()
    if (token.length === 0) throw new Error('project-membership-desktop: token file is empty')
    const response = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
    const value: unknown = await response.json()
    if (!response.ok) throw new Error(`project-membership-desktop: Desktop bridge failed with HTTP ${String(response.status)}`)
    return value
  }
}

export default DesktopProjectMembershipService

function rosterIdentity(view: RosterView): string {
  return `${view.project.id}\0${view.members.map(member => member.accountId).join('\0')}`
}

function matchPublicLogin(
  roster: RosterView,
  presentations: readonly DesktopMemberPresentation[],
  addresseeLogin: string,
): string | undefined {
  const normalized = addresseeLogin.trim().toLowerCase()
  if (normalized.length === 0) return undefined
  for (const [index, member] of roster.members.entries()) {
    const login = presentations[index]?.displayName
    if (login !== undefined && login.toLowerCase() === normalized) return member.accountId
  }
  return undefined
}

function parseLoopbackOrigin(value: string): string {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError('project-membership-desktop: baseUrl must be an absolute loopback HTTP origin')
  }
  return url.origin
}

function parseContext(value: unknown): DesktopProjectMembershipContext {
  const row = record(value, 'context')
  const account = record(row.account, 'context account')
  return {
    account: {
      id: parsePlatformAccountId(nonEmptyText(account.id, 'context account id')),
      githubLogin: nonEmptyText(account.githubLogin, 'context account githubLogin'),
      avatarUrl: httpsUrl(account.avatarUrl, 'context account avatarUrl'),
    },
    ...(row.project === undefined ? {} : { project: project(row.project) }),
  }
}

function parseRoster(
  value: unknown,
  requestedProjectId: ProjectId,
): { view: RosterView; presentations: readonly DesktopMemberPresentation[] } {
  const row = record(value, 'roster')
  if (!Array.isArray(row.members)) throw new TypeError('roster members must be an array')
  const members = row.members.map((entry) => {
    const member = record(entry, 'roster member')
    const role = member.role
    const presence = member.presence
    if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new TypeError('roster member role is invalid')
    if (presence !== 'online' && presence !== 'offline') throw new TypeError('roster member presence is invalid')
    if (!Array.isArray(member.tags)) throw new TypeError('roster member tags must be an array')
    if (member.tags.length > FUNCTION_TAG_LIMITS.count) {
      throw new TypeError(`roster member tags must contain at most ${String(FUNCTION_TAG_LIMITS.count)} values`)
    }
    const tags = member.tags.map((tag) => {
      const value = nonEmptyText(tag, 'roster member tag')
      if (value.length > FUNCTION_TAG_LIMITS.length) {
        throw new TypeError(`roster member tag must contain at most ${String(FUNCTION_TAG_LIMITS.length)} characters`)
      }
      return value as FunctionTag
    })
    if (new Set(tags).size !== tags.length) {
      throw new TypeError('roster member tags must be distinct')
    }
    const stored: RosterView['members'][number] = {
      id: nonEmptyText(member.id, 'roster member id') as MembershipId,
      accountId: parsePlatformAccountId(nonEmptyText(member.accountId, 'roster member accountId')),
      role,
      tags,
      joinedAt: epoch(member.joinedAt, 'roster member joinedAt'),
      ...(member.link === undefined ? {} : { link: parseLink(member.link) }),
    }
    const presentation: DesktopMemberPresentation = {
      presence,
      displayName: nonEmptyText(member.displayName, 'roster member displayName'),
      avatarRef: httpsUrl(member.avatarRef, 'roster member avatarRef'),
    }
    return { stored, presentation }
  })
  const parsedProject = project(row.project)
  if (parsedProject.id !== requestedProjectId) throw new TypeError('roster project id must match the requested project')
  const accountIds = members.map(member => member.stored.accountId)
  if (new Set(accountIds).size !== accountIds.length) throw new TypeError('roster account ids must be distinct')
  const view: RosterView = { project: parsedProject, members: members.map(member => member.stored) }
  return { view, presentations: members.map(member => member.presentation) }
}

function project(value: unknown): RosterView['project'] {
  const row = record(value, 'project')
  return {
    id: nonEmptyText(row.id, 'project id') as ProjectId,
    name: nonEmptyText(row.name, 'project name'),
    boundRemoteUrl: nonEmptyText(row.boundRemoteUrl, 'project boundRemoteUrl'),
    createdAt: epoch(row.createdAt, 'project createdAt'),
  }
}

function parseLink(value: unknown): NonNullable<RosterView['members'][number]['link']> {
  const row = record(value, 'workspace link')
  return {
    workspaceName: nonEmptyText(row.workspaceName, 'workspace link name'),
    ...(row.normalizedRemoteUrl === undefined ? {} : {
      normalizedRemoteUrl: nonEmptyText(row.normalizedRemoteUrl, 'workspace link remote'),
    }),
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}

function nonEmptyText(value: unknown, name: string): string {
  const parsed = text(value, name)
  if (parsed.length === 0 || parsed.trim() !== parsed) throw new TypeError(`${name} must be a non-empty trimmed string`)
  return parsed
}

function httpsUrl(value: unknown, name: string): string {
  const parsed = new URL(nonEmptyText(value, name))
  if (parsed.protocol !== 'https:') throw new TypeError(`${name} must be an HTTPS URL`)
  return parsed.href
}

function epoch(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be positive epoch milliseconds`)
  }
  return value
}
