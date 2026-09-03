import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectMembershipClient } from '@deepseek-ai/dsh-project-membership-client'
import type { DesktopAccountActions } from '../src/platform-account.ts'
import {
  startDesktopProjectMembershipAgentRuntime,
  type DesktopProjectMembershipAgentRuntime,
} from '../src/project-membership-agent-runtime.ts'

let root: string | undefined
let runtime: DesktopProjectMembershipAgentRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Desktop Project Membership agent runtime', () => {
  it('projects only the signed-in Installation account, workspace context, and authenticated roster', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-project-members-agent-'))
    const projectByRemote = vi.fn().mockResolvedValue({
      id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/gestaltrun/atlas', createdAt: 1,
      receivingAccountId: 'account-a',
    })
    const membership = {
      projectByRemote,
      roster: vi.fn().mockResolvedValue({
        project: { id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/gestaltrun/atlas', createdAt: 1 },
        members: [{
          id: 'membership-a', accountId: 'account-a', role: 'owner', tags: [], joinedAt: 1,
          presence: 'online', displayName: 'Ada', avatarRef: 'https://avatars.example/ada.png',
        }],
      }),
    } as unknown as ProjectMembershipClient
    const account = {
      getSnapshot: () => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: { id: 'account-a', githubId: 101, githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
      }),
    } as DesktopAccountActions
    runtime = await startDesktopProjectMembershipAgentRuntime({
      userData: root,
      account: () => account,
      membership: () => membership,
      gitRemote: vi.fn().mockResolvedValue('https://github.com/gestaltrun/atlas.git'),
    })
    const token = (await readFile(runtime.tokenFile, 'utf8')).trim()
    if (process.platform !== 'win32') {
      expect((await stat(runtime.tokenFile)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(runtime.tokenFile))).mode & 0o777).toBe(0o700)
    }

    expect((await call(runtime.origin, token, '/v1/account', { cwd: process.cwd() })).body)
      .toMatchObject({ account: { id: 'account-a', githubLogin: 'ada' } })
    expect((await call(runtime.origin, token, '/v1/context', { cwd: '/workspace/atlas' })).body)
      .toMatchObject({ account: { id: 'account-a', githubLogin: 'ada' }, project: { id: 'project-atlas' } })
    expect(projectByRemote).toHaveBeenCalledWith('https://github.com/gestaltrun/atlas')
    expect((await call(runtime.origin, token, '/v1/roster', {
      actorAccountId: 'account-a', projectId: 'project-atlas',
    })).body).toMatchObject({ members: [{ accountId: 'account-a', displayName: 'Ada', presence: 'online' }] })

    expect((await call(runtime.origin, 'wrong', '/v1/context', { cwd: '/workspace/atlas' })).status).toBe(401)
    expect((await call(runtime.origin, token, '/v1/roster', {
      actorAccountId: 'account-b', projectId: 'project-atlas',
    })).status).toBe(403)
  })

  it('waits for an in-flight authenticated read before disposal completes', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-project-members-agent-'))
    let finishRead: (() => void) | undefined
    const pendingRead = new Promise<void>((resolve) => { finishRead = resolve })
    const projectByRemote = vi.fn(async () => {
      await pendingRead
      return undefined
    })
    const membership = {
      projectByRemote,
    } as unknown as ProjectMembershipClient
    const account = {
      getSnapshot: () => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: { id: 'account-a', githubId: 101, githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
      }),
    } as DesktopAccountActions
    let membershipSignal: AbortSignal | undefined
    runtime = await startDesktopProjectMembershipAgentRuntime({
      userData: root,
      account: () => account,
      membership: (_expectedAccountId, signal) => {
        membershipSignal = signal
        return membership
      },
      gitRemote: vi.fn().mockResolvedValue('https://github.com/gestaltrun/atlas.git'),
    })
    const token = (await readFile(runtime.tokenFile, 'utf8')).trim()
    const request = call(runtime.origin, token, '/v1/context', { cwd: '/workspace/atlas' }).catch(() => undefined)
    await vi.waitFor(() => { expect(projectByRemote).toHaveBeenCalledOnce() })
    let disposed = false
    const disposal = runtime.dispose().then(() => { disposed = true })
    runtime = undefined
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(membershipSignal?.aborted).toBe(true)

    finishRead?.()
    await Promise.all([request, disposal])
    expect(disposed).toBe(true)
  })

  it('rejects a context assembled across an Account switch', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-project-members-agent-'))
    let finishRead: (() => void) | undefined
    const pendingRead = new Promise<void>((resolve) => { finishRead = resolve })
    const projectByRemote = vi.fn(async () => {
      await pendingRead
      return { id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/gestaltrun/atlas', createdAt: 1 }
    })
    const membership = {
      projectByRemote,
    } as unknown as ProjectMembershipClient
    let accountId = 'account-a'
    const account = {
      getSnapshot: () => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: { id: accountId, githubId: 101, githubLogin: accountId, avatarUrl: '' },
      }),
    } as DesktopAccountActions
    runtime = await startDesktopProjectMembershipAgentRuntime({
      userData: root,
      account: () => account,
      membership: () => membership,
      gitRemote: vi.fn().mockResolvedValue('https://github.com/gestaltrun/atlas.git'),
    })
    const token = (await readFile(runtime.tokenFile, 'utf8')).trim()
    const requested = call(runtime.origin, token, '/v1/context', { cwd: '/workspace/atlas' })
    await vi.waitFor(() => { expect(projectByRemote).toHaveBeenCalledOnce() })
    accountId = 'account-b'
    finishRead?.()

    await expect(requested).resolves.toMatchObject({
      status: 400,
      body: { error: 'Desktop Project Membership account changed during the request' },
    })
  })

  it('looks up a Git-less Workspace through the local://workspace sentinel', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-project-members-agent-'))
    const projectByRemote = vi.fn().mockResolvedValue({
      id: 'project-local', name: 'Local', boundRemoteUrl: 'local://workspace/ws-local', createdAt: 1,
      receivingAccountId: 'account-a',
    })
    const membership = { projectByRemote } as unknown as ProjectMembershipClient
    const account = {
      getSnapshot: () => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: { id: 'account-a', githubId: 101, githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
      }),
    } as DesktopAccountActions
    runtime = await startDesktopProjectMembershipAgentRuntime({
      userData: root,
      account: () => account,
      membership: () => membership,
      gitRemote: vi.fn().mockResolvedValue(undefined),
    })
    const token = (await readFile(runtime.tokenFile, 'utf8')).trim()
    expect((await call(runtime.origin, token, '/v1/context', {
      cwd: '/workspace/local', workspaceId: 'ws-local',
    })).body).toMatchObject({ project: { id: 'project-local' } })
    expect(projectByRemote).toHaveBeenCalledWith('local://workspace/ws-local')
    expect((await call(runtime.origin, token, '/v1/context', { cwd: '/workspace/local' })).body)
      .toEqual({ account: { id: 'account-a', githubId: 101, githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' } })
    expect((await call(runtime.origin, token, '/v1/context', {
      cwd: '/workspace/local', workspaceId: '',
    })).body).toMatchObject({ error: 'workspaceId must be a non-empty string' })
  })
})

async function call(origin: string, token: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
