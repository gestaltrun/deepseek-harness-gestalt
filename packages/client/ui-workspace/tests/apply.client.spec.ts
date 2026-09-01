import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  const startSession = vi.fn()
  const rename = vi.fn(async () => ({}))
  const insertSessionBefore = vi.fn(async () => ({}))
  const open = vi.fn()
  const clear = vi.fn()
  const search = vi.fn(async () => ({
    ok: true as const,
    value: { items: [{ sessionId: 'session' as never, snippet: 'match' }], hasMore: false },
  }))
  const renameSession = vi.fn(async (title: string) => ({ ok: true, value: { title, seq: 1 } }))
  const binding = vi.fn(() => ({ session: { rename: renameSession } }))
  const fork = vi.fn(async () => 'forked' as never)
  const gitRemote = vi.fn(async (): Promise<string | undefined> => 'https://github.com/o/r.git')
  const pickDirectory = vi.fn<() => Promise<string | null>>().mockResolvedValue('/projects')
  const cloneGit = vi.fn(async () => ({
    workspaceId: 'cloned' as never, path: '/projects/cloned', title: 'cloned',
    sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  const bindWorkspace = vi.fn(async () => ({
    rpcId: 'binding-rpc' as never,
    result: { ok: true as const, value: { bound: true as const } },
  }))
  const workspaceBinding = vi.fn(async () => ({
    rpcId: 'binding-read-rpc' as never,
    result: { ok: true as const, value: { state: 'missing' as const } },
  }))
  const ensureWorkspaceBinding = vi.fn(async (input: { workspaceId: WorkspaceId }): Promise<{
    rpcId: never
    result: {
      ok: true
      value: {
        state: 'created' | 'existing' | 'repaired'
        workspaceId: WorkspaceId
      }
    }
  }> => ({
    rpcId: 'binding-ensure-rpc' as never,
    result: {
      ok: true as const,
      value: { state: 'created' as const, workspaceId: input.workspaceId },
    },
  }))
  ctx.provide('workspaces', {
    create, startSession, rename, insertSessionBefore, gitRemote, pickDirectory, cloneGit,
  } as never)
  ctx.provide('sessions', { open, clear, search, searchResultLimit: 20, binding, fork } as never)
  ctx.provide('connection', {
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    api: { memberQuestions: { workspaceBinding, ensureWorkspaceBinding, bindWorkspace } },
  } as never)
  const locale = new LocaleRuntime(ctx)
  // These specs assert the shipped Chinese copy. There is no jsdom `window`
  // in this lane, so browser-language detection never runs and the locale
  // comes from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, create, startSession, rename,
    insertSessionBefore, open, clear, search, renameSession, binding, fork,
    workspaceBinding, ensureWorkspaceBinding, bindWorkspace, gitRemote, pickDirectory, cloneGit,
  }
}

type HoleName = 'sidebar.workspaces' | 'conversation.hero.workspace' | 'conversation.empty.workspace'

/** Declare any subset of the holes with a single root registration ('root' is a single slot). */
function declare(slots: SlotRegistry, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }]))
  return slots.register({ name: 'root', children } as never, () => null)
}

