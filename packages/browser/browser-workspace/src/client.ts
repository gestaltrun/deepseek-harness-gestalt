/**
 * Client-namespace projection of the Session-owned Browser Workspace: a
 * pure re-export of the package's types outlet. Client code imports ONLY
 * the client namespace (repo discipline), so `./client` projects the same
 * single-source content `./types` serves to host consumers — zero duplication.
 * @module @deepseek-ai/dsh-browser-workspace/client
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

export type * from './types.ts'
export { listBrowserWorkspacePages } from './pages.ts'
export type {
  BrowserClosedState,
  BrowserInstanceId,
  BrowserPageState,
  BrowserProfileChrome,
  BrowserProfileId,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTabId,
  BrowserTarget,
  BrowserWorkspaceId,
} from '@deepseek-ai/dsh-browser-runtime'

/**
 * Unwrap one Browser Workspace Remote result or throw its reported failure.
 * @param result - settling result from a generated Browser Workspace method.
 * @returns the successful payload.
 */
export async function unwrapBrowserWorkspaceRemote<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const settled = await result
  if (!settled.ok) {
    throw Object.assign(new Error(settled.error.message), { code: settled.error.code })
  }
  return settled.value
}
