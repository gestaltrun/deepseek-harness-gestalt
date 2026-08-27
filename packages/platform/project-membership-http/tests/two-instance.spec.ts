/**
 * Dual-instance scenario over one durable document: two Platform instances
 * assemble the same storagePath config, each with its own provider, route
 * registry, and presence registry. Instance A commits the project and
 * invitation rows, instance B loads the authoritative document afterwards,
 * completes the acceptance, and answers the same role-gate envelopes; presence
 * stays process-local, so a heartbeat on one instance never reads online
 * through the other (Known Limitations: a shared PresenceStore is deferred).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
const OCTOCAT = 'shared-octocat' as PlatformAccountId
const MONA = 'shared-mona' as PlatformAccountId
const NEON = 'shared-neon' as PlatformAccountId

/** One Account session table shared by both instances: the same platform users. */
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

interface Instance {
  readonly origin: string
  readonly service: FileProjectMembership
}

const openServers: Array<{ close(): Promise<void> }> = []
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()))
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('two Platform instances over one membership document', () => {
  it('hands the authoritative document from instance A to instance B, which accepts and gates identically while presence stays process-local', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-project-membership-two-instance-'))
    roots.push(storagePath)
    const a = await bootInstance(storagePath)

    const created = await post(a.origin, '/v1/projects', {
      name: 'Shared', remoteUrl: 'https://github.com/octocat/Shared.git',
    }, auth('access-octocat'))
    expect(created.status).toBe(201)
    const project = await created.json() as { id: string; boundRemoteUrl: string }
    expect(project.boundRemoteUrl).toBe('https://github.com/octocat/Shared')
    const invited = await post(a.origin, '/v1/projects/invitations', {
      projectId: project.id, inviteeAccountId: MONA,
    }, auth('access-octocat'))
    expect(invited.status).toBe(201)
    const invitation = await invited.json() as { id: string; state: string }
    expect(invitation).toMatchObject({ state: 'pending', inviteeAccountId: MONA })

    // A's own heartbeat registers in A's process, and A's gates are the
    // envelopes instance B must reproduce.
    expect(await statusOf(heartbeat(a.origin, 'access-octocat'))).toBe(204)
    expect(await rosterOf(a.origin, project.id, 'access-octocat')).toEqual({
      project: { id: project.id, name: 'Shared', boundRemoteUrl: 'https://github.com/octocat/Shared' },
      members: [{ accountId: OCTOCAT, role: 'owner', presence: 'online' }],
    })
    expect(await errorOf(fetch(`${a.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ORIGIN, ...auth('access-neon') },
    }))).toEqual([403, 'NOT_A_MEMBER'])

    // Instance B boots after A's writes are durable, so its load reads the
    // same authoritative document; A's heartbeat did not cross over.
    const b = await bootInstance(storagePath)
    const founder = await rosterOf(b.origin, project.id, 'access-octocat')
    expect(founder.project).toMatchObject({ id: project.id, name: 'Shared' })
    expect(founder.members).toEqual([{ accountId: OCTOCAT, role: 'owner', presence: 'offline' }])

    const accepted = await post(b.origin, `/v1/projects/invitations/${invitation.id}/decision`, {
      decision: 'accept-with-link',
      link: { workspaceName: 'mona-local', normalizedRemoteUrl: 'https://github.com/octocat/Shared' },
    }, auth('access-mona'))
    expect(accepted.status).toBe(200)
    const member = await accepted.json() as { id: string; accountId: string; role: string; link: { workspaceName: string } }
    expect(member).toMatchObject({ accountId: MONA, role: 'member', link: { workspaceName: 'mona-local' } })

    // B's gates answer the same envelopes instance A produced, and B's own
    // acceptance immediately gates further invites: Mona now holds membership
    // but not admin, and re-inviting her hits the duplicate gate.
    expect(await errorOf(post(b.origin, '/v1/projects/invitations', {
      projectId: project.id, inviteeAccountId: NEON,
    }, auth('access-mona')))).toEqual([403, 'ROLE_REQUIRED'])
    expect(await errorOf(fetch(`${b.origin}/v1/projects/${project.id}/members`, {
      headers: { origin: ORIGIN, ...auth('access-neon') },
    }))).toEqual([403, 'NOT_A_MEMBER'])
    expect(await errorOf(post(b.origin, '/v1/projects/invitations', {
      projectId: project.id, inviteeAccountId: MONA,
    }, auth('access-octocat')))).toEqual([409, 'DUPLICATE_INVITEE'])

    const joined = await rosterOf(b.origin, project.id, 'access-octocat')
    expect(joined.members.map(({ accountId, role, presence }) => ({ accountId, role, presence }))).toEqual([
      { accountId: OCTOCAT, role: 'owner', presence: 'offline' },
      { accountId: MONA, role: 'member', presence: 'offline' },
    ])

    // B's commit republished the full corpus: A's rows and B's acceptance in
    // one durable document.
    const document = JSON.parse(await readFile(b.service.storageFile, 'utf8')) as {
      projects: Array<{ id: string; boundRemoteUrl: string }>
      memberships: Array<{ accountId: string; role: string }>
      invitations: Array<{ state: string }>
    }
    expect(document.projects.map(({ id, boundRemoteUrl }) => ({ id, boundRemoteUrl }))).toEqual([{
      id: project.id, boundRemoteUrl: 'https://github.com/octocat/Shared',
    }])
    expect(document.memberships.map(row => `${row.accountId}:${row.role}`)).toEqual([
      `${OCTOCAT}:owner`, `${MONA}:member`,
    ])
    expect(document.invitations.map(row => row.state)).toEqual(['accepted'])
  })
})

/**
 * Assemble one Platform instance over the shared storage root: the file-backed
 * provider, the HTTP route registry, and a real TCP listener backed by the
 * instance-local presence registry.
 * @param storagePath - durable storage root shared by both instances.
 * @returns the instance's HTTP origin and its membership provider.
 */
async function bootInstance(storagePath: string): Promise<Instance> {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = {
    platformAccount: accountStub(),
    projectMembership: membership(storagePath),
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
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    service: ctx.projectMembership as FileProjectMembership,
  }
}

function accountStub(): {
  environment: { origin: string }
  current(input: { accessToken: string }): Promise<PlatformAccountView>
  currentInstallation(input: { accessToken: string }): Promise<{
    account: PlatformAccountView
    installation: { id: string; kind: 'desktop'; presentation: { name: string; platform: 'macos' } }
  }>
} {
  const view = (id: PlatformAccountId): PlatformAccountView => ({
    id, githubId: 13994321, githubLogin: 'octocat', avatarUrl: 'https://avatars.example/octocat',
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
        presentation: { name: 'Shared Box', platform: 'macos' as const },
      },
    })),
  }
}

function membership(storagePath: string): FileProjectMembership {
  const context = new Context()
  contexts.push(context)
  return new FileProjectMembership(context, { storagePath, environment: 'development' })
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

async function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  })
}

async function rosterOf(origin: string, projectId: string, accessToken: string): Promise<{
  project: { id: string; name: string; boundRemoteUrl: string }
  members: Array<{ accountId: string; role: string; presence: string }>
}> {
  const roster = await fetch(`${origin}/v1/projects/${projectId}/members`, {
    headers: { origin: ORIGIN, ...auth(accessToken) },
  })
  expect(roster.status).toBe(200)
  const view = await roster.json() as {
    project: { id: string; name: string; boundRemoteUrl: string }
    members: Array<{ accountId: string; role: string; presence: string }>
  }
  return {
    project: (({ id, name, boundRemoteUrl }) => ({ id, name, boundRemoteUrl }))(view.project),
    members: view.members.map(({ accountId, role, presence }) => ({ accountId, role, presence })),
  }
}

async function statusOf(response: Promise<Response> | Response): Promise<number> {
  return (await response).status
}

async function errorOf(response: Promise<Response> | Response): Promise<[number, string]> {
  const answered = await response
  const body = await answered.json() as { error: { code: string } }
  return [answered.status, body.error.code]
}
