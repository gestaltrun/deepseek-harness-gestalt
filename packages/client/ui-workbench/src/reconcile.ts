/**
 * Pair official Browser Workspace pages with snapshot sidebar browser tabs.
 */

import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'
import {
  officialTabMeta, officialTargetKey, officialTargetOf,
} from './official-tab-meta.ts'

/** One official page the Session currently owns. */
export interface OfficialPage {
  /** Complete Runtime tab identity. */
  readonly target: BrowserTarget
  /** Latest revision accepted by Runtime mutations. */
  readonly revision: number
}

/** One snapshot sidebar tab of type `browser`. */
export interface SidebarBrowserTab {
  /** Snapshot tab id (`browser:N`). */
  readonly id: string
  /** Persisted plugin meta, if any. */
  readonly meta?: unknown
}

/** One reconcile step the adapter runner applies. */
export type OfficialReconcileAction =
  | { readonly kind: 'attach'; readonly tabId: string; readonly target: OfficialPage['target'] }
  | { readonly kind: 'createOfficial'; readonly tabId: string }
  | { readonly kind: 'openSidebar' }
  | { readonly kind: 'closeOfficial'; readonly target: OfficialPage['target']; readonly revision: number }
  | { readonly kind: 'closeSidebar'; readonly tabId: string }

/** Known sidebar-tab to official-page bindings from the previous tick. */
export type OfficialBindingMap = ReadonlyMap<string, string>

/**
 * Plan the next official-page ↔ sidebar-tab reconciliation.
 * A disappeared known sidebar tab closes that official page (user close).
 * An official page that vanished closes its leftover sidebar tab.
 * Empty sidebar tabs bind unmatched official pages, then create.
 * Leftover official pages open one new sidebar tab.
 * @param official - Session-owned pages.
 * @param sidebar - Open snapshot browser tabs.
 * @param known - Bindings from the previous tick (`tabId` → target key).
 * @returns actions and the bindings after those actions.
 */
export function planOfficialPageReconcile(
  official: readonly OfficialPage[],
  sidebar: readonly SidebarBrowserTab[],
  known: OfficialBindingMap,
): { actions: OfficialReconcileAction[]; known: Map<string, string> } {
  const actions: OfficialReconcileAction[] = []
  const nextKnown = new Map(known)
  const sidebarById = new Map(sidebar.map(tab => [tab.id, tab]))
  const officialByKey = new Map(official.map(page => [officialTargetKey(page.target), page]))
  const closingOfficial = new Set<string>()

  for (const [tabId, key] of known) {
    if (sidebarById.has(tabId)) continue
    const page = officialByKey.get(key)
    if (page !== undefined) {
      actions.push({ kind: 'closeOfficial', target: page.target, revision: page.revision })
      closingOfficial.add(key)
    }
    nextKnown.delete(tabId)
  }

  const matchedOfficial = new Set<string>()
  const emptyTabs: SidebarBrowserTab[] = []

  for (const tab of sidebar) {
    const bound = officialTargetOf(tab.meta)
    if (bound === undefined) {
      emptyTabs.push(tab)
      continue
    }
    const key = officialTargetKey(bound)
    if (!officialByKey.has(key)) {
      actions.push({ kind: 'closeSidebar', tabId: tab.id })
      nextKnown.delete(tab.id)
      continue
    }
    matchedOfficial.add(key)
    nextKnown.set(tab.id, key)
  }

  const unmatchedOfficial = official.filter((page) => {
    const key = officialTargetKey(page.target)
    return !matchedOfficial.has(key) && !closingOfficial.has(key)
  })
  let remainingTabs = emptyTabs
  let remainingOfficial = unmatchedOfficial
  while (true) {
    const [tab, ...tabsAfterPair] = remainingTabs
    const [page, ...officialAfterPair] = remainingOfficial
    if (tab === undefined || page === undefined) break
    actions.push({ kind: 'attach', tabId: tab.id, target: page.target })
    nextKnown.set(tab.id, officialTargetKey(page.target))
    remainingTabs = tabsAfterPair
    remainingOfficial = officialAfterPair
  }

  for (const tab of remainingTabs) {
    actions.push({ kind: 'createOfficial', tabId: tab.id })
  }
  if (remainingOfficial.length > 0) {
    actions.push({ kind: 'openSidebar' })
  }

  return { actions, known: nextKnown }
}

export { officialTabMeta, officialTargetKey, officialTargetOf }
