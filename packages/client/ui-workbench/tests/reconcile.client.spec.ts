import { describe, expect, it } from 'vitest'
import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'
import { officialTabMeta } from '../src/official-tab-meta.ts'
import { planOfficialPageReconcile } from '../src/reconcile.ts'

const A: BrowserTarget = {
  profileId: 'p' as BrowserTarget['profileId'],
  workspaceId: 'w' as BrowserTarget['workspaceId'],
  browserId: 'b' as BrowserTarget['browserId'],
  tabId: 'a' as BrowserTarget['tabId'],
}
const B: BrowserTarget = { ...A, tabId: 'b' as BrowserTarget['tabId'] }

describe('planOfficialPageReconcile', () => {
  it('attaches unmatched official pages to empty sidebar tabs', () => {
    const planned = planOfficialPageReconcile(
      [{ target: A, revision: 1 }, { target: B, revision: 2 }],
      [{ id: 'browser:1' }],
      new Map(),
    )
    expect(planned.actions).toEqual([
      { kind: 'attach', tabId: 'browser:1', target: A },
      { kind: 'openSidebar' },
    ])
    expect(planned.known.get('browser:1')).toBe('p/w/b/a')
  })

  it('creates an official page for a leftover empty sidebar tab', () => {
    const planned = planOfficialPageReconcile(
      [],
      [{ id: 'browser:1' }],
      new Map(),
    )
    expect(planned.actions).toEqual([{ kind: 'createOfficial', tabId: 'browser:1' }])
  })

  it('closes the official page when a known sidebar tab disappears', () => {
    const planned = planOfficialPageReconcile(
      [{ target: A, revision: 1 }],
      [],
      new Map([['browser:1', 'p/w/b/a']]),
    )
    expect(planned.actions).toEqual([{ kind: 'closeOfficial', target: A, revision: 1 }])
    expect(planned.known.size).toBe(0)
  })

  it('closes a leftover sidebar tab when the official page vanishes', () => {
    const planned = planOfficialPageReconcile(
      [],
      [{ id: 'browser:1', meta: officialTabMeta(A) }],
      new Map([['browser:1', 'p/w/b/a']]),
    )
    expect(planned.actions).toEqual([{ kind: 'closeSidebar', tabId: 'browser:1' }])
    expect(planned.known.size).toBe(0)
  })

  it('drops a known binding when both the sidebar tab and official page are gone', () => {
    const planned = planOfficialPageReconcile([], [], new Map([['browser:1', 'p/w/b/a']]))
    expect(planned.actions).toEqual([])
    expect(planned.known.size).toBe(0)
  })

  it('keeps an already bound pair without actions', () => {
    const planned = planOfficialPageReconcile(
      [{ target: A, revision: 1 }],
      [{ id: 'browser:1', meta: officialTabMeta(A) }],
      new Map([['browser:1', 'p/w/b/a']]),
    )
    expect(planned.actions).toEqual([])
    expect(planned.known.get('browser:1')).toBe('p/w/b/a')
  })
})
