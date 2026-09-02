/**
 * TCP-level Project Membership HTTP consumer suite: `apply` registers against a
 * stub webServer registry with the same exact-then-longest-prefix dispatch as
 * the real WebServer, and stub Account and membership services let every route
 * answer, error envelope, and validation branch be driven deterministically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AccountError,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountService,
  type PlatformAccountId,
} from '@deepseek-ai/dsh-platform-account'
import {
  ProjectMembershipError,
  ProjectMembershipService,
  type InvitationId,
  type InvitationView,
  type MemberView,
  type ProjectId,
  type ProjectView,
  type RosterView,
} from '@deepseek-ai/dsh-project-membership'
import { apply, PRESENCE_HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS } from '../src/index.ts'

const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://membership.dev.example.com',
    callbackUrl: 'https://membership.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'http-development', credentialReference: 'credentials://http-development',
    databaseIdentity: 'http-database-development', identityNamespace: 'http-development',
  },
  production: {
    environment: 'production', origin: 'https://membership.example.com',
    callbackUrl: 'https://membership.example.com/v1/account/oauth/github/callback',
    githubClientId: 'http-production', credentialReference: 'credentials://http-production',
    databaseIdentity: 'http-database-production', identityNamespace: 'http-production',
  },
}), 'development')

interface RegisteredRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const openServers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()))
})

describe('Project Membership HTTP consumer', () => {
  it('serves the full member lifecycle over exact and prefix routes', async () => {
    const membership = membershipService()
    const account = accountService()
    const server = await start(membership, account)
    const session = authHeaders()

    const created = await post(server.origin, '/v1/projects', {
      name: 'Assembled', remoteUrl: 'https://GitHub.com/octocat/Repo.GIT',
    }, session)
    expect(created.status).toBe(201)
    const createdBody: unknown = await created.json()
    expect(createdBody).toMatchObject({ id: 'project-1', receivingAccountId: 'account-1' })
    expect(membership.createProject).toHaveBeenCalledWith('account-1', {
      name: 'Assembled', remoteUrl: 'https://GitHub.com/octocat/Repo.GIT',
    })
    membership.projectByRemote.mockResolvedValueOnce(project())
    const restored = await fetch(`${server.origin}/v1/projects/by-remote?remoteUrl=${encodeURIComponent('https://GitHub.com/octocat/Repo.GIT')}`, {
      headers: { origin: ENVIRONMENT.origin, ...session },
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ id: 'project-1', receivingAccountId: 'account-1' })
    expect(membership.projectByRemote).toHaveBeenCalledWith('account-1', 'https://github.com/octocat/Repo')

    membership.pendingInvitationsIssuedBy.mockResolvedValueOnce([invitation()])
    const issued = await fetch(`${server.origin}/v1/projects/project-1/invitations`, {
      headers: { origin: ENVIRONMENT.origin, ...session },
    })
    expect(issued.status).toBe(200)
    expect(await issued.json()).toEqual([{
      invitationId: 'invitation-1', inviteeName: 'mona', grantedRole: 'member', invitedAt: 1,
    }])
    expect(membership.pendingInvitationsIssuedBy).toHaveBeenCalledWith('account-1', 'project-1')

    const invited = await post(server.origin, '/v1/projects/invitations', {
      projectId: 'project-1', githubLogin: 'mona', grantedRole: 'admin',
    }, session)
    expect(invited.status).toBe(201)
    expect(await invited.json()).toMatchObject({ id: 'invitation-1', state: 'pending', grantedRole: 'member' })
    expect(membership.invite).toHaveBeenCalledWith('account-1', {
      projectId: 'project-1', inviteeAccountId: 'account-2', grantedRole: 'admin',
    })

    const accepted = await post(server.origin, '/v1/projects/invitations/invitation-1/decision', {
      decision: 'accept-with-link', link: { workspaceName: 'mona-local' },
    }, session)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ id: 'membership-2' })
    expect(membership.acceptInvitation).toHaveBeenCalledWith('account-1', {
      invitationId: 'invitation-1', link: { workspaceName: 'mona-local' },
    })

    const declined = await post(server.origin, '/v1/projects/invitations/invitation-1/decision', {
      decision: 'decline',
    }, session)
    expect(declined.status).toBe(204)
    expect(membership.declineInvitation).toHaveBeenCalledWith('account-1', 'invitation-1')

    const retracted = await post(server.origin, '/v1/projects/invitations/invitation-1/retraction', {}, session)
    expect(retracted.status).toBe(204)
    expect(membership.retractInvitation).toHaveBeenCalledWith('account-1', 'invitation-1')

    // A Desktop heartbeat marks the beating account online on the next roster read.
    expect((await heartbeat(server.origin, session)).status).toBe(204)
    const roster = await fetch(`${server.origin}/v1/projects/project-1/members`, {
      headers: { origin: ENVIRONMENT.origin, ...session },
    })
    expect(roster.status).toBe(200)
    expect(await roster.json()).toEqual({
      project: { id: 'project-1', name: 'Assembled', boundRemoteUrl: 'https://github.com/octocat/Repo', createdAt: 1 },
      members: [
        { ...member('membership-1', 'account-1'), role: 'owner', presence: 'online', displayName: 'octocat', avatarRef: 'https://avatars.example/octocat' },
        {
          ...member('membership-2', 'account-2'), presence: 'offline',
          displayName: 'mona', avatarRef: 'https://avatars.example/mona',
        },
      ],
    })

    expect((await post(server.origin, '/v1/projects/memberships/membership-2/role', {
      role: 'admin',
    }, session)).status).toBe(204)
    expect((await post(server.origin, '/v1/projects/memberships/membership-2/tags', {
      tags: ['triage'],
    }, session)).status).toBe(204)
    expect(membership.setMemberTags).toHaveBeenCalledWith('account-1', {
      membershipId: 'membership-2', tags: ['triage'],
    })
    expect((await fetch(`${server.origin}/v1/projects/memberships/membership-2`, {
      method: 'DELETE', headers: { origin: ENVIRONMENT.origin, ...session },
    })).status).toBe(204)
    expect(membership.removeMember).toHaveBeenCalledWith('account-1', 'membership-2')
  })

  it('answers preflight, admits originless requests, and reports unknown subroutes', async () => {
    const server = await start(membershipService(), accountService())

    const preflight = await fetch(`${server.origin}/v1/projects`, {
      method: 'OPTIONS', headers: { origin: ENVIRONMENT.origin },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE')
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ENVIRONMENT.origin)

    // No Origin header: no CORS response headers, and the route still answers.
    const originless = await fetch(`${server.origin}/v1/projects`, { method: 'POST' })
    expect(await error(originless)).toEqual([401, 'AUTH_REQUIRED'])

    expect(await error(post(server.origin, '/v1/projects/presence/other', {}, authHeaders()))).toEqual([404, 'NOT_FOUND'])
    expect(await error(post(server.origin, '/v1/projects/invitations/invitation-1/unknown', {}, authHeaders()))).toEqual([404, 'NOT_FOUND'])
    expect(await error(post(server.origin, '/v1/projects/memberships/membership-1/unknown', {}, authHeaders()))).toEqual([404, 'NOT_FOUND'])
  })

  it('serves the invitee pending-invitation poll for the acting account', async () => {
    const membership = membershipService()
    membership.pendingInvitationContextsFor.mockResolvedValue([{
      invitation: invitation(), project: project(),
    }])
    const server = await start(membership, accountService())
    const pending = await fetch(`${server.origin}/v1/projects/invitations/pending`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders() },
    })
    expect(pending.status).toBe(200)
    expect(await pending.json()).toMatchObject([{
      invitationId: 'invitation-1', receivingAccountId: 'account-1', projectName: 'Assembled',
      remoteUrl: 'https://github.com/octocat/Repo', inviterName: 'octocat', grantedRole: 'member',
    }])
    expect(membership.pendingInvitationContextsFor).toHaveBeenCalledWith('account-1')
    expect(await error(post(server.origin, '/v1/projects/invitations/pending', {}, authHeaders())))
      .toEqual([405, 'METHOD_NOT_ALLOWED'])
  })

  it('validates by-remote queries and answers an absent Project with no content', async () => {
    const membership = membershipService()
    const missingUrl = await start(membership, accountService(), (req, path) => {
      if (path === '/v1/projects/by-remote') req.url = undefined
    })
    expect(await error(fetch(`${missingUrl.origin}/v1/projects/by-remote?remoteUrl=x`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders() },
    }))).toEqual([400, 'INVALID_REQUEST'])

    const server = await start(membership, accountService())
    expect(await error(fetch(`${server.origin}/v1/projects/by-remote?remoteUrl=%20`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders() },
    }))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(fetch(`${server.origin}/v1/projects/by-remote?remoteUrl=${encodeURIComponent('ssh://host/repo')}`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders() },
    }))).toEqual([400, 'INVALID_REQUEST'])
    const absent = await fetch(`${server.origin}/v1/projects/by-remote?remoteUrl=${encodeURIComponent('https://github.com/o/missing')}`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders() },
    })
    expect(absent.status).toBe(204)
  })

  it('rejects an invitation for an unresolved GitHub login', async () => {
    const account = accountService()
    account.publicIdentityByGithubLogin.mockResolvedValueOnce(undefined)
    const server = await start(membershipService(), account)
    expect(await error(post(server.origin, '/v1/projects/invitations', {
      projectId: 'project-1', githubLogin: 'missing', grantedRole: 'member',
    }, authHeaders()))).toEqual([404, 'ACCOUNT_NOT_FOUND'])
  })

  it('uses empty public names when invitation identities are unavailable', async () => {
    const membership = membershipService()
    membership.pendingInvitationsIssuedBy.mockResolvedValueOnce([invitation()])
    membership.pendingInvitationContextsFor.mockResolvedValueOnce([{
      invitation: invitation(), project: project(),
    }])
    const account = accountService()
    account.publicIdentitiesByIds.mockResolvedValue(new Map())
    const server = await start(membership, account)
    const headers = { origin: ENVIRONMENT.origin, ...authHeaders() }
    const issued = await fetch(`${server.origin}/v1/projects/project-1/invitations`, { headers })
    expect(await issued.json()).toMatchObject([{ inviteeName: '', grantedRole: 'member' }])
    const pending = await fetch(`${server.origin}/v1/projects/invitations/pending`, { headers })
    expect(await pending.json()).toMatchObject([{ inviterName: '', grantedRole: 'member' }])
  })

  it('rejects the wrong method and a heartbeat path that no subroute owns', async () => {
    const server = await start(membershipService(), accountService())
    expect(await error(fetch(`${server.origin}/v1/projects`, { headers: { origin: ENVIRONMENT.origin } }))).toEqual([405, 'METHOD_NOT_ALLOWED'])
    expect(await error(fetch(`${server.origin}/v1/projects/presence/heartbeat`, { headers: { origin: ENVIRONMENT.origin } }))).toEqual([405, 'METHOD_NOT_ALLOWED'])
  })

  it('accepts presence heartbeats from Desktop installations only', async () => {
    const membership = membershipService()
    const account = accountService()
    account.currentInstallation.mockResolvedValueOnce(installation('mobile'))
    const server = await start(membership, account)
    expect(await error(heartbeat(server.origin, authHeaders()))).toEqual([403, 'INSTALLATION_KIND_UNSUPPORTED'])
    account.currentInstallation.mockResolvedValueOnce(installation('desktop'))
    expect((await heartbeat(server.origin, authHeaders())).status).toBe(204)
  })

  it('returns stable account, membership, and internal error envelopes', async () => {
    const membership = membershipService()
    const account = accountService()
    account.current.mockRejectedValueOnce(new AccountError('QUOTA', 'over quota', 30))
      .mockRejectedValueOnce(new AccountError('LOGIN_ATTEMPT_EXPIRED', 'expired'))
      .mockRejectedValueOnce(new AccountError('SESSION_REVOKED', 'revoked'))
      .mockRejectedValueOnce(new AccountError('PROOF_REPLAYED', 'replayed'))
      .mockRejectedValueOnce(new Error('database unavailable'))
    membership.createProject.mockRejectedValueOnce(new ProjectMembershipError('PROJECT_NAME_TAKEN', 'taken'))
    const server = await start(membership, account)
    const session = authHeaders()

    const quota = await post(server.origin, '/v1/projects', { name: 'A', remoteUrl: 'https://github.com/o/r' }, session)
    expect(quota.status).toBe(429)
    expect(quota.headers.get('retry-after')).toBe('30')
    expect(await quota.json()).toMatchObject({ error: { code: 'QUOTA', retryAfter: 30 } })
    expect(await error(post(server.origin, '/v1/projects', { name: 'A', remoteUrl: 'https://github.com/o/r' }, session)))
      .toEqual([400, 'LOGIN_ATTEMPT_EXPIRED'])
    expect(await error(post(server.origin, '/v1/projects', { name: 'A', remoteUrl: 'https://github.com/o/r' }, session)))
      .toEqual([401, 'SESSION_REVOKED'])
    expect(await error(post(server.origin, '/v1/projects', { name: 'A', remoteUrl: 'https://github.com/o/r' }, session)))
      .toEqual([401, 'PROOF_REPLAYED'])
    expect(await error(post(server.origin, '/v1/projects', { name: 'A', remoteUrl: 'https://github.com/o/r' }, session)))
      .toEqual([500, 'INTERNAL'])
    expect(await error(post(server.origin, '/v1/projects', { name: 'A', remoteUrl: 'https://github.com/o/r' }, session)))
      .toEqual([409, 'PROJECT_NAME_TAKEN'])
  })

  it('rejects malformed bodies and fields before they reach the membership service', async () => {
    const membership = membershipService()
    const server = await start(membership, accountService())
    const session = authHeaders()

    const emptyName = await post(server.origin, '/v1/projects', { name: '', remoteUrl: 'https://github.com/o/r' }, session)
    expect(await error(emptyName)).toEqual([400, 'INVALID_REQUEST'])
    const nonStringRemote = await post(server.origin, '/v1/projects', { name: 'Ok', remoteUrl: 5 }, session)
    expect(await error(nonStringRemote)).toEqual([400, 'INVALID_REQUEST'])

    expect(await error(post(server.origin, '/v1/projects/invitations', {}, session))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(post(server.origin, '/v1/projects/invitations', {
      projectId: 'project-1', githubLogin: 'mona', grantedRole: 'spectator',
    }, session))).toEqual([400, 'INVALID_REQUEST'])

    expect(await error(post(server.origin, '/v1/projects/invitations/invitation-1/decision', {
      decision: 'later',
    }, session))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(post(server.origin, '/v1/projects/invitations/invitation-1/decision', {
      decision: 'decline', extra: true,
    }, session))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(post(server.origin, '/v1/projects/invitations/invitation-1/decision', {
      decision: 'accept-with-link', link: 'mona-local',
    }, session))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(post(server.origin, '/v1/projects/invitations/invitation-1/decision', {
      decision: 'accept-with-link', link: { workspaceName: 'mona-local', normalizedRemoteUrl: 42 },
    }, session))).toEqual([400, 'INVALID_REQUEST'])

    expect(await error(post(server.origin, '/v1/projects/memberships/membership-1/role', {
      role: 'spectator',
    }, session))).toEqual([400, 'INVALID_REQUEST'])

    expect(await error(post(server.origin, '/v1/projects/memberships/membership-1/tags', {
      tags: 'triage',
    }, session))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(post(server.origin, '/v1/projects/memberships/membership-1/tags', {
      tags: [42],
    }, session))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(post(server.origin, '/v1/projects/memberships/membership-1/tags', {
      tags: [''],
    }, session))).toEqual([400, 'INVALID_REQUEST'])

    expect(await error(heartbeat(server.origin, { ...session, 'x-gestalt-proof-jti': '' }))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(heartbeat(server.origin, { ...session, 'x-gestalt-proof-issued-at': 'nan' }))).toEqual([400, 'INVALID_REQUEST'])
    expect(await error(heartbeat(server.origin, { ...session, authorization: 'Bearer ' }))).toEqual([401, 'AUTH_REQUIRED'])
  })

  it('answers a request whose URL the carrier dropped as unknown', async () => {
    const server = await start(membershipService(), accountService(), (req) => { req.url = undefined })
    expect(await error(fetch(`${server.origin}/v1/projects/project-1/members`, {
      headers: { origin: ENVIRONMENT.origin, ...authHeaders() },
    }))).toEqual([404, 'NOT_FOUND'])
  })
})

interface MockAccountService {
  environment: AccountService['environment']
  current: Mock<AccountService['current']>
  currentInstallation: Mock<AccountService['currentInstallation']>
  publicIdentitiesByIds: Mock<AccountService['publicIdentitiesByIds']>
  publicIdentityByGithubLogin: Mock<AccountService['publicIdentityByGithubLogin']>
}

interface MockMembershipService {
  createProject: Mock<ProjectMembershipService['createProject']>
  invite: Mock<ProjectMembershipService['invite']>
  retractInvitation: Mock<ProjectMembershipService['retractInvitation']>
  acceptInvitation: Mock<ProjectMembershipService['acceptInvitation']>
  declineInvitation: Mock<ProjectMembershipService['declineInvitation']>
  changeRole: Mock<ProjectMembershipService['changeRole']>
  setMemberTags: Mock<ProjectMembershipService['setMemberTags']>
  removeMember: Mock<ProjectMembershipService['removeMember']>
  roster: Mock<ProjectMembershipService['roster']>
  pendingInvitationsFor: Mock<ProjectMembershipService['pendingInvitationsFor']>
  pendingInvitationsIssuedBy: Mock<ProjectMembershipService['pendingInvitationsIssuedBy']>
  pendingInvitationContextsFor: Mock<ProjectMembershipService['pendingInvitationContextsFor']>
  projectByRemote: Mock<ProjectMembershipService['projectByRemote']>
}

function accountService(): MockAccountService {
  return {
    environment: ENVIRONMENT,
    current: vi.fn<AccountService['current']>().mockResolvedValue({
      id: 'account-1' as PlatformAccountId, githubId: 13994321, githubLogin: 'octocat',
      avatarUrl: 'https://avatars.example/octocat',
    }),
    currentInstallation: vi.fn<AccountService['currentInstallation']>().mockResolvedValue(installation('desktop')),
    publicIdentitiesByIds: vi.fn<AccountService['publicIdentitiesByIds']>().mockResolvedValue(new Map([
      ['account-1' as PlatformAccountId, { id: 'account-1' as PlatformAccountId, githubLogin: 'octocat', avatarUrl: 'https://avatars.example/octocat' }],
      ['account-2' as PlatformAccountId, { id: 'account-2' as PlatformAccountId, githubLogin: 'mona', avatarUrl: 'https://avatars.example/mona' }],
    ])),
    publicIdentityByGithubLogin: vi.fn<AccountService['publicIdentityByGithubLogin']>().mockResolvedValue({
      id: 'account-2' as PlatformAccountId, githubLogin: 'mona', avatarUrl: 'https://avatars.example/mona',
    }),
  }
}

function installation(kind: 'desktop' | 'mobile'): Awaited<ReturnType<AccountService['currentInstallation']>> {
  const account = {
    id: 'account-1' as PlatformAccountId, githubId: 13994321, githubLogin: 'octocat',
    avatarUrl: 'https://avatars.example/octocat',
  }
  return kind === 'desktop'
    ? {
      account,
      installation: {
        id: 'installation-1' as never, kind,
        presentation: { name: 'Test Desktop', platform: 'linux' as const },
      },
    }
    : {
      account,
      installation: {
        id: 'installation-1' as never, kind,
        presentation: { name: 'Test Mobile', platform: 'ios' as const },
      },
    }
}

function membershipService(): MockMembershipService {
  return {
    createProject: vi.fn<ProjectMembershipService['createProject']>().mockResolvedValue(project()),
    invite: vi.fn<ProjectMembershipService['invite']>().mockResolvedValue(invitation()),
    retractInvitation: vi.fn<ProjectMembershipService['retractInvitation']>().mockResolvedValue(undefined),
    acceptInvitation: vi.fn<ProjectMembershipService['acceptInvitation']>().mockResolvedValue(member('membership-2', 'account-2')),
    declineInvitation: vi.fn<ProjectMembershipService['declineInvitation']>().mockResolvedValue(undefined),
    changeRole: vi.fn<ProjectMembershipService['changeRole']>().mockResolvedValue(undefined),
    setMemberTags: vi.fn<ProjectMembershipService['setMemberTags']>().mockResolvedValue(undefined),
    removeMember: vi.fn<ProjectMembershipService['removeMember']>().mockResolvedValue(undefined),
    roster: vi.fn<ProjectMembershipService['roster']>().mockResolvedValue(roster()),
    pendingInvitationsFor: vi.fn<ProjectMembershipService['pendingInvitationsFor']>().mockResolvedValue([]),
    pendingInvitationsIssuedBy: vi.fn<ProjectMembershipService['pendingInvitationsIssuedBy']>().mockResolvedValue([]),
    pendingInvitationContextsFor: vi.fn<ProjectMembershipService['pendingInvitationContextsFor']>()
      .mockResolvedValue([]),
    projectByRemote: vi.fn<ProjectMembershipService['projectByRemote']>().mockResolvedValue(undefined),
  }
}

function project(): ProjectView {
  return { id: 'project-1' as ProjectId, name: 'Assembled', boundRemoteUrl: 'https://github.com/octocat/Repo', createdAt: 1 }
}

function invitation(): InvitationView {
  return {
    id: 'invitation-1' as InvitationId, projectId: 'project-1' as ProjectId,
    inviterAccountId: 'account-1' as PlatformAccountId, inviteeAccountId: 'account-2' as PlatformAccountId,
    state: 'pending', grantedRole: 'member', invitedAt: 1,
  }
}

function member(id: string, accountId: string, role: 'owner' | 'member' = 'member'): MemberView {
  return {
    id: id as never, accountId: accountId as PlatformAccountId, role, tags: [],
    link: { workspaceName: 'mona-local' }, joinedAt: 1,
  }
}

function roster(): RosterView {
  return {
    project: project(),
    members: [member('membership-1', 'account-1', 'owner'), member('membership-2', 'account-2')],
  }
}

/** One fresh Account session presentation; the stub verifier accepts every value. */
function authHeaders(): Record<string, string> {
  return {
    authorization: 'Bearer access',
    'x-gestalt-proof-jti': 'proof-1',
    'x-gestalt-proof-issued-at': String(Date.now()),
    'x-gestalt-proof-signature': 'signature',
  }
}

