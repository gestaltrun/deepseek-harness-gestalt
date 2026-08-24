// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { allLeaves, makeDefaultState, sanitizeState, SidebarStore } from '../src/client/state.ts'
import { Workbench, type WorkbenchActions } from '../src/client/split-pane.tsx'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const actions: WorkbenchActions = {
  closeTab: () => {},
  activateTab: () => {},
  focusPane: () => {},
  moveTabToEdge: () => {},
  moveTabBefore: () => {},
  resizeSplit: () => {},
}

describe('fresh sidebar state', () => {
  it('starts a new Session on the tab-type picker', () => {
    const store = new SidebarStore()

    store.setSession('fresh-session')

    const state = store.getSnapshot().state
    expect(state).toBeDefined()
    expect(allLeaves(state!.splits).flatMap(leaf => leaf.tabs)).toEqual([])
  })

  it('renders enabled tab types in the fresh pane', () => {
    render(
      <Workbench
        state={makeDefaultState()}
        newTabOptions={[
          { id: 'editor', label: '文件' },
          { id: 'sidechat', label: '侧边对话' },
        ]}
        actions={actions}
        onNewTab={() => {}}
        renderTab={() => null}
      />,
    )

    expect(screen.getByRole('button', { name: '文件' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '侧边对话' })).toBeTruthy()
  })

  it('drops only the legacy auto-seeded Files tab from persisted layouts', () => {
    const persisted = makeDefaultState(400, true)
    if (persisted.splits.kind !== 'leaf') throw new Error('expected one default pane')
    persisted.splits.tabs = [
      { id: 'tab:2', type: 'editor', title: 'Files', meta: { treeOpen: false, treeWidth: 320 } },
      { id: 'editor', type: 'editor', title: '文件' },
    ]
    persisted.splits.active = 'editor'

    const sanitized = sanitizeState(persisted)

    expect(sanitized).toBeDefined()
    expect(allLeaves(sanitized!.splits).flatMap(leaf => leaf.tabs)).toEqual([
      { id: 'editor', type: 'editor', title: '文件' },
    ])
  })
})
