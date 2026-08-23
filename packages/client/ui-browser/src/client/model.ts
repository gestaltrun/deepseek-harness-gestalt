/**
 * Pure Browser preview helpers over one Session Workspace snapshot.
 * @module @deepseek-ai/dsh-client-ui-browser/client/model
 */

import type {
  BrowserPageState,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTarget,
  BrowserWorkspaceInstanceRecord,
  BrowserWorkspaceProjection,
  BrowserWorkspaceRecord,
} from '@deepseek-ai/dsh-browser-workspace/client'

/** One tab the collapsed preview can address. */
export interface BrowserPreviewTab {
  readonly target: BrowserTarget
  readonly revision: number
  readonly active: boolean
}

/** Active Workspace and instance plus every tab the preview can show. */
export interface BrowserPreviewSelection {
  readonly workspace: BrowserWorkspaceRecord
  readonly instance: BrowserWorkspaceInstanceRecord
  readonly tabs: readonly BrowserPreviewTab[]
  readonly activeTab: BrowserPreviewTab | undefined
}

/**
 * True when this Session owns at least one Browser Workspace tab.
 * @param snapshot - Session-owned Workspace projection, or undefined while loading.
 * @returns whether the collapsed preview has anything to show.
 */
export function hasBrowserTabs(snapshot: BrowserWorkspaceProjection | null | undefined): boolean {
  return (snapshot?.workspaces.length ?? 0) > 0
}

/**
 * Resolve the Session's active Workspace, instance, and tab stack.
 * @param snapshot - Session-owned Workspace projection.
 * @returns the active selection, or undefined when no tab exists.
 */
export function selectBrowserPreview(snapshot: BrowserWorkspaceProjection | null | undefined): BrowserPreviewSelection | undefined {
  if (snapshot === undefined || snapshot === null) return undefined
  const workspace = namedOrLast(snapshot.workspaces, snapshot.activeWorkspaceId, item => item.workspaceId)
  if (workspace === undefined) return undefined
  const instance = namedOrLast(workspace.browsers, workspace.activeBrowserId, item => item.browserId)
  if (instance === undefined) return undefined
  const tabs = instance.tabs.map(tab => ({
    target: {
      profileId: workspace.profileId,
      workspaceId: workspace.workspaceId,
      browserId: instance.browserId,
      tabId: tab.tabId,
    } satisfies BrowserTarget,
    revision: tab.revision,
    active: tab.tabId === instance.activeTabId,
  }))
  return {
    workspace,
    instance,
    tabs,
    activeTab: tabs.find(tab => tab.active) ?? tabs.at(-1),
  }
}

/**
 * Stack order for collapsed layers: inactive tabs first, current tab last.
 * @param tabs - Tabs of the active instance.
 * @returns back-to-front layers so the current tab is clickable on top.
 */
export function stackedBrowserTabs(tabs: readonly BrowserPreviewTab[]): readonly BrowserPreviewTab[] {
  const active = tabs.find(tab => tab.active)
  if (active === undefined) return tabs
  return [...tabs.filter(tab => !tab.active), active]
}

/**
 * Host name shown on tab chips and preview captions, or the raw URL when parsing fails.
 * @param url - Committed page URL.
 * @returns display host or the original URL.
 */
export function browserAddressHost(url: string): string {
  try {
    const host = new URL(url).host
    return host === '' ? url : host
  } catch {
    return url
  }
}

/**
 * Turn an address-bar draft into a Runtime navigate URL.
 * A string without a scheme receives `https://`. Only `http:`, `https:`, and
 * `about:` are accepted.
 * @param draft - Raw address-bar text.
 * @returns an absolute URL, or undefined when the draft is empty or not a page URL.
 */
export function resolveBrowserAddress(draft: string): string | undefined {
  const trimmed = draft.trim()
  if (trimmed.length === 0) return undefined
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'about:') return undefined
    return url.href
  } catch {
    return undefined
  }
}

/**
 * Title shown on a tab chip or collapsed layer.
 * @param page - Observed open page, or undefined while loading.
 * @param untitled - Localized untitled fallback.
 * @returns page title, host, or untitled.
 */
export function browserTabTitle(page: BrowserPageState | undefined, untitled: string): string {
  const title = page?.title.trim()
  if (title !== undefined && title !== '') return title
  if (page !== undefined) return browserAddressHost(page.url)
  return untitled
}

/**
 * Address-field Profile label, if any.
 * @param page - Observed open page.
 * @param sharedLabel - Chrome copy for the shared Profile.
 * @returns the named persistent Profile, the shared-identity label, or undefined for a temporary Profile.
 */
export function persistentProfileLabel(
  page: BrowserPageState | undefined,
  sharedLabel: string,
): string | undefined {
  if (page?.chrome.kind === 'shared') return sharedLabel
  return page?.chrome.kind === 'persistent' ? page.chrome.name : undefined
}

/**
 * PNG data URL for one captured screenshot.
 * @param screenshot - Captured page image.
 * @returns a browser-displayable data URL.
 */
export function screenshotDataUrl(screenshot: BrowserScreenshot | undefined): string | undefined {
  if (screenshot === undefined) return undefined
  return `data:${screenshot.mediaType};base64,${screenshot.data}`
}

/**
 * Screenshot src for chrome and preview. `about:blank` captures stay hidden.
 * @param screenshot - Captured page image.
 * @returns a data URL, or undefined when there is no paintable capture.
 */
export function pageScreenshotSrc(screenshot: BrowserScreenshot | undefined): string | undefined {
  if (screenshot === undefined || screenshot.url === 'about:blank') return undefined
  return screenshotDataUrl(screenshot)
}

/**
 * Open-page facts from one observe result.
 * @param state - Observe result.
 * @returns the open page, or undefined when the tab is closed or unavailable.
 */
export function openPageOf(state: BrowserRuntimeState | undefined): BrowserPageState | undefined {
  return state?.status === 'open' ? state : undefined
}

function namedOrLast<T>(
  items: readonly T[],
  id: string | null,
  keyOf: (item: T) => string,
): T | undefined {
  if (id !== null) {
    const named = items.find(item => keyOf(item) === id)
    if (named !== undefined) return named
  }
  return items.at(-1)
}
