/**
 * Product patch that keeps the snapshot browser tab on and routes GUI link
 * clicks into official pages. An absent `tabsEnabled.browser` key means
 * enabled; a leftover `false` from an earlier mount must be written `true`.
 * Interception targets official chrome — the iframe embed restrictions that
 * kept https links in the system browser do not apply to a Runtime page.
 */

/** Settings namespace registered by the better-sidebar snapshot host. */
export const SNAPSHOT_PREFS_NS = 'dsh-better-sidebar'

/** Built-in snapshot tab id for the official Browser page chrome. */
export const SNAPSHOT_BROWSER_TAB_ID = 'browser'

/** Fields the adapter writes on the snapshot prefs namespace. */
export interface SnapshotBrowserProductPatch {
  /** Per-tab enable map with the official browser tab forced on. */
  tabsEnabled: Record<string, boolean>
  /** Master switch for snapshot link takeover into an official page. */
  browserInterceptLinks: true
  /** https links open an official page too (no iframe embed limit). */
  browserInterceptHttps: true
}

/** Current snapshot prefs fields the product patch reads. */
export interface SnapshotBrowserPrefs {
  /** Per-tab enable map; an absent key means enabled. */
  tabsEnabled?: Record<string, boolean>
  /** Whether the snapshot intercepts external links into the sidebar. */
  browserInterceptLinks?: boolean
  /** Whether the takeover covers https links. */
  browserInterceptHttps?: boolean
}

/**
 * Build the prefs patch that enables the official browser tab and link
 * takeover, or `undefined` when the resolved section already has that
 * product state.
 * @param current - Resolved snapshot prefs section.
 * @returns the shallow settings patch, or `undefined` when no write is needed.
 */
export function snapshotBrowserProductPatch(
  current: SnapshotBrowserPrefs,
): SnapshotBrowserProductPatch | undefined {
  if (
    current.tabsEnabled?.[SNAPSHOT_BROWSER_TAB_ID] !== false
    && current.browserInterceptLinks === true
    && current.browserInterceptHttps === true
  ) {
    return undefined
  }
  return {
    tabsEnabled: { ...current.tabsEnabled, [SNAPSHOT_BROWSER_TAB_ID]: true },
    browserInterceptLinks: true,
    browserInterceptHttps: true,
  }
}
