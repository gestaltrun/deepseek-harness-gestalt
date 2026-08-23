// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SideChatView } from '../src/client/SideChatView.tsx'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

afterEach(cleanup)

function tab(threadId: string): SidebarTab {
  return {
    id: `sidechat:${threadId}`,
    type: 'sidechat',
    title: 'Side Chat',
    meta: { threadId },
  }
}

describe('SideChatView', () => {
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
          blank: false,
        },
      },
    }
    const unmount = vi.fn()
    const mountSession = vi.fn(() => unmount)
    const open = vi.fn()
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
        },
        open,
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

    view.unmount()
    expect(unmount).toHaveBeenCalledOnce()
  })
})
