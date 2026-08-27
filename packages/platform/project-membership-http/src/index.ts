/**
 * HTTP Consumer for Project Membership. It owns the project-registry, roster,
 * invitation, member-administration, and presence-heartbeat routes, while the
 * membership service owns every role gate and roster relation. The acting
 * account is resolved from an existing Account session: bearer access token
 * plus the installation proof headers, verified by `ctx.platformAccount`.
 * Roster reads attach per-member presence aggregated from installation
 * heartbeat registrations and the member's public identity (GitHub login and
 * avatar URL) read in one batch from the Account service.
 * @module @deepseek-ai/dsh-project-membership-http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import {
  AccountError,
  AccountService,
  parseAccountProofJti,
  type AccountProof,
  type AuthenticatedInstallationView,
  type PlatformAccountId,
} from '@deepseek-ai/dsh-platform-account'
import {
  ProjectMembershipError,
  type FunctionTag,
  type InvitationId,
  type MemberView,
  type ProjectMembershipErrorCode,
  type ProjectRole,
  type ProjectView,
  type RosterView,
  type WorkspaceLink,
} from '@deepseek-ai/dsh-project-membership'
import {
  CorsOriginPolicy,
  HttpError,
  readJsonObject,
  writeHttpError,
  writeJson,
  writeRetryAfterError,
} from '@deepseek-ai/dsh-host-webserver'
import { InProcessPresenceStore, PresenceRegistry } from './presence.ts'

const MAX_JSON_BYTES = 64 * 1024

/** Default milliseconds between one installation's presence heartbeats. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000
/** Default milliseconds a heartbeat stays live before its installation counts offline. */
export const PRESENCE_TTL_MS = 90_000

/** HTTP consumer configuration, as resolved by the Config schema's defaults. */
export interface Config {
  /** Exact product origins allowed to call Project Membership routes. */
  origins: string[]
  /** Desktop heartbeat cadence in milliseconds (default: 60000); the presence TTL must outlast it. */
  presenceHeartbeatIntervalMs: number
  /** Heartbeat liveness window in milliseconds (default: 90000); expiry is the only route to offline. */
  presenceTtlMs: number
}

/** Validated HTTP consumer configuration. */
export const Config: z<Config> = z.object({
  origins: z.array(z.string()).min(1).required(),
  presenceHeartbeatIntervalMs: z.natural().min(1).default(PRESENCE_HEARTBEAT_INTERVAL_MS),
  presenceTtlMs: z.natural().min(1).default(PRESENCE_TTL_MS),
})

/** Cordis plugin name. */
export const name = 'project-membership-http'
/** Required Account session verification, membership behavior, and HTTP route registry. */
export const inject = ['platformAccount', 'projectMembership', 'webServer']

