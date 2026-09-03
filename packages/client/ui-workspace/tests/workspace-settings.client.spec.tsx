// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ProjectMembershipGateway, WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import {
  cloneDirectoryName,
  InviteWizardModal,
  WorkspaceSettingsModal,
} from '../src/client/WorkspaceSettings.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

beforeEach(() => { localStorage.clear() })

const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt,
})
const sessionState = (items: readonly SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined,
  phase: 'ready',
  subagentsByParent: {}, jobsBySession: {},
  currentAddress: undefined,
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const SAME_REMOTE = 'https://github.com/octocat/repo'

function gateway(overrides: Partial<ProjectMembershipGateway> = {}) {
  return {
    createProject: vi.fn<ProjectMembershipGateway['createProject']>()
      .mockResolvedValue({
        id: 'project-1', name: 'Assembled', boundRemoteUrl: SAME_REMOTE, receivingAccountId: 'account-owner',
      }),
    projectForWorkspace: vi.fn<ProjectMembershipGateway['projectForWorkspace']>().mockResolvedValue(undefined),
    roster: vi.fn<ProjectMembershipGateway['roster']>().mockResolvedValue({
      project: { id: 'project-1', name: 'Assembled', boundRemoteUrl: SAME_REMOTE },
      members: [{
        membershipId: 'membership-owner', accountId: 'account-owner', displayName: 'octocat',
        role: 'owner', tags: [], presence: 'online',
      }, {
        membershipId: 'membership-1', accountId: 'account-2', displayName: 'mona',
        role: 'member', tags: ['triage'], presence: 'online',
      }],
    }),
    invite: vi.fn<ProjectMembershipGateway['invite']>()
      .mockResolvedValue({ invitationId: 'invitation-9', inviteeName: 'mona', grantedRole: 'member' }),
    issuedInvitations: vi.fn<ProjectMembershipGateway['issuedInvitations']>().mockResolvedValue([]),
    retractInvitation: vi.fn<ProjectMembershipGateway['retractInvitation']>().mockResolvedValue(undefined),
    decideInvitation: vi.fn<ProjectMembershipGateway['decideInvitation']>().mockResolvedValue(undefined),
    changeRole: vi.fn<ProjectMembershipGateway['changeRole']>().mockResolvedValue(undefined),
    setMemberTags: vi.fn<ProjectMembershipGateway['setMemberTags']>().mockResolvedValue(undefined),
    removeMember: vi.fn<ProjectMembershipGateway['removeMember']>().mockResolvedValue(undefined),
    pendingInvitations: vi.fn<ProjectMembershipGateway['pendingInvitations']>().mockResolvedValue([]),
    localRemoteFor: async (workspaceId: WorkspaceId) => (workspaceId === wid('proj') ? SAME_REMOTE : undefined),
    cloneWorkspace: vi.fn<ProjectMembershipGateway['cloneWorkspace']>().mockResolvedValue({
      workspaceId: wid('cloned'), title: 'Assembled', normalizedRemoteUrl: SAME_REMOTE,
    }),
    ...overrides,
  }
}

function mount(membership: ProjectMembershipGateway | undefined, overrides: Partial<WorkspaceBrowserProps> = {}) {
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: hook(sessionState([summary('alpha-s', 2)])),
    useWorkspaces: hook(workspaceState([workspace('proj', ['alpha-s'])])),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    startSession: vi.fn(),
    open: vi.fn(),
    searchSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
    renameSession: vi.fn(async () => {}),
    forkSession: vi.fn(),
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    insertWorkspaceBefore: vi.fn(async () => {}),
    insertSessionBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace('created', [])),
    useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} }),
    useHostDescription: selector => selector(undefined),
    renderSlot: ((_name: string, owner: { open: boolean }) => (owner.open ? <div data-testid="directory-flow" /> : null)) as never,
    t,
    projectMembership: membership,
    ...overrides,
  }
  return render(<WorkspaceBrowser {...props} />)
}

/** Open a real workspace row's ⋯ menu. */
function openWorkspaceMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: t('actions.workspace.aria', { name: 'proj' }) }))
}


