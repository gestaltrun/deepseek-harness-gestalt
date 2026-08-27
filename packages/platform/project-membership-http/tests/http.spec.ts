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
} from '@deepseek-ai/dsh-platform-account'
import { FileProjectMembership } from '@deepseek-ai/dsh-project-membership-core'
import { apply } from '../src/index.ts'

const ORIGIN = 'https://membership.dev.example.com'
const OCTOCAT = 'smoke-octocat' as PlatformAccountId
const MONA = 'smoke-mona' as PlatformAccountId
const NEON = 'smoke-neon' as PlatformAccountId

const sessions = new Map<string, PlatformAccountId>([
  ['access-octocat', OCTOCAT],
  ['access-mona', MONA],
  ['access-neon', NEON],
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
  it('registers the exact project route and three prefix route owners, and fails loud on misconfigured origins', () => {
    const routes = bootRoutes()
    expect([...routes.keys()].sort()).toEqual([
      'exact /v1/projects',
      'prefix /v1/projects',
      'prefix /v1/projects/invitations',
      'prefix /v1/projects/memberships',
    ])
    expect(() => { apply(fakeCtx(), { origins: [] } as never) }).toThrow('origins configuration is required')
    expect(() => { apply(fakeCtx(), { origins: ['https://other.example'] }) })
      .toThrow('do not include the selected Platform environment')
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
      members: Array<{ accountId: string; role: string }>
    }
    expect(view.project).toMatchObject({ id: project.id, name: 'Registry' })
    expect(view.members).toHaveLength(1)
    expect(view.members[0]).toMatchObject({ accountId: OCTOCAT, role: 'owner' })
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
function bootRoutes(): Map<string, RegisteredRoute> {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = {
    platformAccount: accountStub(),
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
  apply(ctx, { origins: [ORIGIN] })
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

function accountStub(): {
  environment: { origin: string }
  current(input: { accessToken: string }): Promise<PlatformAccountView>
} {
  return {
    environment: { origin: ORIGIN },
    current: vi.fn(async (input: { accessToken: string }): Promise<PlatformAccountView> => {
      const id = sessions.get(input.accessToken)
      if (id === undefined) throw new AccountError('SESSION_REVOKED', 'access token belongs to another identity namespace')
      return { id, githubId: 13994321, githubLogin: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
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

async function start(): Promise<{ origin: string }> {
  const routes = bootRoutes()
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
