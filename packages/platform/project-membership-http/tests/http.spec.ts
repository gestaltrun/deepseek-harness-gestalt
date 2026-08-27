/**
 * REAL TCP smoke: route registration through the effect-wrapped registry, one
 * Account-session create→roster path, and stable error envelopes. The host
 * side mounts the real file-backed membership provider over a temporary
 * storage root; only the Account session resolver and route registry are
 * in-memory.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccountError,
  type PlatformAccountId,
  type PlatformAccountView,
  type PublicAccountIdentity,
} from '@deepseek-ai/dsh-platform-account'
import { FileProjectMembership } from '@deepseek-ai/dsh-project-membership-core'
import { apply } from '../src/index.ts'

const ORIGIN = 'https://membership.dev.example.com'
const OCTOCAT = 'smoke-octocat' as PlatformAccountId
const MONA = 'smoke-mona' as PlatformAccountId
const NEON = 'smoke-neon' as PlatformAccountId

const sessions = new Map<string, PlatformAccountId>([
  ['access-octocat', OCTOCAT],
  ['access-octocat-2', OCTOCAT],
  ['access-mona', MONA],
  ['access-neon', NEON],
])

/** Public GitHub login per Account stub id. */
const LOGINS = new Map<PlatformAccountId, string>([
  [OCTOCAT, 'octocat'],
  [MONA, 'mona'],
  [NEON, 'neon'],
])

