/** Product patch that enables the snapshot browser tab for official chrome. */
import { describe, expect, it } from 'vitest'
import {
  SNAPSHOT_BROWSER_TAB_ID,
  SNAPSHOT_PREFS_NS,
  snapshotBrowserProductPatch,
} from '../src/snapshot-browser.ts'

describe('snapshotBrowserProductPatch', () => {
  it('names the snapshot prefs namespace and browser tab id', () => {
    expect(SNAPSHOT_PREFS_NS).toBe('dsh-better-sidebar')
    expect(SNAPSHOT_BROWSER_TAB_ID).toBe('browser')
  })

  it('writes an explicit true so a leftover false cannot keep the tab hidden', () => {
    expect(snapshotBrowserProductPatch({
      tabsEnabled: { browser: false },
      browserInterceptLinks: true,
    })).toEqual({
      tabsEnabled: { browser: true },
      browserInterceptLinks: false,
    })
  })

  it('keeps other tab switches when forcing the browser tab on', () => {
    expect(snapshotBrowserProductPatch({
      tabsEnabled: { editor: true, browser: false },
      browserInterceptLinks: true,
    })).toEqual({
      tabsEnabled: { editor: true, browser: true },
      browserInterceptLinks: false,
    })
  })

  it('skips a write when the product state is already stored', () => {
    expect(snapshotBrowserProductPatch({
      tabsEnabled: { git: true },
      browserInterceptLinks: false,
    })).toBeUndefined()
    expect(snapshotBrowserProductPatch({
      tabsEnabled: { browser: true, git: true },
      browserInterceptLinks: false,
    })).toBeUndefined()
  })
})