function heartbeat(origin: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/v1/projects/presence/heartbeat`, {
    method: 'POST', headers: { origin: ENVIRONMENT.origin, ...headers },
  })
}

async function start(
  membership: MockMembershipService,
  account: MockAccountService,
  mutateRequest?: (request: IncomingMessage, path: string) => void,
): Promise<{ origin: string }> {
  const exact = new Map<string, RegisteredRoute>()
  const prefixes = new Map<string, RegisteredRoute>()
  const ctx = {
    platformAccount: account,
    projectMembership: membership,
    webServer: {
      register(route: RegisteredRoute) {
        (route.kind === 'exact' ? exact : prefixes).set(route.path, route)
        return () => { (route.kind === 'exact' ? exact : prefixes).delete(route.path) }
      },
    },
    effect(register: () => () => void) { register() },
  } as unknown as Context
  apply(ctx, {
    origins: [ENVIRONMENT.origin],
    presenceHeartbeatIntervalMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
    presenceTtlMs: PRESENCE_TTL_MS,
  })
  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    let route = exact.get(pathname)
    if (route === undefined) {
      for (const [prefix, candidate] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (route === undefined || prefix.length > route.path.length) route = candidate
      }
    }
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    mutateRequest?.(req, pathname)
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

async function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ENVIRONMENT.origin, ...headers },
    body: JSON.stringify(body),
  })
}

async function error(response: Promise<Response> | Response): Promise<[number, string]> {
  const answered = await response
  const body = await answered.json() as { error: { code: string } }
  return [answered.status, body.error.code]
}
