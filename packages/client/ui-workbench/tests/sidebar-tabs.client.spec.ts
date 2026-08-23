import { describe, expect, it } from 'vitest'
import { collectSidebarBrowserTabs } from '../src/sidebar-tabs.ts'

describe('collectSidebarBrowserTabs', () => {
  it('returns no tabs before a session is active', () => {
    expect(collectSidebarBrowserTabs(undefined)).toEqual([])
  })

  it('walks both workbench trees and keeps only browser tabs', () => {
    expect(collectSidebarBrowserTabs({
      panelOpen: true,
      splits: {
        kind: 'split',
        children: [
          { kind: 'leaf', tabs: [{ id: 'editor:1', type: 'editor' }, { id: 'browser:1', type: 'browser', meta: { official: { tabId: 't' } } }] },
          { kind: 'leaf', tabs: [{ id: 'git:1', type: 'git' }] },
        ],
      },
      bottomSplits: {
        kind: 'leaf',
        tabs: [{ id: 'browser:2', type: 'browser' }],
      },
    })).toEqual([
      { id: 'browser:1', meta: { official: { tabId: 't' } } },
      { id: 'browser:2' },
    ])
  })
})