interface RegisteredRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const openServers: Array<{ close(): Promise<void> }> = []
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()))
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Project Membership HTTP consumer', () => {
  it('registers the presence route beside the exact project route and three prefix route owners, and fails loud on misconfigured origins', () => {
    const routes = bootRoutes()
    expect([...routes.keys()].sort()).toEqual([
      'exact /v1/projects',
      'prefix /v1/projects',
      'prefix /v1/projects/invitations',
      'prefix /v1/projects/memberships',
      'prefix /v1/projects/presence',
    ])
    expect(() => { apply(fakeCtx(), { origins: [] } as never) }).toThrow('origins configuration is required')
    expect(() => { apply(fakeCtx(), { origins: ['https://other.example'] }) })
      .toThrow('do not include the selected Platform environment')
    expect(() => { apply(fakeCtx(), { origins: [ORIGIN], presenceTtlMs: 0 }) })
      .toThrow('presence TTL must be a positive integer')
    expect(() => { apply(fakeCtx(), { origins: [ORIGIN], presenceHeartbeatIntervalMs: 30, presenceTtlMs: 30 }) })
      .toThrow('presence TTL must exceed the heartbeat interval')
  })

  it('creates a project from an Account session and reads its roster back', async () => {
    const server = await start()
    const created = await post(server.origin, '/v1/projects', {
      name: 'Registry',
      remoteUrl: 'https://GitHub.com/octocat/Repo.GIT',
    }, auth('access-octocat'))
    expect(created.status).toBe(201)
    expect(created.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const project = await created.json() as { id: string; name: string; boundRemoteUrl: string }
    expect(project.name).toBe('Registry')
    expect(project.boundRemoteUrl).toBe('https://github.com/octocat/Repo')

    const roster = await fetch(`${server.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ORIGIN, ...auth('access-octocat') },
    })
    expect(roster.status).toBe(200)
    const view = await roster.json() as {
      project: { id: string; name: string }
      members: Array<{ accountId: string; role: string; presence: string; displayName: string; avatarRef: string }>
    }
    expect(view.project).toMatchObject({ id: project.id, name: 'Registry' })
    expect(view.members).toHaveLength(1)
    expect(view.members[0]).toMatchObject({
      accountId: OCTOCAT,
      role: 'owner',
      presence: 'offline',
      displayName: 'octocat',
      avatarRef: 'https://avatars.example/octocat',
    })
  })

  it('reads each member identity in one batch and leaves an unknown account blank without failing', async () => {
    const server = await start({}, { identityBlindSpot: MONA })
    const project = await createProjectWithMember(server.origin)
    const roster = await fetch(`${server.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ORIGIN, ...auth('access-octocat') },
    })
    expect(roster.status).toBe(200)
    const view = await roster.json() as {
      members: Array<{ accountId: string; presence: string; displayName: string; avatarRef: string }>
    }
    expect(view.members.map(({ accountId, presence, displayName, avatarRef }) => (
      { accountId, presence, displayName, avatarRef }
    ))).toEqual([
      { accountId: OCTOCAT, presence: 'offline', displayName: 'octocat', avatarRef: 'https://avatars.example/octocat' },
      { accountId: MONA, presence: 'offline', displayName: '', avatarRef: '' },
    ])
  })

  it('adapts invitations, decisions, role, tags, and removal one-to-one onto the membership service', async () => {
    const server = await start()
    const created = await post(server.origin, '/v1/projects', {
      name: 'Lifecycle', remoteUrl: 'git@github.com:Org/repo.git',
    }, auth('access-octocat'))
    const project = await created.json() as { id: string }

    const invited = await post(server.origin, '/v1/projects/invitations', {
      projectId: project.id, inviteeAccountId: MONA,
    }, auth('access-octocat'))
    expect(invited.status).toBe(201)
    const invitation = await invited.json() as { id: string; state: string; inviteeAccountId: string }
    expect(invitation).toMatchObject({ state: 'pending', inviteeAccountId: MONA })

    const accepted = await post(server.origin, `/v1/projects/invitations/${invitation.id}/decision`, {
      decision: 'accept-with-link', link: { workspaceName: 'local', normalizedRemoteUrl: 'git@github.com:Org/repo.git' },
    }, auth('access-mona'))
    expect(accepted.status).toBe(200)
    const member = await accepted.json() as { id: string; role: string; link: { workspaceName: string } }
    expect(member.role).toBe('member')
    expect(member.link).toMatchObject({ workspaceName: 'local' })

    expect(await statusOf(post(server.origin, `/v1/projects/memberships/${member.id}/role`, { role: 'admin' }, auth('access-octocat')))).toBe(204)
    expect(await statusOf(post(server.origin, `/v1/projects/memberships/${member.id}/tags`, { tags: ['reviewer'] }, auth('access-octocat')))).toBe(204)

    const reinvited = await post(server.origin, '/v1/projects/invitations', {
      projectId: project.id, inviteeAccountId: NEON,
    }, auth('access-octocat'))
    const selfInvitation = await reinvited.json() as { id: string }
    const declined = await post(server.origin, `/v1/projects/invitations/${selfInvitation.id}/decision`, {
      decision: 'decline',
    }, auth('access-neon'))
    expect(declined.status).toBe(204)

    const second = await post(server.origin, '/v1/projects/invitations', {
      projectId: project.id, inviteeAccountId: NEON,
    }, auth('access-octocat'))
    const pending = await second.json() as { id: string }
    const retraction = await post(server.origin, `/v1/projects/invitations/${pending.id}/retraction`, {}, auth('access-octocat'))
    expect(retraction.status).toBe(204)

    const roster = await fetch(`${server.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ORIGIN, ...auth('access-octocat') },
    })
    const view = await roster.json() as { members: Array<{ role: string; tags: string[] }> }
    expect(view.members).toHaveLength(2)
    expect(view.members[1]).toMatchObject({ role: 'admin', tags: ['reviewer'] })

    expect(await statusOf(fetch(`${server.origin}/v1/projects/memberships/${member.id}`, {
      method: 'DELETE', headers: { origin: ORIGIN, ...auth('access-octocat') },
    }))).toBe(204)
    const removed = await fetch(`${server.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ORIGIN, ...auth('access-mona') },
    })
    expect(await errorOf(removed)).toEqual([403, 'NOT_A_MEMBER'])
  })

  it('registers presence heartbeats and attaches per-member presence to roster reads', async () => {
    const server = await start()
    const project = await createProjectWithMember(server.origin)
    const rosterPresence = async (token: string): Promise<Array<{ accountId: string; presence: string }>> => {
      const roster = await fetch(`${server.origin}/v1/projects/${project.id}/members`, {
        headers: { origin: ORIGIN, ...auth(token) },
      })
      expect(roster.status).toBe(200)
      return (await roster.json() as { members: Array<{ accountId: string; presence: string }> })
        .members.map(({ accountId, presence }) => ({ accountId, presence }))
    }

    expect(await rosterPresence('access-octocat')).toEqual([
      { accountId: OCTOCAT, presence: 'offline' },
      { accountId: MONA, presence: 'offline' },
    ])

    expect(await statusOf(heartbeat(server.origin, 'access-octocat'))).toBe(204)
    expect(await rosterPresence('access-mona')).toEqual([
      { accountId: OCTOCAT, presence: 'online' },
      { accountId: MONA, presence: 'offline' },
    ])

    // A second installation of the same account aggregates into one verdict.
    expect(await statusOf(heartbeat(server.origin, 'access-octocat-2'))).toBe(204)
    expect(await rosterPresence('access-octocat')).toEqual([
      { accountId: OCTOCAT, presence: 'online' },
      { accountId: MONA, presence: 'offline' },
    ])

    const wrongMethod = await fetch(`${server.origin}/v1/projects/presence/heartbeat`, {
      method: 'GET', headers: { origin: ORIGIN },
    })
    expect(await errorOf(wrongMethod)).toEqual([405, 'METHOD_NOT_ALLOWED'])
    expect(await errorOf(await heartbeat(server.origin, 'access-revoked'))).toEqual([401, 'SESSION_REVOKED'])
    const unknownSubpath = await fetch(`${server.origin}/v1/projects/presence/other`, {
      method: 'POST', headers: { origin: ORIGIN, ...auth('access-octocat') },
    })
    expect(await errorOf(unknownSubpath)).toEqual([404, 'NOT_FOUND'])
  })

  it('expires presence after the configured TTL', async () => {
    const server = await start({ presenceHeartbeatIntervalMs: 10, presenceTtlMs: 25 })
    const project = await createProjectWithMember(server.origin)
    expect(await statusOf(heartbeat(server.origin, 'access-octocat'))).toBe(204)
    const presenceOf = async (): Promise<string> => {
      const roster = await fetch(`${server.origin}/v1/projects/${project.id}/members`, {
        headers: { origin: ORIGIN, ...auth('access-octocat') },
      })
      return (await roster.json() as { members: Array<{ presence: string }> }).members[0]?.presence ?? 'missing'
    }
    expect(await presenceOf()).toBe('online')
    await new Promise((resolve) => { setTimeout(resolve, 45) })
    expect(await presenceOf()).toBe('offline')
  })

  it('answers Account, membership, and protocol failures with stable envelopes', async () => {
    const server = await start()
    const created = await post(server.origin, '/v1/projects', {
      name: 'Errors', remoteUrl: 'https://github.com/octocat/repo',
    }, auth('access-octocat'))
    const project = await created.json() as { id: string }

    const noBearer = await post(server.origin, '/v1/projects', { name: 'x', remoteUrl: 'https://github.com/o/r' })
    expect(await errorOf(noBearer)).toEqual([401, 'AUTH_REQUIRED'])
    const revoked = await post(server.origin, '/v1/projects', {
      name: 'x', remoteUrl: 'https://github.com/o/r',
    }, auth('access-revoked'))
    expect(await errorOf(revoked)).toEqual([401, 'SESSION_REVOKED'])
    const missingProof = await fetch(`${server.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ORIGIN, authorization: 'Bearer access-octocat' },
    })
    expect(await errorOf(missingProof)).toEqual([400, 'INVALID_REQUEST'])

    const taken = await post(server.origin, '/v1/projects', {
      name: 'Errors', remoteUrl: 'https://github.com/octocat/repo',
    }, auth('access-octocat'))
    expect(await errorOf(taken)).toEqual([409, 'PROJECT_NAME_TAKEN'])
    const invalidRemote = await post(server.origin, '/v1/projects', {
      name: 'Other', remoteUrl: 'not-a-remote',
    }, auth('access-octocat'))
    expect(await errorOf(invalidRemote)).toEqual([400, 'INVALID_REMOTE_URL'])

    const unknownDecision = await post(server.origin, '/v1/projects/invitations/unknown/decision', {
      decision: 'later',
    }, auth('access-octocat'))
    expect(await errorOf(unknownDecision)).toEqual([400, 'INVALID_REQUEST'])
    const extraField = await post(server.origin, '/v1/projects/invitations/unknown/decision', {
      decision: 'decline', extra: true,
    }, auth('access-octocat'))
    expect(await errorOf(extraField)).toEqual([400, 'INVALID_REQUEST'])
    const invalidRole = await post(server.origin, '/v1/projects/memberships/unknown/role', {
      role: 'spectator',
    }, auth('access-octocat'))
    expect(await errorOf(invalidRole)).toEqual([400, 'INVALID_REQUEST'])
    const missingMembership = await post(server.origin, '/v1/projects/memberships/unknown/role', {
      role: 'member',
    }, auth('access-octocat'))
    expect(await errorOf(missingMembership)).toEqual([404, 'MEMBERSHIP_NOT_FOUND'])

    const unknownRoute = await fetch(`${server.origin}/v1/projects/${project.id}/unknown`, {
      headers: { origin: ORIGIN, ...auth('access-octocat') },
    })
    expect(await errorOf(unknownRoute)).toEqual([404, 'NOT_FOUND'])
    const wrongMethod = await fetch(`${server.origin}/v1/projects`, { method: 'GET', headers: { origin: ORIGIN } })
    expect(await errorOf(wrongMethod)).toEqual([405, 'METHOD_NOT_ALLOWED'])
    const invalidJson = await fetch(`${server.origin}/v1/projects`, {
      method: 'POST', body: '{', headers: { 'content-type': 'application/json', origin: ORIGIN },
    })
    expect(await errorOf(invalidJson)).toEqual([400, 'INVALID_JSON'])
    const large = await post(server.origin, '/v1/projects', { value: 'x'.repeat(65_537) }, auth('access-octocat'))
    expect(await errorOf(large)).toEqual([413, 'REQUEST_TOO_LARGE'])
    const escaped = await fetch(`${server.origin}/v1/projects/%zz/members`, {
      headers: { origin: ORIGIN, ...auth('access-octocat') },
    })
    expect(await errorOf(escaped)).toEqual([400, 'INVALID_REQUEST'])
    const notObject = await fetch(`${server.origin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...auth('access-octocat') },
      body: 'null',
    })
    expect(await errorOf(notObject)).toEqual([400, 'INVALID_JSON'])
  })
})

