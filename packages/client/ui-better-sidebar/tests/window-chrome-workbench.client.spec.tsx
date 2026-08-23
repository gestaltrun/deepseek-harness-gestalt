// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Workbench, type WorkbenchActions } from '../src/client/split-pane.tsx'
import { makeDefaultState, type SidebarLeaf, type SidebarState } from '../src/client/state.ts'

afterEach(() => {
  cleanup()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

const actions: WorkbenchActions = {
  closeTab: () => {},
  activateTab: () => {},
  focusPane: () => {},
  moveTabToEdge: () => {},
  moveTabBefore: () => {},
  resizeSplit: () => {},
}

function leaf(id: string): SidebarLeaf {
  return { kind: 'leaf', id, tabs: [], active: null }
}

function stateWith(dir: 'row' | 'col'): SidebarState {
  return {
    ...makeDefaultState(),
    splits: {
      kind: 'split',
      id: `split-${dir}`,
      dir,
      sizes: [0.5, 0.5],
      children: [leaf('first'), leaf('second')],
    },
  }
}

function mount(state: SidebarState) {
  return render(
    <Workbench
      state={state}
      windowChrome
      newTabOptions={[]}
      actions={actions}
      onNewTab={() => {}}
      renderTab={() => null}
    />,
  )
}

describe('Workbench Window Chrome', () => {
  it('limits Desktop drag space to panes that touch the top window edge', () => {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { platform: 'darwin' }
    const view = mount(stateWith('col'))
    expect(document.querySelectorAll('[data-workbench-window-drag]')).toHaveLength(1)

    view.rerender(
      <Workbench
        state={stateWith('row')}
        windowChrome
        newTabOptions={[]}
        actions={actions}
        onNewTab={() => {}}
        renderTab={() => null}
      />,
    )
    expect(document.querySelectorAll('[data-workbench-window-drag]')).toHaveLength(2)
  })
})
