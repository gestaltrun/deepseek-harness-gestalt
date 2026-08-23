/**
 * Last-wins fold of Session-owned Browser Workspace snapshots.
 * @module @deepseek-ai/dsh-browser-workspace/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BrowserWorkspaceProjection } from './types.ts'

/** Empty Workspace owned by a Session that has never opened a browser. */
export const EMPTY_BROWSER_WORKSPACE: BrowserWorkspaceProjection = Object.freeze({
  workspaces: Object.freeze([]),
  activeWorkspaceId: null,
})

/**
 * Fold the last logged Browser Workspace snapshot, or the empty Workspace.
 * @param events - Session log or any prefix of it.
 * @param end - Exclusive end index; defaults to the whole log.
 * @returns the last logged Workspace, or the empty Workspace when none exists.
 */
export function foldBrowserWorkspace(
  events: readonly SessionEvent[],
  end = events.length,
): BrowserWorkspaceProjection {
  let snapshot = EMPTY_BROWSER_WORKSPACE
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index += 1
    if (event.type === 'browser/workspace') snapshot = event.data
  }
  return snapshot
}

/**
 * Last-wins projection transition. Unrelated events keep the same reference.
 * @param state - Projection covering all prior events.
 * @param event - Next committed Session event.
 * @returns the next projection.
 */
export function applyBrowserWorkspaceProjection(
  state: BrowserWorkspaceProjection,
  event: SessionEvent,
): BrowserWorkspaceProjection {
  return event.type === 'browser/workspace' ? event.data : state
}