/** Mount the plugin on the effect-wrapped in-memory registry and return its live routes. */
function bootRoutes(
  config: { presenceTtlMs?: number; presenceHeartbeatIntervalMs?: number } = {},
  accountOptions: { identityBlindSpot?: PlatformAccountId } = {},
): Map<string, RegisteredRoute> {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = {
    platformAccount: accountStub(accountOptions),
    projectMembership: membership(),
    webServer: {
      register(route: RegisteredRoute) {
        const key = `${route.kind} ${route.path}`
        if (routes.has(key)) throw new Error(`webserver: duplicate route "${key}"`)
        routes.set(key, route)
        return () => { routes.delete(key) }
      },
    },
    effect(register: () => () => void) { register() },
  } as unknown as Context
  apply(ctx, { origins: [ORIGIN], ...config })
  return routes
}

function fakeCtx(): Context {
  return {
    platformAccount: accountStub(),
    projectMembership: membership(),
    webServer: { register() { return () => {} } },
    effect() {},
  } as unknown as Context
}

function accountStub(options: { identityBlindSpot?: PlatformAccountId } = {}): {
  environment: { origin: string }
  current(input: { accessToken: string }): Promise<PlatformAccountView>
  currentInstallation(input: { accessToken: string }): Promise<{
    account: PlatformAccountView
    installation: { id: string; kind: 'desktop'; presentation: { name: string; platform: 'macos' } }
  }>
  publicIdentitiesByIds(accountIds: readonly PlatformAccountId[]): Promise<ReadonlyMap<PlatformAccountId, PublicAccountIdentity>>
} {
  const login = (id: PlatformAccountId): string => LOGINS.get(id) ?? 'octocat'
  const view = (id: PlatformAccountId): PlatformAccountView => ({
    id, githubId: 13994321, githubLogin: login(id), avatarUrl: `https://avatars.example/${login(id)}`,
  })
  const requireSession = (accessToken: string): PlatformAccountId => {
    const id = sessions.get(accessToken)
    if (id === undefined) throw new AccountError('SESSION_REVOKED', 'access token belongs to another identity namespace')
    return id
  }
  return {
    environment: { origin: ORIGIN },
    current: vi.fn(async (input: { accessToken: string }): Promise<PlatformAccountView> => view(requireSession(input.accessToken))),
    currentInstallation: vi.fn(async (input: { accessToken: string }) => ({
      account: view(requireSession(input.accessToken)),
      installation: {
        id: `installation-${input.accessToken}`,
        kind: 'desktop' as const,
        presentation: { name: 'Smoke Box', platform: 'macos' as const },
      },
    })),
    publicIdentitiesByIds: vi.fn(async (
      accountIds: readonly PlatformAccountId[],
    ): Promise<ReadonlyMap<PlatformAccountId, PublicAccountIdentity>> => {
      const identities = new Map<PlatformAccountId, PublicAccountIdentity>()
      for (const id of accountIds) {
        if (id === options.identityBlindSpot) continue
        identities.set(id, { id, githubLogin: login(id), avatarUrl: `https://avatars.example/${login(id)}` })
      }
      return identities
    }),
  }
}

