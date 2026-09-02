import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DesktopProjectMembership from '../src/index.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Desktop Project Membership Web Host provider', () => {
  it('resolves one agent context and matches a public GitHub login on the live roster', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-desktop-'))
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'secret\n')
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' })
      const href = input instanceof Request ? input.url : String(input)
      if (href.endsWith('/v1/context') || href.endsWith('/v1/account')) {
        return Response.json({
          account: { id: 'account-a', githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
          project: { id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/atlas', createdAt: 1 },
        })
      }
      return Response.json({
        project: { id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/atlas', createdAt: 1 },
        members: [{
          id: 'membership-b', accountId: 'account-b', role: 'member', tags: ['release'], joinedAt: 1,
          presence: 'online', displayName: 'Grace', avatarRef: 'https://avatars.example/grace.png',
        }, {
          id: 'membership-a', accountId: 'account-a', role: 'owner', tags: [], joinedAt: 1,
          presence: 'online', displayName: 'Ada', avatarRef: 'https://avatars.example/ada.png',
        }],
      })
    })
    vi.stubGlobal('fetch', fetch)
    ctx = new Context()
    await ctx.plugin(DesktopProjectMembership, { baseUrl: 'http://127.0.0.1:4321', tokenFile })
    const agent = { id: 'session-a', session: { header: { cwd: '/workspace/atlas' } } } as never

    await expect(ctx.desktopProjectMembership.context(agent)).resolves.toMatchObject({
      account: { id: 'account-a' }, project: { id: 'project-atlas' },
    })
    await expect(ctx.desktopProjectMembership.currentAccount()).resolves.toMatchObject({ id: 'account-a' })
    const roster = await ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never)
    expect(roster.members.map(member => member.accountId)).toEqual(['account-b', 'account-a'])
    await expect(ctx.desktopProjectMembership.present(roster)).resolves.toEqual([
      { presence: 'online', displayName: 'Grace', avatarRef: 'https://avatars.example/grace.png' },
      { presence: 'online', displayName: 'Ada', avatarRef: 'https://avatars.example/ada.png' },
    ])
    await expect(ctx.desktopProjectMembership.questionRoute(agent, 'GRACE', 'Acceptance session')).resolves.toMatchObject({
      projectId: 'project-atlas',
      toProjectMember: 'account-b',
      origin: {
        projectName: 'Atlas', originSessionTitle: 'Acceptance session',
        askerAccountId: 'account-a', askerRole: 'owner', askerDisplayName: 'ada',
      },
    })
    await expect(ctx.desktopProjectMembership.questionRoute(agent, 'account-b', 'Acceptance session'))
      .resolves.toBeUndefined()
    await expect(ctx.desktopProjectMembership.questionRoute(agent, 'missing', 'Acceptance session'))
      .resolves.toBeUndefined()
  })

  it('aborts a pending loopback roster read through the supplied signal', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-desktop-'))
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'secret\n')
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const rejectAbort = (): void => { reject(new Error(String(signal?.reason ?? 'aborted'))) }
      signal?.addEventListener('abort', rejectAbort, { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    ctx = new Context()
    await ctx.plugin(DesktopProjectMembership, { baseUrl: 'http://127.0.0.1:4321', tokenFile })
    const controller = new AbortController()
    const pending = ctx.desktopProjectMembership.currentAccount(controller.signal)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    controller.abort(new Error('web host cancelled'))
    await expect(pending).rejects.toThrow('web host cancelled')
  })

  it('fails closed on hostile loopback origins, unbound context, and invalid roster rows', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-desktop-hostile-'))
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'secret\n')
    const validAccount = {
      id: 'account-a', githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png',
    }
    const validProject = {
      id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/atlas', createdAt: 1,
    }
    const member = (overrides: Record<string, unknown> = {}) => ({
      id: 'membership-a',
      accountId: 'account-a',
      role: 'owner',
      tags: [],
      joinedAt: 1,
      presence: 'online',
      displayName: 'Ada',
      avatarRef: 'https://avatars.example/ada.png',
      ...overrides,
    })
    let payload: unknown = { members: 'not-an-array', project: validProject }
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const href = input instanceof Request ? input.url : String(input)
      if (href.endsWith('/v1/context') || href.endsWith('/v1/account')) {
        return Response.json(payload)
      }
      return Response.json(payload)
    })
    vi.stubGlobal('fetch', fetch)
    ctx = new Context()
    await expect(ctx.plugin(DesktopProjectMembership, {
      baseUrl: 'https://example.test/', tokenFile,
    })).rejects.toThrow('baseUrl must be an absolute loopback HTTP origin')
    await ctx.plugin(DesktopProjectMembership, { baseUrl: 'http://[::1]:4321', tokenFile })
    const agent = { id: 'session-a', session: { header: { cwd: '/workspace/atlas' } } } as never

    payload = { account: validAccount }
    await expect(ctx.desktopProjectMembership.context(agent)).resolves.toMatchObject({
      account: { id: 'account-a' },
    })
    await expect(ctx.desktopProjectMembership.context()).resolves.toBeUndefined()
    payload = { account: { id: 'account-a', githubLogin: 'ada', avatarUrl: 'http://avatars.example/ada.png' } }
    await expect(ctx.desktopProjectMembership.currentAccount()).rejects.toThrow('must be an HTTPS URL')
    payload = { account: { id: 'account-a', githubLogin: ' ada', avatarUrl: 'https://avatars.example/ada.png' } }
    await expect(ctx.desktopProjectMembership.currentAccount()).rejects.toThrow('must be a non-empty trimmed string')
    payload = { account: { id: 'account-a', githubLogin: 1, avatarUrl: 'https://avatars.example/ada.png' } }
    await expect(ctx.desktopProjectMembership.currentAccount()).rejects.toThrow('must be a string')
    payload = { account: { id: 'account-a', githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' }, project: [] }
    await expect(ctx.desktopProjectMembership.currentAccount()).rejects.toThrow('must be an object')
    payload = { account: { id: 'account-a', githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' }, project: { ...validProject, createdAt: 0 } }
    await expect(ctx.desktopProjectMembership.context(agent)).rejects.toThrow('must be positive epoch milliseconds')

    payload = { members: 'not-an-array', project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('roster members must be an array')
    payload = { members: [member({ role: 'superadmin' })], project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('roster member role is invalid')
    payload = { members: [member({ presence: 'away' })], project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('roster member presence is invalid')
    payload = { members: [member({ tags: 'release' })], project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('roster member tags must be an array')
    payload = { members: [member({ tags: Array.from({ length: 9 }, (_, index) => `tag${String(index)}`) })], project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('at most 8 values')
    payload = { members: [member({ tags: ['abcdefghijklmnopqrstuvwxyz0123456'] })], project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('at most 32 characters')
    payload = { members: [member({ tags: ['review', 'review'] })], project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('roster member tags must be distinct')
    payload = { members: [member({ link: { workspaceName: 'local' } })], project: validProject }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .resolves.toMatchObject({ members: [{ link: { workspaceName: 'local' } }] })
    payload = {
      members: [member({ link: { workspaceName: 'local', normalizedRemoteUrl: 'https://github.com/o/atlas' } })],
      project: validProject,
    }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .resolves.toMatchObject({
        members: [{ link: { workspaceName: 'local', normalizedRemoteUrl: 'https://github.com/o/atlas' } }],
      })
    payload = { members: [member()], project: { ...validProject, id: 'project-other' } }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('roster project id must match the requested project')
    payload = {
      members: [member(), member({ id: 'membership-dup', accountId: 'account-a', displayName: 'Ada2' })],
      project: validProject,
    }
    await expect(ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never))
      .rejects.toThrow('roster account ids must be distinct')
  })

  it('fails closed when the token file, HTTP status, Workspace, or actor cannot authorize a route', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-desktop-auth-'))
    const emptyToken = join(root, 'empty-token')
    await writeFile(emptyToken, '\n')
    await expect(new Context().plugin(DesktopProjectMembership, {
      baseUrl: 'http://127.0.0.1:4321', tokenFile: '',
    })).rejects.toThrow('tokenFile must be non-empty')
    const emptyCtx = new Context()
    await emptyCtx.plugin(DesktopProjectMembership, { baseUrl: 'http://127.0.0.1:4321', tokenFile: emptyToken })
    await expect(emptyCtx.desktopProjectMembership.currentAccount()).rejects.toThrow('token file is empty')
    await emptyCtx.fiber.dispose()

    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'secret\n')
    const validAccount = {
      id: 'account-a', githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png',
    }
    const validProject = {
      id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/atlas', createdAt: 1,
    }
    let payload: unknown = { error: 'denied' }
    let status = 403
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const href = input instanceof Request ? input.url : String(input)
      if (href.endsWith('/v1/context') || href.endsWith('/v1/account')) {
        return Response.json(payload, { status })
      }
      return Response.json(payload, { status })
    })
    vi.stubGlobal('fetch', fetch)
    ctx = new Context()
    await ctx.plugin(DesktopProjectMembership, { baseUrl: 'http://127.0.0.1:4321', tokenFile })
    await expect(ctx.desktopProjectMembership.currentAccount())
      .rejects.toThrow('Desktop bridge failed with HTTP 403')

    status = 200
    payload = { account: validAccount, project: validProject }
    const unbound = { id: 'session-unbound', session: { header: {} } } as never
    await expect(ctx.desktopProjectMembership.questionRoute(unbound, 'grace', 'Acceptance session'))
      .rejects.toThrow('current Workspace is not bound')
    payload = {
      account: validAccount,
      project: validProject,
      members: [{
        id: 'membership-b', accountId: 'account-b', role: 'member', tags: [], joinedAt: 1,
        presence: 'online', displayName: 'Grace', avatarRef: 'https://avatars.example/grace.png',
      }],
    }
    const agent = { id: 'session-a', session: { header: { cwd: '/workspace/atlas' } } } as never
    await expect(ctx.desktopProjectMembership.questionRoute(agent, 'grace', 'Acceptance session'))
      .rejects.toThrow('current Account is absent from its bound Project roster')
    payload = {
      account: validAccount,
      project: validProject,
      members: [{
        id: 'membership-a', accountId: 'account-a', role: 'owner', tags: [], joinedAt: 1,
        presence: 'online', displayName: 'Ada', avatarRef: 'https://avatars.example/ada.png',
      }],
    }
    const roster = await ctx.desktopProjectMembership.roster('account-a' as never, 'project-atlas' as never)
    expect(() => ctx.desktopProjectMembership.present({
      project: roster.project,
      members: [],
    })).toThrow('roster presentation requires the exact bridged roster read')
    await expect(ctx.desktopProjectMembership.questionRoute(agent, '   ', 'Acceptance session'))
      .resolves.toBeUndefined()
  })
})