/** Register the complete Project Membership HTTP route set. */
export function apply(ctx: Context, config: Config): void {
  const origins = new CorsOriginPolicy(config.origins, 'Project Membership HTTP')
  if (origins.match(ctx.platformAccount.environment.origin) === undefined) {
    throw new TypeError('Project Membership HTTP origins do not include the selected Platform environment')
  }
  if (config.presenceTtlMs <= config.presenceHeartbeatIntervalMs) {
    throw new TypeError('Project Membership HTTP presence TTL must exceed the heartbeat interval')
  }
  const presence = new PresenceRegistry(new InProcessPresenceStore(), config.presenceTtlMs)
  const route = (
    kind: 'exact' | 'prefix',
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): void => {
    ctx.effect(() => ctx.webServer.register({
      kind,
      path,
      handler: async (req, res) => {
        try {
          if (handleCors(req, res, origins)) return
          await handler(req, res)
        } catch (error) {
          answerError(res, error)
        }
      },
    }))
  }

  route('exact', '/v1/projects', async (req, res) => {
    requireMethod(req, 'POST')
    const actor = await requireActor(ctx, req)
    const body = await readJson(req)
    writeJson(res, 201, await ctx.projectMembership.createProject(actor, {
      name: requiredString(body, 'name'),
      remoteUrl: requiredString(body, 'remoteUrl'),
    }))
  })

  route('prefix', '/v1/projects', async (req, res) => {
    const roster = matchPath(requestPath(req), '/v1/projects/:projectId/members')
    if (roster === undefined) throw unknownRoute()
    requireMethod(req, 'GET')
    const actor = await requireActor(ctx, req)
    const view = await ctx.projectMembership.roster(actor, brandedParam<'ProjectId'>(roster, 'projectId'))
    writeJson(res, 200, await decorateRoster(presence, ctx.platformAccount, view))
  })

  route('prefix', '/v1/projects/presence', async (req, res) => {
    if (matchPath(requestPath(req), '/v1/projects/presence/heartbeat') === undefined) throw unknownRoute()
    requireMethod(req, 'POST')
    const authenticated = await requireInstallation(ctx, req)
    if (authenticated.installation.kind !== 'desktop') {
      throw new HttpError(403, 'INSTALLATION_KIND_UNSUPPORTED', 'presence heartbeats are accepted from Desktop installations only')
    }
    await presence.beat(authenticated.account.id, authenticated.installation.id)
    answerNoContent(res)
  })

  route('prefix', '/v1/projects/invitations', async (req, res) => {
    const pathname = requestPath(req)
    if (matchPath(pathname, '/v1/projects/invitations') !== undefined) {
      requireMethod(req, 'POST')
      const actor = await requireActor(ctx, req)
      const body = await readJson(req)
      writeJson(res, 201, await ctx.projectMembership.invite(actor, {
        projectId: requiredBrandedId<'ProjectId'>(body, 'projectId'),
        inviteeAccountId: requiredBrandedId<'PlatformAccountId'>(body, 'inviteeAccountId'),
      }))
      return
    }
    const decision = matchPath(pathname, '/v1/projects/invitations/:invitationId/decision')
    if (decision !== undefined) {
      requireMethod(req, 'POST')
      const actor = await requireActor(ctx, req)
      const body = await readJson(req)
      await decideInvitation(ctx, res, actor, brandedParam<'InvitationId'>(decision, 'invitationId'), body)
      return
    }
    const retraction = matchPath(pathname, '/v1/projects/invitations/:invitationId/retraction')
    if (retraction !== undefined) {
      requireMethod(req, 'POST')
      const actor = await requireActor(ctx, req)
      await readJson(req)
      await ctx.projectMembership.retractInvitation(actor, brandedParam<'InvitationId'>(retraction, 'invitationId'))
      answerNoContent(res)
      return
    }
    throw unknownRoute()
  })

  route('prefix', '/v1/projects/memberships', async (req, res) => {
    const pathname = requestPath(req)
    const role = matchPath(pathname, '/v1/projects/memberships/:membershipId/role')
    if (role !== undefined) {
      requireMethod(req, 'POST')
      const actor = await requireActor(ctx, req)
      const body = await readJson(req)
      await ctx.projectMembership.changeRole(actor, {
        membershipId: brandedParam<'MembershipId'>(role, 'membershipId'),
        role: requiredRole(body.role),
      })
      answerNoContent(res)
      return
    }
    const tags = matchPath(pathname, '/v1/projects/memberships/:membershipId/tags')
    if (tags !== undefined) {
      requireMethod(req, 'POST')
      const actor = await requireActor(ctx, req)
      const body = await readJson(req)
      await ctx.projectMembership.setMemberTags(actor, {
        membershipId: brandedParam<'MembershipId'>(tags, 'membershipId'),
        tags: requiredTags(body.tags),
      })
      answerNoContent(res)
      return
    }
    const removal = matchPath(pathname, '/v1/projects/memberships/:membershipId')
    if (removal !== undefined) {
      requireMethod(req, 'DELETE')
      const actor = await requireActor(ctx, req)
      await ctx.projectMembership.removeMember(actor, brandedParam<'MembershipId'>(removal, 'membershipId'))
      answerNoContent(res)
      return
    }
    throw unknownRoute()
  })
}

/**
 * Resolve the acting account from one Account session presentation.
 * @param ctx - composition context carrying the Account service.
 * @param req - request carrying the bearer token and installation proof headers.
 * @returns the authenticated account id.
 */
async function requireActor(ctx: Context, req: IncomingMessage): Promise<PlatformAccountId> {
  const account = await ctx.platformAccount.current({ accessToken: bearer(req), proof: proofHeaders(req) })
  return account.id
}

/**
 * Resolve the authenticated account and installation from one Account session
 * presentation.
 * @param ctx - composition context carrying the Account service.
 * @param req - request carrying the bearer token and installation proof headers.
 * @returns the authenticated installation with its owning account.
 */
async function requireInstallation(ctx: Context, req: IncomingMessage): Promise<AuthenticatedInstallationView> {
  return ctx.platformAccount.currentInstallation({ accessToken: bearer(req), proof: proofHeaders(req) })
}

/** Presence of one member's installations as of a roster read. */
export type MemberPresence = 'online' | 'offline'

/** One roster member carrying its presence verdict and public display identity. */
export type PresenceMemberView = MemberView & {
  /** Presence verdict of the aggregation plane. */
  readonly presence: MemberPresence
  /** Current public GitHub login; empty when the Account plane does not know the account. */
  readonly displayName: string
  /** Current public avatar URL; empty when the Account plane does not know the account. */
  readonly avatarRef: string
}

/** Roster read response with per-member presence and public identity attached. */
export interface PresenceRosterView {
  /** The queried project. */
  readonly project: ProjectView
  /** Every membership row ordered by join time, each carrying its presence and identity. */
  readonly members: readonly PresenceMemberView[]
}