function membership(): FileProjectMembership {
  const root = join(tmpdir(), `dsh-project-membership-http-${Math.random().toString(36).slice(2)}-`)
  roots.push(root)
  const context = new Context()
  contexts.push(context)
  return new FileProjectMembership(context, { storagePath: root, environment: 'development' })
}

async function start(
  config: { presenceTtlMs?: number; presenceHeartbeatIntervalMs?: number } = {},
  accountOptions: { identityBlindSpot?: PlatformAccountId } = {},
): Promise<{ origin: string }> {
  const routes = bootRoutes(config, accountOptions)
  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = matchRoute(routes, pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP test server did not bind TCP')
  const close = async () => { await new Promise<void>((resolve, reject) => {
    http.close((error) => { if (error === undefined) resolve(); else reject(error) })
  }) }
  openServers.push({ close })
  return { origin: `http://127.0.0.1:${String(address.port)}` }
}

function matchRoute(routes: Map<string, RegisteredRoute>, pathname: string): RegisteredRoute | undefined {
  const exact = routes.get(`exact ${pathname}`)
  if (exact !== undefined) return exact
  let best: RegisteredRoute | undefined
  for (const route of routes.values()) {
    if (route.kind !== 'prefix') continue
    if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
    if (best === undefined || route.path.length > best.path.length) best = route
  }
  return best
}

function auth(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'x-gestalt-proof-jti': `proof-${accessToken}`,
    'x-gestalt-proof-issued-at': '1',
    'x-gestalt-proof-signature': 'signature',
  }
}

