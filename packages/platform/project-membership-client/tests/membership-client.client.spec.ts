import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvitationView, MemberView, ProjectId, ProjectView } from '@deepseek-ai/dsh-project-membership'
import {
  ProjectMembershipClientError,
  ProjectMembershipHttpTransport,
} from '../src/index.ts'

const ORIGIN = 'https://membership.dev.example.com'
const AUTH = { authorization: 'Bearer token-1' }

/** Fetch stub over JSON answers keyed by `METHOD path`; a thrown matcher records the raw request. */
function wire(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ path: string; method: string; body?: unknown; headers: Record<string, string> }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url)
    const method = init?.method ?? 'GET'
    const path = `${url.pathname}${url.search}`
    const key = `${method} ${path}`
    calls.push({
      path, method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    const answer = responses[key]
    if (answer === undefined) throw new Error(`unexpected request: ${key}`)
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { transport: new ProjectMembershipHttpTransport({ origin: ORIGIN, fetch }), calls }
}

afterEach(() => { vi.restoreAllMocks() })

function project(): ProjectView {
  return { id: 'project-1' as ProjectId, name: 'Assembled', boundRemoteUrl: 'https://github.com/o/r', createdAt: 1 }
}

function invitation(): InvitationView {
  return {
    id: 'invitation-1' as never, projectId: 'project-1' as ProjectId,
    inviterAccountId: 'account-1' as never, inviteeAccountId: 'account-2' as never,
    state: 'pending', grantedRole: 'member', invitedAt: 1,
  }
}

function member(): MemberView {
  return {
    id: 'membership-2' as never, accountId: 'account-2' as never, role: 'member',
    tags: ['triage' as never], link: { workspaceName: 'mona-local' }, joinedAt: 2,
  }
}

describe('ProjectMembershipHttpTransport', () => {
  it('routes the upgrade operations onto the /v1/projects wire contract', async () => {
    const { transport, calls } = wire({
      'POST /v1/projects': { status: 201, body: { ...project(), receivingAccountId: 'account-1' } },
      'GET /v1/projects/by-remote?remoteUrl=https%3A%2F%2Fgithub.com%2Fo%2Fr': {
        status: 200, body: { ...project(), receivingAccountId: 'account-1' },
      },
      'GET /v1/projects/project-1/members': {
        status: 200,
        body: {
          project: project(),
          members: [{ ...member(), presence: 'online', displayName: 'mona', avatarRef: 'https://a/m' }],
        },
      },
      'POST /v1/projects/presence/heartbeat': { status: 204 },
      'POST /v1/projects/presence/close': { status: 204 },
      'POST /v1/projects/invitations': { status: 201, body: invitation() },
      'POST /v1/projects/invitations/invitation-1/decision': { status: 200, body: member() },
      'POST /v1/projects/invitations/invitation-1/retraction': { status: 204 },
      'GET /v1/projects/invitations/pending': {
        status: 200,
        body: [{
          invitationId: 'invitation-1', receivingAccountId: 'account-2',
          projectId: 'project-1', projectName: 'Assembled',
          remoteUrl: 'https://github.com/o/r', inviterName: 'octocat', grantedRole: 'admin', invitedAt: 10,
        }],
      },
      'GET /v1/projects/project-1/invitations': {
        status: 200,
        body: [{ invitationId: 'invitation-1', inviteeName: 'mona', grantedRole: 'member', invitedAt: 10 }],
      },
      'POST /v1/projects/memberships/membership-2/role': { status: 204 },
      'POST /v1/projects/memberships/membership-2/tags': { status: 204 },
      'DELETE /v1/projects/memberships/membership-2': { status: 204 },
    })

    expect(await transport.createProject(AUTH, { name: 'Assembled', remoteUrl: 'https://github.com/o/r' }))
      .toMatchObject({ id: 'project-1', receivingAccountId: 'account-1' })
    expect(await transport.projectByRemote(AUTH, 'https://github.com/o/r'))
      .toMatchObject({ id: 'project-1', receivingAccountId: 'account-1' })
    expect(await transport.roster(AUTH, 'project-1' as ProjectId)).toMatchObject({
      members: [{ presence: 'online', displayName: 'mona', role: 'member' }],
    })
    await transport.heartbeat(AUTH)
    await transport.closePresence(AUTH)
    expect(await transport.invite(AUTH, {
      projectId: 'project-1' as ProjectId, githubLogin: 'mona', grantedRole: 'member',
    }))
      .toMatchObject({ id: 'invitation-1', state: 'pending', grantedRole: 'member' })
    expect(await transport.decideInvitation(AUTH, 'invitation-1' as never, {
      decision: 'accept-with-link', link: { workspaceName: 'mona-local' },
    })).toMatchObject({ id: 'membership-2' })
    await transport.retractInvitation(AUTH, 'invitation-1' as never)
    expect(await transport.pendingInvitations(AUTH)).toMatchObject([{
      invitationId: 'invitation-1', receivingAccountId: 'account-2',
      projectName: 'Assembled', inviterName: 'octocat', grantedRole: 'admin',
    }])
    expect(await transport.issuedInvitations(AUTH, 'project-1' as ProjectId)).toEqual([{
      invitationId: 'invitation-1', inviteeName: 'mona', grantedRole: 'member', invitedAt: 10,
    }])
    await transport.changeRole(AUTH, 'membership-2' as never, 'admin')
    await transport.setMemberTags(AUTH, 'membership-2' as never, ['triage' as never])
    await transport.removeMember(AUTH, 'membership-2' as never)

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/projects',
      'GET /v1/projects/by-remote?remoteUrl=https%3A%2F%2Fgithub.com%2Fo%2Fr',
      'GET /v1/projects/project-1/members',
      'POST /v1/projects/presence/heartbeat',
      'POST /v1/projects/presence/close',
      'POST /v1/projects/invitations',
      'POST /v1/projects/invitations/invitation-1/decision',
      'POST /v1/projects/invitations/invitation-1/retraction',
      'GET /v1/projects/invitations/pending',
      'GET /v1/projects/project-1/invitations',
      'POST /v1/projects/memberships/membership-2/role',
      'POST /v1/projects/memberships/membership-2/tags',
      'DELETE /v1/projects/memberships/membership-2',
    ])
    expect(calls[0]).toMatchObject({ body: { name: 'Assembled', remoteUrl: 'https://github.com/o/r' } })
    expect(calls[5]).toMatchObject({
      body: { projectId: 'project-1', githubLogin: 'mona', grantedRole: 'member' },
    })
    expect(calls[6]).toMatchObject({
      body: { decision: 'accept-with-link', link: { workspaceName: 'mona-local' } },
    })
    expect(calls[10]).toMatchObject({ body: { role: 'admin' } })
    expect(calls[11]).toMatchObject({ body: { tags: ['triage'] } })
    // Every call carries the caller-supplied account session presentation.
    expect(calls.every(call => call.headers.authorization === 'Bearer token-1')).toBe(true)
  })

  it('resolves a decline decision to undefined on the 204 answer', async () => {
    const { transport } = wire({
      'POST /v1/projects/invitations/invitation-1/decision': { status: 204 },
    })
    expect(await transport.decideInvitation(AUTH, 'invitation-1' as never, { decision: 'decline' })).toBeUndefined()
  })

  it('resolves an absent remote membership to undefined', async () => {
    const { transport } = wire({
      'GET /v1/projects/by-remote?remoteUrl=https%3A%2F%2Fgithub.com%2Fo%2Fmissing': { status: 204 },
    })
    await expect(transport.projectByRemote(AUTH, 'https://github.com/o/missing')).resolves.toBeUndefined()
  })

  it('resolves a production unbound remote 404 to undefined', async () => {
    const { transport } = wire({
      'GET /v1/projects/by-remote?remoteUrl=https%3A%2F%2Fgithub.com%2Fo%2Fmissing': { status: 404 },
    })
    await expect(transport.projectByRemote(AUTH, 'https://github.com/o/missing')).resolves.toBeUndefined()
  })

  it('rejects a non-unbound projectByRemote failure', async () => {
    const { transport } = wire({
      'GET /v1/projects/by-remote?remoteUrl=https%3A%2F%2Fgithub.com%2Fo%2Fr': {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'lookup failed' } },
      },
    })
    const failure = await transport.projectByRemote(AUTH, 'https://github.com/o/r').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProjectMembershipClientError)
    expect(failure).toMatchObject({ code: 'INTERNAL', status: 500 })
  })

  it('uses the ambient fetch adapter when none is supplied', async () => {
    const ambient = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const transport = new ProjectMembershipHttpTransport({ origin: ORIGIN })
    await expect(transport.projectByRemote(AUTH, 'https://github.com/o/missing')).resolves.toBeUndefined()
    expect(ambient).toHaveBeenCalledOnce()
  })

  it('keeps the 403 role-gate envelope: stable code plus HTTP status', async () => {
    const { transport } = wire({
      'POST /v1/projects': {
        status: 403,
        body: { error: { code: 'ROLE_REQUIRED', message: 'only owners and admins create projects' } },
      },
    })
    const failure = await transport.createProject(AUTH, { name: 'X', remoteUrl: 'https://github.com/o/r' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProjectMembershipClientError)
    expect(failure).toMatchObject({ code: 'ROLE_REQUIRED', status: 403 })
  })

  it('reports a non-JSON failure as an HTTP_<status> envelope code', async () => {
    const fetch = vi.fn(async (): Promise<Response> => new Response('bad gateway', { status: 502 }))
    const transport = new ProjectMembershipHttpTransport({ origin: ORIGIN, fetch })
    const failure = await transport.pendingInvitations(AUTH).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'HTTP_502', status: 502 })
  })

  it('rejects malformed success payloads instead of leaking them to the UI', async () => {
    const { transport } = wire({
      'POST /v1/projects': { status: 201, body: { id: 'project-1' } },
      'GET /v1/projects/project-1/members': { status: 200, body: { project: project(), members: [{ role: 'spectator' }] } },
      'GET /v1/projects/invitations/pending': { status: 200, body: { not: 'an array' } },
    })
    await expect(transport.createProject(AUTH, { name: 'X', remoteUrl: 'https://github.com/o/r' })).rejects.toThrow(TypeError)
    await expect(transport.roster(AUTH, 'project-1' as ProjectId)).rejects.toThrow('presence')
    await expect(transport.pendingInvitations(AUTH)).rejects.toThrow('array')
  })

  it('projects optional response fields and lifecycle states without inventing values', async () => {
    for (const state of ['accepted', 'declined', 'retracted'] as const) {
      const { transport } = wire({
        'POST /v1/projects/invitations': {
          status: 201,
          body: { ...invitation(), state, settledAt: 11 },
        },
      })
      await expect(transport.invite(AUTH, {
        projectId: 'project-1' as ProjectId, githubLogin: 'mona', grantedRole: 'member',
      })).resolves.toMatchObject({ state, settledAt: 11 })
    }

    const emptyRoster = wire({
      'GET /v1/projects/project-1/members': { status: 200, body: { project: project(), members: [] } },
    }).transport
    await expect(emptyRoster.roster(AUTH, 'project-1' as ProjectId)).resolves.toMatchObject({ members: [] })

    const linkedRoster = wire({
      'GET /v1/projects/project-1/members': {
        status: 200,
        body: {
          project: project(),
          members: [{
            id: 'membership-2', accountId: 'account-2', role: 'admin', joinedAt: 2,
            tags: [],
            link: { workspaceName: 'local', normalizedRemoteUrl: 'https://github.com/o/r' },
            presence: 'offline', displayName: '', avatarRef: '',
          }],
        },
      },
    }).transport
    await expect(linkedRoster.roster(AUTH, 'project-1' as ProjectId)).resolves.toMatchObject({
      members: [{
        tags: [], displayName: '', avatarRef: '',
        link: { workspaceName: 'local', normalizedRemoteUrl: 'https://github.com/o/r' },
      }],
    })
  })

  it('rejects each malformed success-payload boundary', async () => {
    for (const body of [null, []]) {
      const { transport } = wire({ 'POST /v1/projects': { status: 201, body } })
      await expect(transport.createProject(AUTH, {
        name: 'X', remoteUrl: 'https://github.com/o/r',
      })).rejects.toThrow('must be an object')
    }

    const badCreatedAt = wire({
      'POST /v1/projects': {
        status: 201,
        body: { ...project(), createdAt: 'now', receivingAccountId: 'account-1' },
      },
    }).transport
    await expect(badCreatedAt.createProject(AUTH, {
      name: 'X', remoteUrl: 'https://github.com/o/r',
    })).rejects.toThrow('createdAt must be epoch milliseconds')

    const badState = wire({
      'POST /v1/projects/invitations': { status: 201, body: { ...invitation(), state: 'expired' } },
    }).transport
    await expect(badState.invite(AUTH, {
      projectId: 'project-1' as ProjectId, githubLogin: 'mona', grantedRole: 'member',
    })).rejects.toThrow('known lifecycle state')

    const badGrantedRole = wire({
      'POST /v1/projects/invitations': { status: 201, body: { ...invitation(), grantedRole: 'owner' } },
    }).transport
    await expect(badGrantedRole.invite(AUTH, {
      projectId: 'project-1' as ProjectId, githubLogin: 'mona', grantedRole: 'member',
    })).rejects.toThrow('invitation grantedRole must be admin or member')

    const badTags = wire({
      'POST /v1/projects/invitations/invitation-1/decision': {
        status: 200,
        body: { ...member(), tags: [42] },
      },
    }).transport
    await expect(badTags.decideInvitation(AUTH, 'invitation-1' as never, {
      decision: 'accept-with-link', link: { workspaceName: 'local' },
    })).rejects.toThrow('tags must be strings')

    const badRole = wire({
      'GET /v1/projects/project-1/members': {
        status: 200,
        body: {
          project: project(),
          members: [{ ...member(), presence: 'online', role: 'spectator' }],
        },
      },
    }).transport
    await expect(badRole.roster(AUTH, 'project-1' as ProjectId)).rejects.toThrow('role must be owner, admin, or member')

    const missingCases: Array<[string, unknown, RegExp]> = [
      ['POST /v1/projects/invitations/invitation-1/decision', {
        id: 'membership-2', accountId: 'account-2', role: 'member', tags: [], joinedAt: 2,
      }, /link must be present/],
      ['POST /v1/projects/invitations/invitation-1/decision', {
        id: 'membership-2', accountId: 'account-2', role: 'member',
        link: { workspaceName: 'local' }, joinedAt: 2,
      }, /response must be an array/],
      ['GET /v1/projects/project-1/members', { project: project() }, /response must be an array/],
      ['GET /v1/projects/project-1/members', {
        project: project(),
        members: [{ ...member(), presence: 'online', avatarRef: '' }],
      }, /displayName must be a string/],
      ['GET /v1/projects/project-1/members', {
        project: project(),
        members: [{ ...member(), presence: 'online', displayName: '' }],
      }, /avatarRef must be a string/],
    ]
    for (const [key, body, message] of missingCases) {
      const transport = wire({ [key]: { status: 200, body } }).transport
      const run = key.startsWith('POST')
        ? transport.decideInvitation(AUTH, 'invitation-1' as never, {
          decision: 'accept-with-link', link: { workspaceName: 'local' },
        })
        : transport.roster(AUTH, 'project-1' as ProjectId)
      await expect(run).rejects.toThrow(message)
    }
  })
})