/**
 * Attach per-member presence and public identity to one roster view.
 * @param presence - registry of live installation heartbeats.
 * @param account - Account service resolving the members' public identities.
 * @param view - roster as the membership service stores it.
 * @returns the roster with each member's presence verdict and identity attached.
 */
async function decorateRoster(
  presence: PresenceRegistry,
  account: AccountService,
  view: RosterView,
): Promise<PresenceRosterView> {
  const accountIds = view.members.map(member => member.accountId)
  const [online, identities] = await Promise.all([
    presence.onlineAccountIds(accountIds),
    account.publicIdentitiesByIds(accountIds),
  ])
  return {
    project: view.project,
    members: view.members.map((member) => {
      const identity = identities.get(member.accountId)
      return {
        ...member,
        presence: online.has(member.accountId) ? 'online' : 'offline',
        displayName: identity?.githubLogin ?? '',
        avatarRef: identity?.avatarUrl ?? '',
      }
    }),
  }
}

/**
 * Apply one body-discriminated invitation decision. `accept-with-link` joins
 * atomically with the mandatory workspace link; `decline` settles the
 * invitation without joining.
 * @param ctx - composition context carrying the membership service.
 * @param res - response receiving the member view or the no-content marker.
 * @param actor - authenticated account the invitation must address.
 * @param invitationId - invitation the decision settles.
 * @param body - decision discriminant plus the link when accepting.
 */
async function decideInvitation(
  ctx: Context,
  res: ServerResponse,
  actor: PlatformAccountId,
  invitationId: InvitationId,
  body: Record<string, unknown>,
): Promise<void> {
  const decision = requiredString(body, 'decision')
  if (decision === 'accept-with-link') {
    requireExactKeys(body, ['decision', 'link'], 'invitation decision')
    const member: MemberView = await ctx.projectMembership.acceptInvitation(actor, {
      invitationId,
      link: requiredLink(body.link),
    })
    writeJson(res, 200, member)
    return
  }
  if (decision === 'decline') {
    requireExactKeys(body, ['decision'], 'invitation decision')
    await ctx.projectMembership.declineInvitation(actor, invitationId)
    answerNoContent(res)
    return
  }
  throw new HttpError(400, 'INVALID_REQUEST', "decision must be 'accept-with-link' or 'decline'")
}

function handleCors(req: IncomingMessage, res: ServerResponse, origins: CorsOriginPolicy): boolean {
  const origin = req.headers.origin
  if (origin !== undefined) {
    const normalized = origins.match(origin)
    if (normalized === undefined) {
      throw new HttpError(403, 'ORIGIN_DENIED', 'Project Membership request origin is not trusted')
    }
    res.setHeader('access-control-allow-origin', normalized)
    res.setHeader('vary', 'Origin')
  }
  if (req.method !== 'OPTIONS') return false
  res.writeHead(204, {
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-gestalt-proof-jti,x-gestalt-proof-issued-at,x-gestalt-proof-signature',
    'access-control-max-age': '600',
  })
  res.end()
  return true
}

const MEMBERSHIP_JSON_BODY = {
  maxBytes: MAX_JSON_BYTES,
  tooLarge: { status: 413, code: 'REQUEST_TOO_LARGE', message: 'Project Membership request exceeds 65536 bytes' },
  invalidJson: { status: 400, code: 'INVALID_JSON', message: 'Project Membership request body is not valid JSON' },
  notObject: { status: 400, code: 'INVALID_JSON', message: 'Project Membership request body must be an object' },
} as const

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return readJsonObject(req, MEMBERSHIP_JSON_BODY)
}

/** HTTP status per stable membership failure code; the envelope code stays the domain code. */
const MEMBERSHIP_ERROR_STATUS: Readonly<Record<ProjectMembershipErrorCode, number>> = {
  DUPLICATE_INVITEE: 409,
  ROLE_REQUIRED: 403,
  NOT_A_MEMBER: 403,
  PROJECT_NOT_FOUND: 404,
  MEMBERSHIP_NOT_FOUND: 404,
  INVITATION_NOT_FOUND: 404,
  INVITATION_NOT_PENDING: 409,
  PROJECT_NAME_TAKEN: 409,
  INVALID_PROJECT_NAME: 400,
  INVALID_REMOTE_URL: 400,
  INVALID_TAGS: 400,
  INVALID_LINK: 400,
  LAST_OWNER: 409,
}

