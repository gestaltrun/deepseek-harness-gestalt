/**
 * Structural walk of the snapshot sidebar split tree for browser tabs.
 */

import type { SidebarBrowserTab } from './reconcile.ts'

/** One leaf or split in the snapshot workbench tree. */
type SplitNode =
  | { kind: 'leaf'; tabs: ReadonlyArray<{ id: string; type: string; meta?: unknown }> }
  | { kind: 'split'; children: readonly SplitNode[] }

/** Snapshot state slice this adapter reads. */
export interface SidebarStateSlice {
  /** Whether the right workbench panel is expanded. */
  readonly panelOpen: boolean
  /** Right workbench split tree. */
  readonly splits: SplitNode
  /** Bottom workbench split tree. */
  readonly bottomSplits?: SplitNode
}

/**
 * Collect every open snapshot tab whose type is `browser`.
 * @param state - Per-session sidebar state, or undefined before a session is active.
 * @returns browser tabs from both workbench trees.
 */
export function collectSidebarBrowserTabs(state: SidebarStateSlice | undefined): SidebarBrowserTab[] {
  if (state === undefined) return []
  return [...leaves(state.splits), ...leaves(state.bottomSplits)].map(tab => ({
    id: tab.id,
    ...(tab.meta === undefined ? {} : { meta: tab.meta }),
  }))
}

function leaves(
  node: SplitNode | undefined,
): Array<{ id: string; type: string; meta?: unknown }> {
  if (node === undefined) return []
  if (node.kind === 'leaf') return node.tabs.filter(tab => tab.type === 'browser')
  return node.children.flatMap(child => leaves(child))
}
