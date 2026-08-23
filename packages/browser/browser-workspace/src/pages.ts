/**
 * Pure page-list projection for Session-owned Browser Workspace snapshots.
 * @module @deepseek-ai/dsh-browser-workspace/pages
 */

import type { BrowserTarget } from '@deepseek-ai/dsh-browser-runtime'
import type { BrowserWorkspacePage, BrowserWorkspaceProjection } from './types.ts'

/**
 * Flatten every owned tab in Workspace, instance, then tab order.
 * @param snapshot - Session-owned Workspace projection, or an absent loading value.
 * @returns addressable page rows with their latest listed revisions.
 */
export function listBrowserWorkspacePages(
  snapshot: BrowserWorkspaceProjection | null | undefined,
): readonly BrowserWorkspacePage[] {
  if (snapshot === undefined || snapshot === null) return []
  const pages: BrowserWorkspacePage[] = []
  for (const workspace of snapshot.workspaces) {
    for (const instance of workspace.browsers) {
      for (const tab of instance.tabs) {
        pages.push({
          target: {
            profileId: workspace.profileId,
            workspaceId: workspace.workspaceId,
            browserId: instance.browserId,
            tabId: tab.tabId,
          } satisfies BrowserTarget,
          revision: tab.revision,
        })
      }
    }
  }
  return pages
}
