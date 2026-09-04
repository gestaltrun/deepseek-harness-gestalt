// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createBetterSidebarService } from '../src/client/service.ts'
import {
  allLeaves, closeTab, firstLeaf, makeDefaultState, SidebarStore, type SidebarState,
} from '../src/client/state.ts'

function hasTab(state: SidebarState, tree: 'splits' | 'bottomSplits', id: string): boolean {
  return allLeaves(state[tree]).some(leaf => leaf.tabs.some(tab => tab.id === id))
}

function storeWithBottomActive(): { store: SidebarStore; rightId: string; bottomId: string } {
  const store = new SidebarStore()
  store.setSession('session-a')
  const current = store.getSnapshot().state ?? makeDefaultState()
  const rightId = firstLeaf(current.splits).id
  const bottomId = firstLeaf(current.bottomSplits).id
  store.reduce(state => ({ ...state, activePane: firstLeaf(state.bottomSplits).id, bottomOpen: true }))
  return { store, rightId, bottomId }
}

describe('openTab landing pane', () => {
  it('opens a pathed editor in the right workbench when the bottom pane is active', () => {
    const { store, rightId } = storeWithBottomActive()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    service.openTab({ type: 'editor', title: 'a.txt', path: '/tmp/a.txt', id: 'editor:/tmp/a.txt' })
    const state = store.getSnapshot().state!
    expect(hasTab(state, 'splits', 'editor:/tmp/a.txt')).toBe(true)
    expect(hasTab(state, 'bottomSplits', 'editor:/tmp/a.txt')).toBe(false)
    expect(state.activePane).toBe(rightId)
  })

  it('opens a URL browser tab in the right workbench when the bottom pane is active', () => {
    const { store, rightId } = storeWithBottomActive()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'browser',
      title: 'Browser',
      createTab: state => ({
        tab: { id: `browser:${state.nextBrowser}`, type: 'browser', title: 'Browser' },
        patch: { nextBrowser: state.nextBrowser + 1 },
      }),
      component: () => null,
    })
    service.openTab({ type: 'browser', url: 'https://example.com' })
    const state = store.getSnapshot().state!
    const browsers = allLeaves(state.splits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'browser')
    expect(browsers).toHaveLength(1)
    expect(browsers[0]?.path).toBe('https://example.com')
    expect(allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs).some(tab => tab.type === 'browser')).toBe(false)
    expect(state.activePane).toBe(rightId)
  })

  it('keeps a type-only tab in the last-touched bottom pane', () => {
    const { store, bottomId } = storeWithBottomActive()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'terminal',
      title: 'Terminal',
      createTab: () => ({ tab: { id: 'terminal:1', type: 'terminal', title: 'Terminal' } }),
      component: () => null,
    })
    service.openTab({ type: 'terminal' })
    const state = store.getSnapshot().state!
    expect(hasTab(state, 'bottomSplits', 'terminal:1')).toBe(true)
    expect(hasTab(state, 'splits', 'terminal:1')).toBe(false)
    expect(state.activePane).toBe(bottomId)
  })
})

describe('closeTab collapses an empty workbench', () => {
  it('closes the right panel after its last docked tab is closed', () => {
    const state = makeDefaultState()
    if (state.splits.kind !== 'leaf') throw new Error('expected one default pane')
    const paneId = state.splits.id
    const withTab = {
      ...state,
      splits: { ...state.splits, tabs: [{ id: 'editor:a', type: 'editor', title: 'a', path: '/a' }], active: 'editor:a' },
    }
    const closed = closeTab(withTab, paneId, 'editor:a')
    expect(allLeaves(closed.splits).flatMap(leaf => leaf.tabs)).toEqual([])
    expect(closed.panelOpen).toBe(false)
    expect(closed.bottomOpen).toBe(false)
  })

  it('closes the bottom panel after its last docked tab is closed', () => {
    const state = makeDefaultState()
    if (state.bottomSplits.kind !== 'leaf') throw new Error('expected one default pane')
    const paneId = state.bottomSplits.id
    const withTab = {
      ...state,
      bottomOpen: true,
      bottomSplits: {
        ...state.bottomSplits,
        tabs: [{ id: 'terminal:1', type: 'terminal', title: 'Terminal' }],
        active: 'terminal:1',
      },
    }
    const closed = closeTab(withTab, paneId, 'terminal:1')
    expect(allLeaves(closed.bottomSplits).flatMap(leaf => leaf.tabs)).toEqual([])
    expect(closed.bottomOpen).toBe(false)
    expect(closed.panelOpen).toBe(true)
  })

  it('keeps the right panel open when another docked tab remains', () => {
    const state = makeDefaultState()
    if (state.splits.kind !== 'leaf') throw new Error('expected one default pane')
    const paneId = state.splits.id
    const withTabs = {
      ...state,
      splits: {
        ...state.splits,
        tabs: [
          { id: 'editor:a', type: 'editor', title: 'a', path: '/a' },
          { id: 'editor:b', type: 'editor', title: 'b', path: '/b' },
        ],
        active: 'editor:a',
      },
    }
    const closed = closeTab(withTabs, paneId, 'editor:a')
    expect(closed.panelOpen).toBe(true)
    expect(allLeaves(closed.splits).flatMap(leaf => leaf.tabs).map(tab => tab.id)).toEqual(['editor:b'])
  })
})
