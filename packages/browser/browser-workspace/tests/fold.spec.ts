import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { BrowserInstanceId, BrowserProfileId, BrowserTabId, BrowserWorkspaceId } from '@deepseek-ai/dsh-browser-runtime'
import { applyBrowserWorkspaceProjection, EMPTY_BROWSER_WORKSPACE, foldBrowserWorkspace } from '../src/fold.ts'
import type { BrowserWorkspaceProjection } from '../src/client.ts'

const SNAPSHOT: BrowserWorkspaceProjection = {
  activeWorkspaceId: BrowserWorkspaceId('ws-1'),
  workspaces: [{
    workspaceId: BrowserWorkspaceId('ws-1'),
    profileId: BrowserProfileId('profile-1'),
    activeBrowserId: BrowserInstanceId('browser-1'),
    browsers: [{
      browserId: BrowserInstanceId('browser-1'),
      activeTabId: BrowserTabId('tab-1'),
      tabs: [{ tabId: BrowserTabId('tab-1'), revision: 0 }],
    }],
  }],
}

describe('Browser Workspace fold', () => {
  it('returns the empty Workspace before any snapshot and last-wins after', () => {
    const session = Session.create(SessionId('fold-session'))
    expect(foldBrowserWorkspace(session.events)).toBe(EMPTY_BROWSER_WORKSPACE)
    session.append('browser/workspace', SNAPSHOT)
    expect(foldBrowserWorkspace(session.events)).toEqual(SNAPSHOT)
    const later = { ...SNAPSHOT, activeWorkspaceId: null }
    session.append('browser/workspace', later)
    expect(foldBrowserWorkspace(session.events)).toEqual(later)
    expect(foldBrowserWorkspace(session.events, 0)).toBe(EMPTY_BROWSER_WORKSPACE)
  })

  it('keeps the same projection reference for unrelated events', () => {
    const next = applyBrowserWorkspaceProjection(EMPTY_BROWSER_WORKSPACE, {
      type: 'turn/start',
      seq: 0,
      time: 0,
      data: { turn: 1 },
    })
    expect(next).toBe(EMPTY_BROWSER_WORKSPACE)
  })
})
