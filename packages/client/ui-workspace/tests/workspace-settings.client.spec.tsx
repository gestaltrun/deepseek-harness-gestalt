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
      .mockResolvedValue({ id: 'project-1', name: 'Assembled', boundRemoteUrl: SAME_REMOTE }),
    roster: vi.fn<ProjectMembershipGateway['roster']>().mockResolvedValue({
      project: { id: 'project-1', name: 'Assembled', boundRemoteUrl: SAME_REMOTE },
      members: [{
        membershipId: 'membership-1', accountId: 'account-2', displayName: 'mona',
        role: 'member', tags: ['triage'], presence: 'online',
      }],
    }),
    invite: vi.fn<ProjectMembershipGateway['invite']>()
      .mockResolvedValue({ invitationId: 'invitation-9', inviteeName: 'mona' }),
    retractInvitation: vi.fn<ProjectMembershipGateway['retractInvitation']>().mockResolvedValue(undefined),
    decideInvitation: vi.fn<ProjectMembershipGateway['decideInvitation']>().mockResolvedValue(undefined),
    changeRole: vi.fn<ProjectMembershipGateway['changeRole']>().mockResolvedValue(undefined),
    setMemberTags: vi.fn<ProjectMembershipGateway['setMemberTags']>().mockResolvedValue(undefined),
    removeMember: vi.fn<ProjectMembershipGateway['removeMember']>().mockResolvedValue(undefined),
    pendingInvitations: vi.fn<ProjectMembershipGateway['pendingInvitations']>().mockResolvedValue([]),
    localRemoteFor: (workspaceId: WorkspaceId) => (workspaceId === wid('proj') ? SAME_REMOTE : undefined),
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

describe('workspace settings and invite wizard (M4)', () => {
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
      fireEvent.change(screen.getByLabelText('云项目名称'), { target: { value: 'Assembled' } })
      // An invalid remote is rejected locally: no gateway call, rule surfaced.
      fireEvent.change(screen.getByLabelText('Git remote 地址'), { target: { value: 'ftp://nope' } })
      const createButton = screen.getByRole('button', { name: '创建云项目' })
      fireEvent.click(createButton)
      expect(membership.createProject).not.toHaveBeenCalled()
      expect(screen.getByText('remote 必须是 http(s) 代码仓库地址。')).toBeTruthy()

      fireEvent.change(screen.getByLabelText('Git remote 地址'), { target: { value: SAME_REMOTE } })
      fireEvent.click(screen.getByRole('button', { name: '创建云项目' }))
      await tick()
      expect(membership.createProject).toHaveBeenCalledWith({
        name: 'Assembled', remoteUrl: SAME_REMOTE,
      })
      // Binding resolves: the roster read rides the same gateway.
      expect(membership.roster).toHaveBeenCalledWith('project-1')
      expect(screen.getByText('已绑定云项目：Assembled')).toBeTruthy()
      expect(screen.getByText('mona')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the invite wizard: accept, mandatory link with same-remote advice, close returns undecided', async () => {
    const membership = gateway({
      pendingInvitations: vi.fn(async () => [{
        invitationId: 'invitation-1', projectName: 'Assembled', inviterName: 'mona', remoteUrl: SAME_REMOTE,
      }]),
    })
    vi.useFakeTimers()
    try {
      mount(membership)
      // Poll fires immediately: the wizard opens on the invitation card.
      await tick()
      expect(screen.getByText('mona 邀请你加入云项目“Assembled”。')).toBeTruthy()

      // Closing at the card decides nothing: the invitation stays pending.
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      expect(screen.queryByText('mona 邀请你加入云项目“Assembled”。')).toBeNull()
      expect(membership.decideInvitation).not.toHaveBeenCalled()
      expect(membership.pendingInvitations).toHaveBeenCalled()

      // Next poll re-offers the still-pending invitation.
      await tick(15_000)
      fireEvent.click(screen.getByRole('button', { name: '接受' }))

      // Link step: no 暂不关联 — confirm stays disabled until a candidate (or the
      // clone item) is selected, and the same-remote workspace is recommended.
      const confirm = screen.getByRole('button', { name: '关联并加入' }) as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      expect(screen.getByText('同源推荐')).toBeTruthy()
      expect(screen.queryByText('暂不关联')).toBeNull()
      expect(screen.getByText('新建克隆…')).toBeTruthy()

      fireEvent.click(screen.getByRole('radio', { name: /proj/ }))
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '关联并加入' }).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: '关联并加入' }))
      await tick()
      expect(membership.decideInvitation).toHaveBeenCalledWith('invitation-1', {
        decision: 'accept-with-link',
        link: { workspaceName: 'proj', normalizedRemoteUrl: SAME_REMOTE },
      })
      expect(screen.queryByText('关联本地工作区')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('declining from the wizard card routes the decline decision', async () => {
    const membership = gateway({
      pendingInvitations: vi.fn(async () => [{
        invitationId: 'invitation-1', projectName: 'Assembled', inviterName: 'mona',
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
})
