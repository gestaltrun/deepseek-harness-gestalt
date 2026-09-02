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
      if (String(input).endsWith('/v1/context') || String(input).endsWith('/v1/account')) {
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
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
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
})