function answerError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    writeHttpError(res, error)
    return
  }
  if (error instanceof ProjectMembershipError) {
    writeRetryAfterError(res, error, MEMBERSHIP_ERROR_STATUS[error.code])
    return
  }
  if (error instanceof AccountError) {
    writeRetryAfterError(
      res,
      error,
      error.code === 'QUOTA' || error.code === 'PLATFORM_CAPACITY'
        ? 429
        : error.code.startsWith('SESSION_') || error.code.startsWith('PROOF_') ? 401 : 400,
    )
    return
  }
  console.error('[project-membership-http] unexpected request failure:', error)
  writeJson(res, 500, { error: { code: 'INTERNAL', message: 'Project Membership request failed' } })
}

/** Match one pathname against a `:param` pattern, capturing decoded segments. */
function matchPath(pathname: string, pattern: string): Record<string, string> | undefined {
  const got = pathname.split('/').filter(segment => segment !== '')
  const want = pattern.split('/').filter(segment => segment !== '')
  if (got.length !== want.length) return undefined
  const params: Record<string, string> = {}
  for (let index = 0; index < want.length; index += 1) {
    const expected = want[index] as string
    const actual = got[index] as string
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeSegment(actual)
      continue
    }
    if (expected !== actual) return undefined
  }
  return params
}

function decodeSegment(segment: string): string {
  // decodeURIComponent throws URIError only on a malformed escape, which is a
  // client request fault answered as INVALID_REQUEST below.
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'path contains an invalid percent escape')
  }
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'https://platform.invalid').pathname
}

/**
 * Bind one required branded path parameter.
 * @param params - captured path parameters.
 * @param key - parameter name in the route pattern.
 * @returns the validated branded identifier.
 */
function brandedParam<B extends string>(params: Record<string, string>, key: string): Branded<B> {
  return requiredParam(params, key) as Branded<B>
}

/**
 * Bind one required branded body identifier.
 * @param record - parsed JSON body.
 * @param key - body field carrying the identifier.
 * @returns the validated branded identifier.
 */
function requiredBrandedId<B extends string>(record: Record<string, unknown>, key: string): Branded<B> {
  return requiredString(record, key) as Branded<B>
}

function requiredParam(params: Record<string, string>, key: string): string {
  const value = params[key]
  if (value === undefined || value === '') throw new HttpError(400, 'INVALID_REQUEST', `${key} path parameter is required`)
  return value
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'INVALID_REQUEST', `${key} must be a non-empty string`)
  return value
}

function requiredRole(value: unknown): ProjectRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'member') {
    throw new HttpError(400, 'INVALID_REQUEST', 'role must be owner, admin, or member')
  }
  return value
}

function requiredTags(value: unknown): FunctionTag[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'INVALID_REQUEST', 'tags must be an array of strings')
  return value.map((tag) => {
    if (typeof tag !== 'string' || tag === '') throw new HttpError(400, 'INVALID_REQUEST', 'every tag must be a non-empty string')
    return tag as FunctionTag
  })
}

function requiredLink(value: unknown): WorkspaceLink {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'link must be an object')
  }
  const record = value as Record<string, unknown>
  const workspaceName = requiredString(record, 'workspaceName')
  const normalizedRemoteUrl = record.normalizedRemoteUrl
  if (normalizedRemoteUrl === undefined) return { workspaceName }
  if (typeof normalizedRemoteUrl !== 'string' || normalizedRemoteUrl === '') {
    throw new HttpError(400, 'INVALID_REQUEST', 'normalizedRemoteUrl must be a non-empty string')
  }
  return { workspaceName, normalizedRemoteUrl }
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  const expected = new Set(keys)
  if (Object.keys(record).length !== expected.size || Object.keys(record).some(key => !expected.has(key))) {
    throw new HttpError(400, 'INVALID_REQUEST', `${name} contains unsupported fields`)
  }
}

function bearer(req: IncomingMessage): string {
  const authorization = req.headers.authorization
  if (authorization === undefined || !authorization.startsWith('Bearer ') || authorization.length === 7) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Bearer Account access token is required')
  }
  return authorization.slice(7)
}

function proofHeaders(req: IncomingMessage): AccountProof {
  const jti = req.headers['x-gestalt-proof-jti']
  const issuedAt = req.headers['x-gestalt-proof-issued-at']
  const signature = req.headers['x-gestalt-proof-signature']
  if (typeof jti !== 'string' || typeof issuedAt !== 'string' || typeof signature !== 'string') {
    throw new HttpError(400, 'INVALID_REQUEST', 'installation proof headers are required')
  }
  if (jti === '') throw new HttpError(400, 'INVALID_REQUEST', 'proof jti header is invalid')
  const parsed = Number(issuedAt)
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, 'INVALID_REQUEST', 'proof issued-at header is invalid')
  return { jti: parseAccountProofJti(jti), issuedAt: parsed, signature }
}

function requireMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Project Membership route requires ${method}`)
}

function unknownRoute(): HttpError {
  return new HttpError(404, 'NOT_FOUND', 'Project Membership route is unknown')
}

function answerNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}
