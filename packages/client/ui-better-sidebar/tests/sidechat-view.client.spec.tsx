// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SideChatView } from '../src/client/SideChatView.tsx'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

afterEach(cleanup)

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
      betterSidebar: { updateTab: vi.fn() },
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
      { renderMode: 'sidechat' },
    )
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
