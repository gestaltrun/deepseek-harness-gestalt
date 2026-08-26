// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSessionSummary } from '../src/context-types.ts'
import {
  allLeaves, closeFloatByTab, closeTab, makeDefaultState, reconcileSideThreads, sanitizeState,
  SidebarStore, tombstoneSideThread, type SidebarState, type SidebarTab,
} from '../src/client/state.ts'
import { restorableSideThreads } from '../src/client/subagent-detect.ts'

afterEach(() => {
  localStorage.clear()
  vi.useRealTimers()
  window.history.replaceState(null, '', window.location.pathname)
})

function summary(id: string, overrides: Partial<SidebarSessionSummary> = {}): SidebarSessionSummary {
  return { id, displayTitle: id, running: false, blank: false, ...overrides }
}

function sideThread(id: string, parentId = 'parent', title = `Side: ${id}`): SidebarSessionSummary {
  return summary(id, { origin: 'subagent', parentId, displayTitle: title })
}

function sidechatTab(threadId: string, meta?: Record<string, unknown>): SidebarTab {
  return { id: `sidechat:${threadId}`, type: 'sidechat', title: threadId, meta: meta ?? { threadId } }
}

/** One default state whose single pane carries the given tabs (active = first). */
function stateWithTabs(...tabs: SidebarTab[]): SidebarState {
  const state = makeDefaultState()
  if (state.splits.kind !== 'leaf') throw new Error('expected one default pane')
  state.splits.tabs = [...tabs]
  state.splits.active = tabs[0]?.id ?? null
  return state
}

function dockedTabs(state: SidebarState): SidebarTab[] {
  return allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(leaf => leaf.tabs)
}

describe('restorableSideThreads', () => {
  it('collects a published direct side child with the label prefix stripped', () => {
    const threads = restorableSideThreads(
      { parent: summary('parent'), child: sideThread('child', 'parent', 'Side: 要不要拆分支？') },
      'parent',
    )
    expect(threads).toEqual([{ threadId: 'child', title: '要不要拆分支？' }])
  })

  it('excludes ordinary subagents, other sessions, blank placeholders, and provisional rows', () => {
    const byId = {
      parent: summary('parent'),
      plain: summary('plain', { origin: 'subagent', parentId: 'parent', displayTitle: '调研报告' }),
      foreign: sideThread('foreign', 'other-session'),
      blank: sideThread('blank', 'parent', 'Side: New thread', ),
      provisional: summary('provisional', {
        origin: 'subagent', parentId: 'parent', provisional: true, displayTitle: 'Side: New thread',
      }),
    }
    byId.blank.blank = true

    expect(restorableSideThreads(byId, 'parent')).toEqual([])
  })
})

describe('reconcileSideThreads', () => {
  it('restores a missing thread as a non-provisional sidechat tab and activates an empty pane', () => {
    const next = reconcileSideThreads(makeDefaultState(), [{ threadId: 't1', title: '问题一' }])

    expect(dockedTabs(next)).toEqual([{
      id: 'sidechat:t1', type: 'sidechat', title: '问题一', meta: { threadId: 't1' },
    }])
    if (next.splits.kind !== 'leaf') throw new Error('expected one default pane')
    expect(next.splits.active).toBe('sidechat:t1')
  })

  it('reopens a collapsed panel so the restore is visible, except in the narrow drawer', () => {
    const collapsed = { ...makeDefaultState(), panelOpen: false }

    const restored = reconcileSideThreads(collapsed, [{ threadId: 't1', title: '问题一' }])
    expect(restored.panelOpen).toBe(true)

    const original = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 })
    try {
      expect(reconcileSideThreads(collapsed, [{ threadId: 't1', title: '问题一' }]).panelOpen).toBe(false)
    } finally {
      if (original !== undefined) Object.defineProperty(window, 'innerWidth', original)
    }
  })

  it('appends without stealing the active tab when the pane already has one', () => {
    const state = stateWithTabs({ id: 'editor', type: 'editor', title: '文件' })

    const next = reconcileSideThreads(state, [{ threadId: 't1', title: '问题一' }])

    expect(dockedTabs(next).map(tab => tab.id)).toEqual(['editor', 'sidechat:t1'])
    if (next.splits.kind !== 'leaf') throw new Error('expected one default pane')
    expect(next.splits.active).toBe('editor')
  })

  it('is a same-reference no-op once every thread has a tab', () => {
    const state = stateWithTabs(sidechatTab('t1'))

    expect(reconcileSideThreads(state, [{ threadId: 't1', title: '问题一' }])).toBe(state)
  })

  it('treats a tab navigated into a nested thread as covering its root thread', () => {
    const state = stateWithTabs()
    state.floats = [{
      id: 'float:1', tab: sidechatTab('nested', { threadId: 'nested', rootThreadId: 't1' }),
      x: 0, y: 0, w: 320, h: 240,
    }]

    expect(reconcileSideThreads(state, [{ threadId: 't1', title: '问题一' }])).toBe(state)
  })

  it('never resurrects a tombstoned thread', () => {
    const state = { ...makeDefaultState(), closedSideThreads: ['t1'] }

    expect(reconcileSideThreads(state, [{ threadId: 't1', title: '问题一' }])).toBe(state)
  })

  it('restores into the first pane when the recorded active pane is gone', () => {
    const state = { ...makeDefaultState(), activePane: 'pane:stale' }

    const next = reconcileSideThreads(state, [{ threadId: 't1', title: '问题一' }])

    expect(dockedTabs(next).map(tab => tab.id)).toEqual(['sidechat:t1'])
  })

  it('restores several threads in list order', () => {
    const next = reconcileSideThreads(makeDefaultState(), [
      { threadId: 't1', title: '一' }, { threadId: 't2', title: '二' },
    ])

    expect(dockedTabs(next).map(tab => tab.id)).toEqual(['sidechat:t1', 'sidechat:t2'])
  })
})