/** POST one presence heartbeat as the token's installation. */
function heartbeat(origin: string, accessToken: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/presence/heartbeat`, {
    method: 'POST', headers: { origin: ORIGIN, ...auth(accessToken) },
  })
}

/**
 * Create one project as Octocat and join Mona through an accepted invitation,
 * producing a two-member roster.
 */
async function createProjectWithMember(origin: string): Promise<{ id: string }> {
  const created = await post(origin, '/v1/projects', {
    name: `Presence-${Math.random().toString(36).slice(2)}`, remoteUrl: 'https://github.com/octocat/repo',
  }, auth('access-octocat'))
  const project = await created.json() as { id: string }
  const invited = await post(origin, '/v1/projects/invitations', {
    projectId: project.id, inviteeAccountId: MONA,
  }, auth('access-octocat'))
  const invitation = await invited.json() as { id: string }
  const accepted = await post(origin, `/v1/projects/invitations/${invitation.id}/decision`, {
    decision: 'accept-with-link', link: { workspaceName: 'local' },
  }, auth('access-mona'))
  expect(accepted.status).toBe(200)
  return project
}

async function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  })
}

async function statusOf(response: Promise<Response> | Response): Promise<number> {
  return (await response).status
}

async function errorOf(response: Response): Promise<[number, string]> {
  const body = await response.json() as { error: { code: string } }
  return [response.status, body.error.code]
}