describe('ui-workspace apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'locale', 'connection'])
  })

  it('registers browser and pickers for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.workspaces')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.workspaces')[0]!.component).toBe(WorkspaceBrowser)
    // Copy rides the standard locale seat: the entry declares the namespace
    // and apply registered both dictionaries.
    expect(before.slots.entries('sidebar.workspaces')[0]!.locale).toBe('workspace')
    expect(before.locale.bind('workspace')('session.new')).toBe('新会话')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'conversation.hero.workspace', 'conversation.empty.workspace')
    await Promise.resolve()
    expect(after.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
    // expect(after.slots.entries('conversation.empty.workspace')[0]!.component).toBe(WorkspacePicker)
  })

  it('routes browser actions and picker creation to the services', async () => {
    const b = await bench()
    const membershipAccess = {
      getSnapshot: () => ({ status: 'signed-out' as const }),
      subscribe: () => () => {},
      openSignIn: vi.fn(),
    }
    b.ctx.provide('projectMembershipAccess', membershipAccess)
    const createProject = vi.fn(async () => ({
      id: 'project-1', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/r', createdAt: 1,
      receivingAccountId: 'account-1',
    }))
    const projectByRemote = vi.fn(async () => ({
      id: 'project-1', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/r', createdAt: 1,
      receivingAccountId: 'account-1',
    }))
    const pendingInvitations = vi.fn(async () => [{
      invitationId: 'invitation-1', receivingAccountId: 'account-2',
      projectId: 'project-1', projectName: 'Atlas',
      remoteUrl: 'https://github.com/o/r', inviterName: 'Mona', invitedAt: 1,
    }])
    const decideInvitation = vi.fn(async () => undefined)
    b.ctx.provide('projectMembershipClient', {
      createProject,
      projectByRemote,
      roster: vi.fn(),
      invite: vi.fn(),
      decideInvitation,
      retractInvitation: vi.fn(),
      pendingInvitations,
      issuedInvitations: vi.fn(async () => []),
      changeRole: vi.fn(),
      setMemberTags: vi.fn(),
      removeMember: vi.fn(),
    } as never)
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    expect(browser.hooks.projectMembershipAccess).toBe(membershipAccess)
    browser.openProjectMembershipSignIn?.()
    expect(membershipAccess.openSignIn).toHaveBeenCalledOnce()
    // Both arms delegate to the runtime's shared New Session action.
    browser.startSession('ws' as never)
    expect(b.startSession).toHaveBeenCalledWith('ws')
    browser.startSession()
    expect(b.startSession).toHaveBeenLastCalledWith(undefined)
    browser.open('session' as never)
    expect(b.open).toHaveBeenCalledWith('session')
    const signal = new AbortController().signal
    await expect(browser.searchSessions('match', signal)).resolves.toEqual({
      items: [{ sessionId: 'session', snippet: 'match' }],
      hasMore: false,
    })
    expect(b.search).toHaveBeenCalledWith('match', signal)
    expect(browser.searchResultLimit).toBe(20)
    await browser.renameSession('session' as never, 'renamed session')
    expect(b.binding).toHaveBeenCalledWith('session')
    expect(b.renameSession).toHaveBeenCalledWith('renamed session')
    browser.forkSession('session' as never)
    await vi.waitFor(() => {
      expect(b.open).toHaveBeenCalledWith('forked')
    })
    expect(b.fork).toHaveBeenCalledWith({ sessionId: 'session', increaseTitle: true })
    await browser.renameWorkspace('ws' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('ws', 'renamed')
    await browser.insertSessionBefore('ws' as never, 's1' as never, 's2' as never)
    expect(b.insertSessionBefore).toHaveBeenCalledWith('ws', 's1', 's2')
    await browser.createWorkspace({ path: '/tmp/browser-project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/browser-project' })
    await expect(browser.projectMembership?.createProject({
      name: 'Atlas', localWorkspaceId: 'ws' as never,
    })).resolves.toEqual({
      id: 'project-1', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/r', receivingAccountId: 'account-1',
    })
    expect(createProject).toHaveBeenCalledWith({ name: 'Atlas', remoteUrl: 'https://github.com/o/r' })
    expect(b.bindWorkspace).toHaveBeenCalledWith({
      receivingAccountId: 'account-1', projectId: 'project-1', workspaceId: 'ws',
    })
    b.gitRemote.mockResolvedValueOnce('git@github.com:o/scp-repo.git')
    await browser.projectMembership?.createProject({ name: 'SCP', localWorkspaceId: 'ws' as never })
    expect(createProject).toHaveBeenLastCalledWith({ name: 'SCP', remoteUrl: 'git@github.com:o/scp-repo' })
    b.gitRemote.mockResolvedValueOnce(undefined)
    await expect(browser.projectMembership?.createProject({ name: 'Missing', localWorkspaceId: 'ws' as never }))
      .rejects.toThrow('must be a Git checkout with an origin remote')
    await expect(browser.projectMembership?.projectForWorkspace('ws' as never)).resolves.toMatchObject({
      id: 'project-1', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/r', receivingAccountId: 'account-1',
    })
    expect(projectByRemote).toHaveBeenCalledWith('https://github.com/o/r')
    expect(b.ensureWorkspaceBinding).toHaveBeenCalledWith({
      receivingAccountId: 'account-1', projectId: 'project-1', workspaceId: 'ws',
    })
    const bindingWrites = b.bindWorkspace.mock.calls.length
    b.ensureWorkspaceBinding.mockResolvedValueOnce({
      rpcId: 'binding-ensure-rpc' as never,
      result: {
        ok: true as const,
        value: {
          state: 'existing' as const,
          workspaceId: 'different-workspace' as never,
        },
      },
    })
    await expect(browser.projectMembership?.projectForWorkspace('ws' as never))
      .rejects.toThrow('already linked to another local Workspace')
    expect(b.bindWorkspace).toHaveBeenCalledTimes(bindingWrites)
    await expect(browser.projectMembership?.pendingInvitations()).resolves.toEqual([{
      invitationId: 'invitation-1', receivingAccountId: 'account-2', projectId: 'project-1',
      projectName: 'Atlas', inviterName: 'Mona',
      remoteUrl: 'https://github.com/o/r',
    }])
    expect(pendingInvitations).toHaveBeenCalledOnce()
    await expect(browser.projectMembership?.localRemoteFor('ws' as never))
      .resolves.toBe('https://github.com/o/r')
    b.gitRemote.mockResolvedValueOnce('file:///tmp/not-platform-safe')
    await expect(browser.projectMembership?.localRemoteFor('ws' as never)).resolves.toBeUndefined()
    await expect(browser.projectMembership?.cloneWorkspace({
      remoteUrl: 'https://github.com/o/r.git', directoryName: 'cloned',
    })).resolves.toEqual({
      workspaceId: 'cloned', title: 'cloned', normalizedRemoteUrl: 'https://github.com/o/r',
    })
    expect(b.cloneGit).toHaveBeenCalledWith({
      remoteUrl: 'https://github.com/o/r.git', parentPath: '/projects', directoryName: 'cloned',
    })
    b.pickDirectory.mockResolvedValueOnce(null)
    await expect(browser.projectMembership?.cloneWorkspace({
      remoteUrl: 'https://github.com/o/r.git', directoryName: 'cancelled',
    })).resolves.toBeUndefined()
    await browser.projectMembership?.decideInvitation('invitation-1', {
      decision: 'accept-with-link',
      localWorkspaceId: 'ws' as never,
      receivingAccountId: 'account-2',
      projectId: 'project-1',
      link: { workspaceName: 'Atlas', normalizedRemoteUrl: 'https://github.com/o/r' },
    })
    expect(b.bindWorkspace).toHaveBeenCalledWith({
      receivingAccountId: 'account-2', projectId: 'project-1', workspaceId: 'ws',
    })
    expect(decideInvitation).toHaveBeenCalledWith('invitation-1', {
      decision: 'accept-with-link',
      link: { workspaceName: 'Atlas', normalizedRemoteUrl: 'https://github.com/o/r' },
    })
    expect(b.bindWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(decideInvitation.mock.invocationCallOrder[0]!)

    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    await picker.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/project' })
  })

  it('declares the two directory-flow holes and reports their occupancy per surface', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Registration declared the child holes (declaration = render authorization).
    expect(b.slots.spec('sidebar.workspaces.directoryFlow')).toMatchObject({ kind: 'single' })
    expect(b.slots.spec('conversation.hero.workspace.directoryFlow')).toMatchObject({ kind: 'single' })

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    expect(browser.hooks.hostDescription.getSnapshot()).toBeUndefined()
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    // A flow occupant flips exactly its own surface, and the source notifies.
    const notified = vi.fn()
    const unsubscribe = browser.hooks.directoryFlow.subscribe(notified)
    const dispose = b.slots.register({ name: 'sidebar.workspaces.directoryFlow' } as never, () => null)
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(true)
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    await Promise.resolve()
    expect(notified).toHaveBeenCalled()
    dispose()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    unsubscribe()
  })

  it('rejects the browser search callback on a runtime business error', async () => {
    const b = await bench()
    b.search.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'internal', message: 'index unavailable', details: {} },
    }) as never)
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    await expect(browser.searchSessions('needle', new AbortController().signal))
      .rejects.toThrow('index unavailable')
  })

  it('unregisters every entry on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace', 'conversation.empty.workspace')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
    // expect(b.slots.entries('conversation.empty.workspace')).toHaveLength(0)
  })
})
