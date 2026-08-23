/**
 * Product patch that keeps the snapshot browser tab on and turns off its
 * iframe link takeover. An absent `tabsEnabled.browser` key means enabled;
 * a leftover `false` from the first workbench mount must be written `true`.
 */

/** Settings namespace registered by the better-sidebar snapshot host. */
export const SNAPSHOT_PREFS_NS = 'dsh-better-sidebar'

/** Built-in snapshot tab id for the official Browser page chrome. */
export const SNAPSHOT_BROWSER_TAB_ID = 'browser'

/** Fields the adapter writes on the snapshot prefs namespace. */
export interface SnapshotBrowserProductPatch {
  /** Per-tab enable map with the official browser tab forced on. */
  tabsEnabled: Record<string, boolean>
  /** Master switch for snapshot link takeover into the leftover iframe. */
  browserInterceptLinks: false
}

/** Current snapshot prefs fields the product patch reads. */
export interface SnapshotBrowserPrefs {
  /** Per-tab enable map; an absent key means enabled. */
  tabsEnabled?: Record<string, boolean>
  /** Whether the snapshot intercepts external links into its iframe browser. */
  browserInterceptLinks?: boolean
}

/**
 * Build the prefs patch that enables the official browser tab, or `undefined`
 * when the resolved section already has that product state.
 * @param current - Resolved snapshot prefs section.
 * @returns the shallow settings patch, or `undefined` when no write is needed.
 */
export function snapshotBrowserProductPatch(
  current: SnapshotBrowserPrefs,
): SnapshotBrowserProductPatch | undefined {
  if (
    current.tabsEnabled?.[SNAPSHOT_BROWSER_TAB_ID] !== false
    && current.browserInterceptLinks === false
  ) {
    return undefined
  }
  return {
    tabsEnabled: { ...current.tabsEnabled, [SNAPSHOT_BROWSER_TAB_ID]: true },
    browserInterceptLinks: false,
  }
}
