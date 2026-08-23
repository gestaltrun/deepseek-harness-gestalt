import { describe, expect, it } from 'vitest'
import type {
  BrowserPageState,
  BrowserScreenshot,
  BrowserTarget,
  BrowserWorkspaceProjection,
} from '@deepseek-ai/dsh-browser-workspace/client'
import {
  browserAddressHost,
  resolveBrowserAddress,
  browserTabTitle,
  hasBrowserTabs,
  openPageOf,
  pageScreenshotSrc,
  persistentProfileLabel,
  screenshotDataUrl,
  selectBrowserPreview,
  stackedBrowserTabs,
} from '../src/client/model.ts'

const TARGET: BrowserTarget = {
  profileId: 'profile-1' as BrowserTarget['profileId'],
  workspaceId: 'ws-1' as BrowserTarget['workspaceId'],
  browserId: 'br-1' as BrowserTarget['browserId'],
  tabId: 'tab-1' as BrowserTarget['tabId'],
}

const STORAGE = {
  cookies: 'cookies',
  localStorage: 'local',
  indexedDb: 'idb',
  cache: 'cache',
  serviceWorker: 'sw',
}

function page(overrides: Partial<BrowserPageState> = {}): BrowserPageState {
  return {
    status: 'open',
    target: TARGET,
    revision: 2,
    url: 'https://alpha.test/path',
    title: ' Alpha ',
    text: 'page text',
    focused: true,
    chrome: { kind: 'temporary', partition: 'tmp' },
    storage: STORAGE,
    ...overrides,
  }
}

function snapshot(overrides: Partial<BrowserWorkspaceProjection> = {}): BrowserWorkspaceProjection {
  return {
    activeWorkspaceId: TARGET.workspaceId,
    workspaces: [{
      workspaceId: TARGET.workspaceId,
      profileId: TARGET.profileId,
      activeBrowserId: TARGET.browserId,
      browsers: [{
        browserId: TARGET.browserId,
        activeTabId: TARGET.tabId,
        tabs: [
          { tabId: 'tab-0' as BrowserTarget['tabId'], revision: 1 },
          { tabId: TARGET.tabId, revision: 2 },
        ],
      }],
    }],
    ...overrides,
  }
}

describe('Browser preview helpers', () => {
  it('requires at least one Workspace before occupancy', () => {
    expect(hasBrowserTabs(undefined)).toBe(false)
    expect(hasBrowserTabs(null)).toBe(false)
    expect(hasBrowserTabs(snapshot({ workspaces: [] }))).toBe(false)
    expect(hasBrowserTabs(snapshot())).toBe(true)
  })

  it('selects the named Workspace, instance, and active tab, falling back to the last of each', () => {
    const named = selectBrowserPreview(snapshot())
    expect(named?.activeTab?.target).toEqual(TARGET)
    expect(named?.tabs.map(tab => tab.revision)).toEqual([1, 2])
    expect(named?.tabs.map(tab => tab.active)).toEqual([false, true])

    const unnamed = selectBrowserPreview(snapshot({
      activeWorkspaceId: null,
      workspaces: [{
        workspaceId: TARGET.workspaceId,
        profileId: TARGET.profileId,
        activeBrowserId: null,
        browsers: [{
          browserId: TARGET.browserId,
          activeTabId: null,
          tabs: [{ tabId: TARGET.tabId, revision: 2 }],
        }],
      }],
    }))
    expect(unnamed?.activeTab?.target.tabId).toBe(TARGET.tabId)
    expect(selectBrowserPreview(undefined)).toBeUndefined()
    expect(selectBrowserPreview(snapshot({ workspaces: [] }))).toBeUndefined()
    expect(selectBrowserPreview(snapshot({
      workspaces: [{
        workspaceId: TARGET.workspaceId,
        profileId: TARGET.profileId,
        activeBrowserId: null,
        browsers: [],
      }],
    }))).toBeUndefined()
  })

  it('stacks inactive tabs behind the current tab', () => {
    const tabs = selectBrowserPreview(snapshot())!.tabs
    expect(stackedBrowserTabs(tabs).map(tab => tab.active)).toEqual([false, true])
    expect(stackedBrowserTabs([])).toEqual([])
  })

  it('shows host, title, persistent Profile, and screenshot data URL', () => {
    expect(browserAddressHost('https://alpha.test/path')).toBe('alpha.test')
    expect(browserAddressHost('not a url')).toBe('not a url')
    expect(browserAddressHost('about:blank')).toBe('about:blank')
    expect(resolveBrowserAddress('')).toBeUndefined()
    expect(resolveBrowserAddress('example.com')).toBe('https://example.com/')
    expect(resolveBrowserAddress('https://alpha.test/path')).toBe('https://alpha.test/path')
    expect(resolveBrowserAddress('about:blank')).toBe('about:blank')
    expect(resolveBrowserAddress('javascript:alert(1)')).toBeUndefined()
    expect(resolveBrowserAddress('https://[')).toBeUndefined()
    expect(browserTabTitle(page(), 'Untitled')).toBe('Alpha')
    expect(browserTabTitle(page({ title: '   ' }), 'Untitled')).toBe('alpha.test')
    expect(browserTabTitle(undefined, 'Untitled')).toBe('Untitled')
    expect(persistentProfileLabel(page(), 'Shared identity')).toBeUndefined()
    expect(persistentProfileLabel(page({
      chrome: { kind: 'persistent', name: 'work' as never, partition: 'persist:work' },
    }), 'Shared identity')).toBe('work')
    expect(persistentProfileLabel(page({
      chrome: { kind: 'shared', name: 'shared' as never, partition: 'persist:shared' },
    }), 'Shared identity')).toBe('Shared identity')
    const shot: BrowserScreenshot = {
      target: TARGET,
      revision: 2,
      url: 'https://alpha.test/',
      title: 'Alpha',
      mediaType: 'image/png',
      data: 'abc',
    }
    expect(screenshotDataUrl(shot)).toBe('data:image/png;base64,abc')
    expect(screenshotDataUrl(undefined)).toBeUndefined()
    expect(pageScreenshotSrc(shot)).toBe('data:image/png;base64,abc')
    expect(pageScreenshotSrc({ ...shot, url: 'about:blank' })).toBeUndefined()
    expect(pageScreenshotSrc(undefined)).toBeUndefined()
    expect(openPageOf(page())).toEqual(page())
    expect(openPageOf({ status: 'closed', target: TARGET, revision: 2 })).toBeUndefined()
  })

})