/** Flush one fake-timer tick plus every promise it queued, then let React settle. */
async function tick(ms = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const projectView = {
  id: 'project-1', name: 'Assembled', boundRemoteUrl: SAME_REMOTE, receivingAccountId: 'account-owner',
}
const pendingInvitation = {
  invitationId: 'invitation-1',
  receivingAccountId: 'account-2',
  projectId: 'project-1',
  projectName: 'Assembled',
  inviterName: 'mona',
  remoteUrl: SAME_REMOTE,
  grantedRole: 'admin' as const,
}

describe('workspace settings and invite wizard (M4)', () => {
  it('derives a safe clone directory name from HTTPS and scp-like remotes', () => {
    expect(cloneDirectoryName('https://github.com/o/repo.git', 'fallback')).toBe('repo')
    expect(cloneDirectoryName('git@github.com:o/Repo.git', 'fallback')).toBe('Repo')
    expect(cloneDirectoryName('https://example.test/o/CON.git', 'fallback')).toBe('project-CON')
    expect(cloneDirectoryName('https://example.test/o/a*b.git', 'fallback')).toBe('a-b')
    expect(cloneDirectoryName(':', '..')).toBe('project')
  })

  it('offers 工作区设置 as the first workspace-row menu item', () => {
    mount(undefined)
    openWorkspaceMenu()
    const items = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(items[0]).toBe('工作区设置')
    expect(items).toEqual(['工作区设置', '重命名', '删除工作区'])
  })

  it('routes the upgrade create action through the membership gateway and shows the roster', async () => {
    const membership = gateway()
    vi.useFakeTimers()
    try {
      mount(membership)
      openWorkspaceMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: '工作区设置' }))
      await tick()
      fireEvent.change(screen.getByLabelText('云项目名称'), { target: { value: 'Assembled' } })
      const remote = screen.getByLabelText('Git remote 地址') as HTMLInputElement
      expect(remote.readOnly).toBe(true)
      expect(remote.value).toBe(SAME_REMOTE)
      fireEvent.click(screen.getByRole('button', { name: '创建云项目' }))
      await tick()
      expect(membership.createProject).toHaveBeenCalledWith({
        name: 'Assembled', localWorkspaceId: wid('proj'),
      })
      // Binding resolves: the roster read rides the same gateway.
      expect(membership.roster).toHaveBeenCalledWith('project-1')
      expect(screen.getByText('已绑定云项目：Assembled')).toBeTruthy()
      expect(screen.getByText('mona')).toBeTruthy()
      const inviteRole = screen.getByLabelText('邀请角色')
      expect(inviteRole).toBeTruthy()
      expect(Array.from(inviteRole.querySelectorAll('option')).map(option => option.value)).toEqual(['admin', 'member'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('enables Cloud Project creation for a Workspace without a Git origin once a name is entered', async () => {
    const membership = gateway({ localRemoteFor: vi.fn(async () => undefined) })
    vi.useFakeTimers()
    try {
      mount(membership)
      openWorkspaceMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: '工作区设置' }))
      await tick()
      const remote = screen.getByLabelText('Git remote 地址') as HTMLInputElement
      expect(remote.readOnly).toBe(true)
      expect(remote.value).toBe('')
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建云项目' }).disabled).toBe(true)
      fireEvent.change(screen.getByLabelText('云项目名称'), { target: { value: 'Assembled' } })
      expect(screen.queryByText('此工作区必须是带有 origin remote 的 Git checkout，才能升级为云项目。')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建云项目' }).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: '创建云项目' }))
      await tick()
      expect(membership.createProject).toHaveBeenCalledWith({
        name: 'Assembled', localWorkspaceId: wid('proj'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a successfully read Git remote when project recovery fails independently', async () => {
    const membership = gateway({
      projectForWorkspace: vi.fn().mockRejectedValue(new Error('lookup error')),
      localRemoteFor: vi.fn(async () => SAME_REMOTE),
    })
    render(<WorkspaceSettingsModal
      workspaceId={wid('proj')} workspaceTitle="proj" gateway={membership} onClose={vi.fn()} t={t}
    />)
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('lookup error')
    expect((screen.getByLabelText('Git remote 地址') as HTMLInputElement).value).toBe(SAME_REMOTE)
    fireEvent.change(screen.getByLabelText('云项目名称'), { target: { value: 'Assembled' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建云项目' }).disabled).toBe(false)
  })

  it('restores an existing Cloud Project for the exact Workspace after reopening settings', async () => {
    const issuedInvitations = vi.fn<ProjectMembershipGateway['issuedInvitations']>()
      .mockResolvedValueOnce([{ invitationId: 'invitation-issued', inviteeName: 'invitee-octocat', grantedRole: 'admin' }])
      .mockResolvedValueOnce([])
    const membership = gateway({
      projectForWorkspace: vi.fn(async () => ({
        id: 'project-1', name: 'Restored', boundRemoteUrl: SAME_REMOTE, receivingAccountId: 'account-owner',
      })),
      issuedInvitations,
    })
    vi.useFakeTimers()
    try {
      mount(membership)
      openWorkspaceMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: '工作区设置' }))
      await tick()
      expect(membership.projectForWorkspace).toHaveBeenCalledWith(wid('proj'))
      expect(screen.getByText('已绑定云项目：Restored')).toBeTruthy()
      expect(membership.roster).toHaveBeenCalledWith('project-1')
      expect(issuedInvitations).toHaveBeenCalledWith('project-1')
      expect(screen.getByText('invitee-octocat')).toBeTruthy()
      expect(screen.getByText('加入后为 admin')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '撤回' }))
      await tick()
      expect(membership.retractInvitation).toHaveBeenCalledWith('invitation-issued')
      expect(issuedInvitations).toHaveBeenCalledTimes(2)
      expect(screen.queryByText('invitee-octocat')).toBeNull()
      expect(screen.queryByRole('button', { name: '创建云项目' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers only member when the current actor is an admin', async () => {
    const membership = gateway({
      projectForWorkspace: vi.fn(async () => ({
        id: 'project-1', name: 'Assembled', boundRemoteUrl: SAME_REMOTE, receivingAccountId: 'account-admin',
      })),
      roster: vi.fn(async () => ({
        project: { id: 'project-1', name: 'Assembled', boundRemoteUrl: SAME_REMOTE },
        members: [{
          membershipId: 'membership-owner', accountId: 'account-owner', displayName: 'octocat',
          role: 'owner' as const, tags: [], presence: 'online' as const,
        }, {
          membershipId: 'membership-admin', accountId: 'account-admin', displayName: 'mona',
          role: 'admin' as const, tags: [], presence: 'online' as const,
        }],
      })),
    })
    render(<WorkspaceSettingsModal
      workspaceId={wid('proj')} workspaceTitle="proj" gateway={membership} onClose={vi.fn()} t={t}
    />)
    await flush()
    const inviteRole = screen.getByLabelText(t('members.inviteRole')) as HTMLSelectElement
    expect(Array.from(inviteRole.querySelectorAll('option')).map(option => option.value)).toEqual(['member'])
    fireEvent.change(screen.getByLabelText(t('members.inviteLogin')), { target: { value: 'ada' } })
    fireEvent.click(screen.getByRole('button', { name: t('members.invite') }))
    await flush()
    expect(membership.invite).toHaveBeenCalledWith({
      projectId: 'project-1', githubLogin: 'ada', grantedRole: 'member',
    })
  })

  it('runs the invite wizard: accept, mandatory link with same-remote advice, close returns undecided', async () => {
    const membership = gateway({
      pendingInvitations: vi.fn(async () => [{
        invitationId: 'invitation-1', receivingAccountId: 'account-2', projectId: 'project-1',
        projectName: 'Assembled', inviterName: 'mona', remoteUrl: SAME_REMOTE, grantedRole: 'admin' as const,
      }]),
    })
    vi.useFakeTimers()
    try {
      mount(membership)
      // Poll fires immediately: the wizard opens on the invitation card.
      await tick()
      expect(screen.getByText('mona 邀请你加入云项目“Assembled”。')).toBeTruthy()
      expect(screen.getByText('加入后角色：admin')).toBeTruthy()
      expect(screen.getByText(SAME_REMOTE)).toBeTruthy()

      // Closing at the card decides nothing: the invitation stays pending.
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      expect(screen.queryByText('mona 邀请你加入云项目“Assembled”。')).toBeNull()
      expect(membership.decideInvitation).not.toHaveBeenCalled()
      expect(membership.pendingInvitations).toHaveBeenCalled()

      // Next poll re-offers the still-pending invitation.
      await tick(15_000)
      fireEvent.click(screen.getByRole('button', { name: '接受' }))
      await tick()

      // Link step: no 暂不关联 — confirm stays disabled until a candidate (or the
      // clone item) is selected, and the same-remote workspace is recommended.
      const confirm = screen.getByRole('button', { name: '关联并加入' }) as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      expect(screen.getByText('同源推荐')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      expect(screen.queryByText('关联本地工作区')).toBeNull()
      expect(membership.decideInvitation).not.toHaveBeenCalled()
      await tick(15_000)
      expect(screen.getByText('加入后角色：admin')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '接受' }))
      await tick()
      expect(screen.queryByText('暂不关联')).toBeNull()
      expect(screen.getByText('新建克隆…')).toBeTruthy()

      fireEvent.click(screen.getByRole('radio', { name: /proj/ }))
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '关联并加入' }).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: '关联并加入' }))
      await tick()
      expect(membership.decideInvitation).toHaveBeenCalledWith('invitation-1', {
        decision: 'accept-with-link',
        localWorkspaceId: 'proj',
        receivingAccountId: 'account-2',
        projectId: 'project-1',
        link: { workspaceName: 'proj', normalizedRemoteUrl: SAME_REMOTE },
      })
      expect(screen.queryByText('关联本地工作区')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clones before accepting and keeps the invitation pending when directory selection is cancelled', async () => {
    const cloneWorkspace = vi.fn<ProjectMembershipGateway['cloneWorkspace']>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        workspaceId: wid('clone'), title: 'Assembled', normalizedRemoteUrl: SAME_REMOTE,
      })
    const membership = gateway({
      pendingInvitations: vi.fn(async () => [{
        invitationId: 'invitation-clone', receivingAccountId: 'account-2', projectId: 'project-1',
        projectName: 'Assembled', inviterName: 'mona', remoteUrl: SAME_REMOTE, grantedRole: 'member' as const,
      }]),
      cloneWorkspace,
    })
    vi.useFakeTimers()
    try {
      mount(membership)
      await tick()
      fireEvent.click(screen.getByRole('button', { name: '接受' }))
      await tick()
      fireEvent.click(screen.getByRole('radio', { name: /新建克隆/ }))
      fireEvent.click(screen.getByRole('button', { name: '关联并加入' }))
      await tick()
      expect(membership.decideInvitation).not.toHaveBeenCalled()
      expect(screen.getByText('关联本地工作区')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: '关联并加入' }))
      await tick()
      expect(cloneWorkspace).toHaveBeenLastCalledWith({
        remoteUrl: SAME_REMOTE, directoryName: 'repo',
      })
      expect(membership.decideInvitation).toHaveBeenCalledWith('invitation-clone', {
        decision: 'accept-with-link',
        localWorkspaceId: 'clone',
        receivingAccountId: 'account-2',
        projectId: 'project-1',
        link: { workspaceName: 'Assembled', normalizedRemoteUrl: SAME_REMOTE },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('declining from the wizard card routes the decline decision', async () => {
    const membership = gateway({
      pendingInvitations: vi.fn(async () => [{
        invitationId: 'invitation-1', receivingAccountId: 'account-2', projectId: 'project-1',
        projectName: 'Assembled', inviterName: 'mona', remoteUrl: SAME_REMOTE, grantedRole: 'admin' as const,
      }]),
    })
    vi.useFakeTimers()
    try {
      mount(membership)
      await tick()
      fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
      await tick()
      expect(membership.decideInvitation).toHaveBeenCalledWith('invitation-1', { decision: 'decline' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains settings lookup completion and failure after unmount and reports active Error and string failures', async () => {
    for (const reason of [new Error('lookup error'), 'lookup string']) {
      const membership = gateway({
        projectForWorkspace: vi.fn().mockRejectedValue(reason),
        localRemoteFor: vi.fn(async () => SAME_REMOTE),
      })
      render(<WorkspaceSettingsModal
        workspaceId={wid('proj')} workspaceTitle="proj" gateway={membership} onClose={vi.fn()} t={t}
      />)
      await flush()
      expect(screen.getByRole('alert').textContent).toBe(reason instanceof Error ? reason.message : reason)
      cleanup()
    }

    const projectLookup = deferred<undefined>()
    const remoteLookup = deferred<string | undefined>()
    const resolved = render(<WorkspaceSettingsModal
      workspaceId={wid('proj')}
      workspaceTitle="proj"
      gateway={gateway({
        projectForWorkspace: vi.fn(() => projectLookup.promise),
        localRemoteFor: vi.fn(() => remoteLookup.promise),
      })}
      onClose={vi.fn()}
      t={t}
    />)
    resolved.unmount()
    await act(async () => {
      projectLookup.resolve(undefined)
      remoteLookup.resolve(undefined)
      await Promise.all([projectLookup.promise, remoteLookup.promise])
    })

    const rejectedLookup = deferred<undefined>()
    const rejected = render(<WorkspaceSettingsModal
      workspaceId={wid('proj')}
      workspaceTitle="proj"
      gateway={gateway({ projectForWorkspace: vi.fn(() => rejectedLookup.promise) })}
      onClose={vi.fn()}
      t={t}
    />)
    rejected.unmount()
    await act(async () => {
      rejectedLookup.reject(new Error('late lookup'))
      await Promise.resolve()
    })
  })

  it('reports Error and string failures while creating a Cloud Project', async () => {
    const createProject = vi.fn<ProjectMembershipGateway['createProject']>()
      .mockRejectedValueOnce(new Error('create error'))
      .mockRejectedValueOnce('create string')
    const membership = gateway({ createProject })
    render(<WorkspaceSettingsModal
      workspaceId={wid('proj')} workspaceTitle="proj" gateway={membership} onClose={vi.fn()} t={t}
    />)
    await flush()
    const name = screen.getByLabelText('云项目名称')
    fireEvent.change(name, { target: { value: 'Assembled' } })
    fireEvent.click(screen.getByRole('button', { name: '创建云项目' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('create error')
    fireEvent.change(name, { target: { value: 'Assembled again' } })
    fireEvent.click(screen.getByRole('button', { name: '创建云项目' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('create string')
  })

  it('contains roster and issued-invitation completion after unmount and reports both failure forms', async () => {
    for (const [rosterReason, issuedReason] of [
      [new Error('roster error'), 'issued string'],
      ['roster string', new Error('issued error')],
    ] as const) {
      render(<WorkspaceSettingsModal
        workspaceId={wid('proj')}
        workspaceTitle="proj"
        gateway={gateway({
          projectForWorkspace: vi.fn(async () => projectView as never),
          roster: vi.fn().mockRejectedValue(rosterReason),
          issuedInvitations: vi.fn().mockRejectedValue(issuedReason),
        })}
        onClose={vi.fn()}
        t={t}
      />)
      await flush()
      expect(screen.getByRole('alert')).toBeTruthy()
      cleanup()
    }

    const rosterRead = deferred<Awaited<ReturnType<ProjectMembershipGateway['roster']>>>()
    const issuedRead = deferred<Awaited<ReturnType<ProjectMembershipGateway['issuedInvitations']>>>()
    const completed = render(<WorkspaceSettingsModal
      workspaceId={wid('proj')}
      workspaceTitle="proj"
      gateway={gateway({
        projectForWorkspace: vi.fn(async () => projectView as never),
        roster: vi.fn(() => rosterRead.promise),
        issuedInvitations: vi.fn(() => issuedRead.promise),
      })}
      onClose={vi.fn()}
      t={t}
    />)
    await flush()
    completed.unmount()
    await act(async () => {
      rosterRead.resolve({ project: projectView, members: [] })
      issuedRead.resolve([])
      await Promise.all([rosterRead.promise, issuedRead.promise])
    })

    const lateRoster = deferred<Awaited<ReturnType<ProjectMembershipGateway['roster']>>>()
    const lateIssued = deferred<Awaited<ReturnType<ProjectMembershipGateway['issuedInvitations']>>>()
    const failed = render(<WorkspaceSettingsModal
      workspaceId={wid('proj')}
      workspaceTitle="proj"
      gateway={gateway({
        projectForWorkspace: vi.fn(async () => projectView as never),
        roster: vi.fn(() => lateRoster.promise),
        issuedInvitations: vi.fn(() => lateIssued.promise),
      })}
      onClose={vi.fn()}
      t={t}
    />)
    await flush()
    failed.unmount()
    await act(async () => {
      lateRoster.reject(new Error('late roster'))
      lateIssued.reject('late issued')
      await Promise.allSettled([lateRoster.promise, lateIssued.promise])
    })

    render(<WorkspaceSettingsModal
      workspaceId={wid('proj')}
      workspaceTitle="proj"
      gateway={gateway({
        projectForWorkspace: vi.fn(async () => projectView as never),
        roster: vi.fn(async () => ({ project: projectView, members: [] } as never)),
      })}
      onClose={vi.fn()}
      t={t}
    />)
    await flush()
    expect(screen.getByText(t('members.empty'))).toBeTruthy()
  })

  it('runs invitation and roster administration through pending, success, and both failure forms', async () => {
    const inviteRun = deferred<{ invitationId: string; inviteeName: string; grantedRole: 'member' }>()
    const invite = vi.fn<ProjectMembershipGateway['invite']>()
      .mockReturnValueOnce(inviteRun.promise)
      .mockRejectedValueOnce(new Error('invite error'))
      .mockRejectedValueOnce('invite string')
    const retractRun = deferred<undefined>()
    const retractInvitation = vi.fn<ProjectMembershipGateway['retractInvitation']>()
      .mockReturnValueOnce(retractRun.promise)
      .mockRejectedValueOnce(new Error('retract error'))
      .mockRejectedValueOnce('retract string')
    const setMemberTags = vi.fn<ProjectMembershipGateway['setMemberTags']>()
      .mockRejectedValueOnce(new Error('tags error'))
    const removeMember = vi.fn<ProjectMembershipGateway['removeMember']>()
      .mockRejectedValueOnce('remove string')
    const members = [
      {
        membershipId: 'membership-owner', accountId: 'account-owner', displayName: 'octocat',
        role: 'owner' as const, tags: [], presence: 'online' as const,
      },
      {
        membershipId: 'membership-1', accountId: 'account-2', displayName: 'mona',
        role: 'member' as const, tags: ['triage'], presence: 'online' as const,
      },
      {
        membershipId: 'membership-2', accountId: 'account-3', displayName: '',
        role: 'admin' as const, tags: [], presence: 'offline' as const,
      },
    ]
    const membership = gateway({
      projectForWorkspace: vi.fn(async () => projectView as never),
      roster: vi.fn(async () => ({ project: projectView, members } as never)),
      issuedInvitations: vi.fn(async () => [{ invitationId: 'issued-1', inviteeName: 'octocat', grantedRole: 'member' as const }]),
      invite,
      retractInvitation,
      setMemberTags,
      removeMember,
    })
    render(<WorkspaceSettingsModal
      workspaceId={wid('proj')} workspaceTitle="proj" gateway={membership} onClose={vi.fn()} t={t}
    />)
    await flush()
    expect(screen.getByText('account-3')).toBeTruthy()
    expect(screen.getByText(t('members.offline'))).toBeTruthy()

    const login = screen.getByLabelText(t('members.inviteLogin'))
    fireEvent.change(login, { target: { value: ' octocat ' } })
    fireEvent.change(screen.getByLabelText(t('members.inviteRole')), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('button', { name: t('members.invite') }))
    expect(screen.getByRole('button', { name: t('members.inviting') })).toBeTruthy()
    await act(async () => {
      inviteRun.resolve({ invitationId: 'new', inviteeName: 'octocat', grantedRole: 'member' })
      await inviteRun.promise
    })
    expect(invite).toHaveBeenCalledWith({
      projectId: 'project-1', githubLogin: 'octocat', grantedRole: 'admin',
    })
    expect((login as HTMLInputElement).value).toBe('')
    for (const [value, message] of [['mona', 'invite error'], ['ada', 'invite string']] as const) {
      fireEvent.change(login, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: t('members.invite') }))
      await flush()
      expect(screen.getByRole('alert').textContent).toBe(message)
    }

    fireEvent.click(screen.getByRole('button', { name: t('invitations.retract') }))
    expect(screen.getByRole('button', { name: t('invitations.retracting') })).toBeTruthy()
    await act(async () => { retractRun.resolve(undefined); await retractRun.promise })
    for (const message of ['retract error', 'retract string']) {
      fireEvent.click(screen.getByRole('button', { name: t('invitations.retract') }))
      await flush()
      expect(screen.getByRole('alert').textContent).toBe(message)
    }

    const memberRole = screen.getAllByRole('combobox').find(node => (node as HTMLSelectElement).value === 'member')
    expect(memberRole).toBeDefined()
    fireEvent.change(memberRole!, { target: { value: 'admin' } })
    await flush()
    expect(membership.changeRole).toHaveBeenCalledWith('membership-1', 'admin')
    const tags = screen.getAllByLabelText(t('members.tagsPlaceholder'))[1]!
    fireEvent.blur(tags)
    expect(setMemberTags).not.toHaveBeenCalled()
    fireEvent.change(tags, { target: { value: ' triage, , qa ' } })
    fireEvent.keyDown(tags, { key: 'Escape' })
    expect(setMemberTags).not.toHaveBeenCalled()
    fireEvent.keyDown(tags, { key: 'Enter' })
    await flush()
    expect(setMemberTags).toHaveBeenCalledWith('membership-1', ['triage', 'qa'])
    expect(screen.getByRole('alert').textContent).toBe('tags error')
    fireEvent.click(screen.getAllByRole('button', { name: t('members.remove') })[0]!)
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('remove string')
  })

  it('contains retract completion after unmount', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const run = deferred<undefined>()
      const membership = gateway({
        projectForWorkspace: vi.fn(async () => projectView as never),
        issuedInvitations: vi.fn(async () => [{ invitationId: 'issued-1', inviteeName: 'octocat', grantedRole: 'member' as const }]),
        retractInvitation: vi.fn(() => run.promise),
      })
      const view = render(<WorkspaceSettingsModal
        workspaceId={wid('proj')} workspaceTitle="proj" gateway={membership} onClose={vi.fn()} t={t}
      />)
      await flush()
      fireEvent.click(screen.getByRole('button', { name: t('invitations.retract') }))
      view.unmount()
      await act(async () => {
        if (outcome === 'resolve') run.resolve(undefined)
        else run.reject(new Error('late retract'))
        await Promise.allSettled([run.promise])
      })
    }
  })

  it('handles wizard remote lookup, foreign badges, busy close, and both decline failure forms', async () => {
    const remoteRun = deferred<string | undefined>()
    const disposed = render(<InviteWizardModal
      invitation={pendingInvitation as never}
      workspaces={[{ workspaceId: wid('first'), title: 'First' }]}
      gateway={gateway({ localRemoteFor: vi.fn(() => remoteRun.promise) })}
      onClose={vi.fn()}
      t={t}
    />)
    disposed.unmount()
    await act(async () => { remoteRun.resolve(SAME_REMOTE); await remoteRun.promise })

    render(<InviteWizardModal
      invitation={pendingInvitation as never}
      workspaces={[
        { workspaceId: wid('unknown'), title: 'Unknown' },
        { workspaceId: wid('foreign'), title: 'Foreign' },
      ]}
      gateway={gateway({
        localRemoteFor: vi.fn(async id => id === wid('foreign') ? 'https://github.com/other/repo' : undefined),
      })}
      onClose={vi.fn()}
      t={t}
    />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('wizard.accept') }))
    expect(screen.getByText(t('wizard.link.foreign'))).toBeTruthy()
    expect(screen.queryByText(t('wizard.link.recommended'))).toBeNull()
    cleanup()

    render(<InviteWizardModal
      invitation={pendingInvitation as never}
      workspaces={[{ workspaceId: wid('failed'), title: 'Failed' }]}
      gateway={gateway({ localRemoteFor: vi.fn().mockRejectedValue(new Error('git unavailable')) })}
      onClose={vi.fn()}
      t={t}
    />)
    await flush()
    cleanup()

    const declineRun = deferred<undefined>()
    const decideInvitation = vi.fn<ProjectMembershipGateway['decideInvitation']>()
      .mockReturnValueOnce(declineRun.promise)
      .mockRejectedValueOnce('decline string')
    const onClose = vi.fn()
    render(<InviteWizardModal
      invitation={pendingInvitation}
      workspaces={[]}
      gateway={gateway({ decideInvitation })}
      onClose={onClose}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: t('wizard.decline') }))
    fireEvent.click(screen.getByRole('button', { name: t('close') }))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { declineRun.reject(new Error('decline error')); await Promise.allSettled([declineRun.promise]) })
    expect(screen.getByRole('alert').textContent).toBe('decline error')
    fireEvent.click(screen.getByRole('button', { name: t('wizard.decline') }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('decline string')
  })

  it('accepts an unbadged Workspace without inventing a remote and reports candidate drift and decision failure', async () => {
    const decideInvitation = vi.fn<ProjectMembershipGateway['decideInvitation']>().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const selected = render(<InviteWizardModal
      invitation={pendingInvitation as never}
      workspaces={[{ workspaceId: wid('first'), title: 'First' }]}
      gateway={gateway({ localRemoteFor: vi.fn(async () => undefined), decideInvitation })}
      onClose={onClose}
      t={t}
    />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('wizard.accept') }))
    fireEvent.click(screen.getByRole('radio', { name: /^First/ }))
    fireEvent.click(screen.getByRole('button', { name: t('wizard.link.confirm') }))
    await flush()
    expect(decideInvitation).toHaveBeenCalledWith('invitation-1', {
      decision: 'accept-with-link',
      localWorkspaceId: 'first',
      receivingAccountId: 'account-2',
      projectId: 'project-1',
      link: { workspaceName: 'First' },
    })
    expect(onClose).toHaveBeenCalledOnce()
    selected.unmount()

    const driftGateway = gateway({ localRemoteFor: vi.fn(async () => SAME_REMOTE) })
    const drift = render(<InviteWizardModal
      invitation={pendingInvitation as never}
      workspaces={[{ workspaceId: wid('first'), title: 'First' }]}
      gateway={driftGateway}
      onClose={vi.fn()}
      t={t}
    />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('wizard.accept') }))
    fireEvent.click(screen.getByRole('radio', { name: /^First/ }))
    drift.rerender(<InviteWizardModal
      invitation={pendingInvitation}
      workspaces={[]}
      gateway={driftGateway}
      onClose={vi.fn()}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: t('wizard.link.confirm') }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('Workspace selection did not resolve')
    drift.unmount()

    const rejected = render(<InviteWizardModal
      invitation={pendingInvitation as never}
      workspaces={[{ workspaceId: wid('first'), title: 'First' }]}
      gateway={gateway({
        localRemoteFor: vi.fn(async () => SAME_REMOTE),
        decideInvitation: vi.fn().mockRejectedValue('decision string'),
      })}
      onClose={vi.fn()}
      t={t}
    />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: t('wizard.accept') }))
    fireEvent.click(screen.getByRole('radio', { name: /^First/ }))
    fireEvent.click(screen.getByRole('button', { name: t('wizard.link.confirm') }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('decision string')
    rejected.unmount()
  })
})