describe('Side Chat close tombstones', () => {
  it('closeTab tombstones the root thread so reconcile skips it afterwards', () => {
    const state = stateWithTabs(sidechatTab('t1'))
    if (state.splits.kind !== 'leaf') throw new Error('expected one default pane')

    const closed = closeTab(state, state.splits.id, 'sidechat:t1')

    expect(closed.closedSideThreads).toEqual(['t1'])
    expect(reconcileSideThreads(closed, [{ threadId: 't1', title: '问题一' }])).toBe(closed)
  })

  it('closeTab leaves other tab types and meta-less sidechat tabs untombstoned', () => {
    const withEditor = stateWithTabs({ id: 'editor', type: 'editor', title: '文件' })
    if (withEditor.splits.kind !== 'leaf') throw new Error('expected one default pane')
    expect(closeTab(withEditor, withEditor.splits.id, 'editor').closedSideThreads).toEqual([])

    const withMetaLess = stateWithTabs(sidechatTab('t1', {}))
    if (withMetaLess.splits.kind !== 'leaf') throw new Error('expected one default pane')
    expect(closeTab(withMetaLess, withMetaLess.splits.id, 'sidechat:t1').closedSideThreads).toEqual([])
  })

  it('tombstones a thread only once across duplicate tabs', () => {
    const state = stateWithTabs(sidechatTab('t1'), sidechatTab('t1-copy', { threadId: 't1' }))
    if (state.splits.kind !== 'leaf') throw new Error('expected one default pane')
    const first = closeTab(state, state.splits.id, 'sidechat:t1')
    const second = closeTab(first, state.splits.id, 'sidechat:t1-copy')

    expect(second.closedSideThreads).toEqual(['t1'])
  })

  it('closeFloatByTab tombstones a floated sidechat tab and stays a no-op for unknown ids', () => {
    const state = stateWithTabs()
    state.floats = [{ id: 'float:1', tab: sidechatTab('t1'), x: 0, y: 0, w: 320, h: 240 }]

    const closed = closeFloatByTab(state, 'sidechat:t1')

    expect(closed.floats).toEqual([])
    expect(closed.closedSideThreads).toEqual(['t1'])
    expect(closeFloatByTab(state, 'sidechat:missing')).toBe(state)
  })

  it('tombstoneSideThread is idempotent and ignores non-sidechat tabs', () => {
    const state = { ...makeDefaultState(), closedSideThreads: ['t1'] }

    expect(tombstoneSideThread(state, sidechatTab('t1'))).toBe(state)
    expect(tombstoneSideThread(state, { id: 'editor', type: 'editor', title: '文件' })).toBe(state)
  })
})

describe('sanitizeState closedSideThreads', () => {
  it('round-trips the tombstone list', () => {
    const persisted = JSON.parse(JSON.stringify({
      ...makeDefaultState(), closedSideThreads: ['t1', 't2'],
    })) as unknown

    expect(sanitizeState(persisted)?.closedSideThreads).toEqual(['t1', 't2'])
  })

  it('defaults older states to no tombstones and drops malformed entries', () => {
    const persisted = JSON.parse(JSON.stringify(makeDefaultState())) as Record<string, unknown>
    delete persisted.closedSideThreads
    expect(sanitizeState(persisted)?.closedSideThreads).toEqual([])

    const malformed = JSON.parse(JSON.stringify({
      ...makeDefaultState(), closedSideThreads: ['t1', 7, null],
    })) as unknown
    expect(sanitizeState(malformed)?.closedSideThreads).toEqual(['t1'])
  })
})

describe('SidebarStore.restoreSideThreads', () => {
  it('restores tabs for a fresh session and persists them for the next load', () => {
    vi.useFakeTimers()
    const store = new SidebarStore()
    store.setSession('session-a')

    store.restoreSideThreads([{ threadId: 't1', title: '问题一' }])

    const tabs = dockedTabs(store.getSnapshot().state!)
    expect(tabs.map(tab => tab.id)).toEqual(['sidechat:t1'])

    vi.advanceTimersByTime(250)
    const reloaded = new SidebarStore()
    reloaded.setSession('session-a')
    expect(dockedTabs(reloaded.getSnapshot().state!).map(tab => tab.id)).toEqual(['sidechat:t1'])
  })

  it('does not restore under the ?dsh-sidebar-reset escape hatch', () => {
    window.history.replaceState(null, '', '?dsh-sidebar-reset')
    const store = new SidebarStore()
    store.setSession('session-a')

    store.restoreSideThreads([{ threadId: 't1', title: '问题一' }])

    expect(dockedTabs(store.getSnapshot().state!)).toEqual([])
  })

  it('keeps a user-closed thread closed across a later reconcile', () => {
    const store = new SidebarStore()
    store.setSession('session-a')
    store.restoreSideThreads([{ threadId: 't1', title: '问题一' }])

    store.reduce((state) => {
      if (state.splits.kind !== 'leaf') throw new Error('expected one default pane')
      return closeTab(state, state.splits.id, 'sidechat:t1')
    })
    store.restoreSideThreads([{ threadId: 't1', title: '问题一' }])

    expect(dockedTabs(store.getSnapshot().state!)).toEqual([])
    expect(store.getSnapshot().state!.closedSideThreads).toEqual(['t1'])
  })
})
