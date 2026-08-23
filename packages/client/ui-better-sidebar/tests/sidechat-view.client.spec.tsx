// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SideChatView, sidechatRootThreadIdOf } from '../src/client/SideChatView.tsx'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import { api } from '../src/client/api.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function tab(threadId: string): SidebarTab {
  return {
    id: `sidechat:${threadId}`,
    type: 'sidechat',
    title: 'Side Chat',
    meta: { threadId, provisional: true },
  }
}

describe('SideChatView', () => {
  it('registers an icon and a provisional identity for the new-tab menu entry', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'draft-id' })
    const descriptor = builtinTabs({} as Context).find(candidate => candidate.id === 'sidechat')!
    const created = descriptor.createTab?.({} as never)
    const icon = typeof descriptor.icon === 'function' ? descriptor.icon(16) : descriptor.icon
    const iconView = render(<>{icon}</>)

    expect(typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title).toBe('Side Chat')
    expect(iconView.container.querySelector('svg')).not.toBeNull()
    expect(created?.tab).toMatchObject({
      id: 'sidechat:session-draft-id',
      meta: { threadId: 'session-draft-id', provisional: true },
    })
    expect(sidechatRootThreadIdOf({
      ...created!.tab,
      meta: { threadId: 'nested-child', rootThreadId: 'session-draft-id' },
    })).toBe('session-draft-id')
  })

  it('releases the root Side Chat handle after descendant navigation', () => {
    const descriptor = builtinTabs({} as Context).find(candidate => candidate.id === 'sidechat')!
    const dispose = vi.spyOn(api, 'sidechatDispose').mockResolvedValue({ ok: true })

    descriptor.onClose?.({
      ...tab('nested-child'),
      meta: { threadId: 'nested-child', rootThreadId: 'side-thread' },
    }, { sessionId: 'main-thread' })

    expect(dispose).toHaveBeenCalledWith('side-thread')
  })

  it('mounts the canonical conversation slot for the tab thread without changing the selected Session', () => {
    const snapshot: SidebarSessionList = {
      current: 'main-thread',
      byId: {
        'main-thread': { id: 'main-thread', displayTitle: 'Main', blank: false },
        'side-thread': {
          id: 'side-thread',
          displayTitle: 'Side: question',
          origin: 'subagent',
          parentId: 'main-thread',
          blank: true,
        },
      },
    }
    const unmount = vi.fn()
    const mountSession = vi.fn(() => unmount)
    const open = vi.fn()
    const unstage = vi.fn()
    const stageProvisional = vi.fn(() => unstage)
    const updateTab = vi.fn()
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
        },
        open,
        stageProvisional,
      },
      uiRenderer: { mountSession },
      betterSidebar: { updateTab },
    } as unknown as Context

    const view = render(
      <SideChatView
        ctx={ctx}
        scope={{ sessionId: 'main-thread' }}
        tab={tab('side-thread')}
        visible
      />,
    )

    expect(mountSession).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      'conversation',
      'side-thread',
      { renderMode: 'sidechat', openSession: expect.any(Function) },
    )
    const owner = mountSession.mock.calls[0]?.[3] as {
      openSession?: (sessionId: SessionId) => void
    } | undefined
    owner?.openSession?.('nested-child' as SessionId)
    expect(updateTab).toHaveBeenCalledWith('sidechat:side-thread', {
      meta: { threadId: 'nested-child', rootThreadId: 'side-thread' },
    })
    expect(snapshot.current).toBe('main-thread')
    expect(open).not.toHaveBeenCalled()
    expect(view.queryByRole('button')).toBeNull()
    expect(stageProvisional).toHaveBeenCalledWith({
      sessionId: 'side-thread',
      parentSessionId: 'main-thread',
      origin: 'subagent',
      title: 'Side: New thread',
    })

    view.unmount()
    expect(unmount).toHaveBeenCalledOnce()
    expect(unstage).toHaveBeenCalledOnce()
  })
})
