/**
 * Session-bound Browser Workspace Remote verbs for the official tab chrome.
 */

import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  unwrapBrowserWorkspaceRemote,
  type BrowserPageState,
  type BrowserRuntimeState,
  type BrowserScreenshot,
  type BrowserTarget,
  type BrowserWorkspaceCreateRemoteRequest,
} from '@deepseek-ai/dsh-browser-workspace/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Generated-or-SRC Browser Workspace namespace this adapter calls. */
export interface BrowserWorkspaceRemoteFace {
  create?: (
    sessionId: SessionId,
    request: BrowserWorkspaceCreateRemoteRequest,
  ) => Promise<RemoteResult<BrowserPageState>>
  close: (
    sessionId: SessionId,
    target: BrowserTarget,
    expectedRevision: number,
  ) => Promise<RemoteResult<unknown>>
  navigate: (
    sessionId: SessionId,
    target: BrowserTarget,
    expectedRevision: number,
    url: string,
  ) => Promise<RemoteResult<BrowserPageState>>
  observe: (sessionId: SessionId, target: BrowserTarget) => Promise<RemoteResult<BrowserRuntimeState>>
  screenshot: (sessionId: SessionId, target: BrowserTarget) => Promise<RemoteResult<BrowserScreenshot>>
}

/** Chrome verbs closed over one Session. */
export interface BoundBrowserWorkspace {
  create: (request: BrowserWorkspaceCreateRemoteRequest) => Promise<BrowserPageState>
  close: (target: BrowserTarget, expectedRevision: number) => Promise<unknown>
  refresh: (target: BrowserTarget, expectedRevision: number, url: string) => Promise<BrowserPageState>
  observe: (target: BrowserTarget) => Promise<BrowserRuntimeState>
  screenshot: (target: BrowserTarget) => Promise<BrowserScreenshot>
}

/**
 * Bind generated Remote methods to one Session id.
 * @param remote - Mounted `remote.browserWorkspace` namespace.
 * @param sessionId - Owning Session identity.
 * @returns unwrapped Session-bound verbs.
 */
export function bindBrowserWorkspace(
  remote: BrowserWorkspaceRemoteFace,
  sessionId: SessionId,
): BoundBrowserWorkspace {
  return {
    create: (request) => {
      if (remote.create === undefined) {
        return Promise.reject(new Error('remote.browserWorkspace.create is not mounted'))
      }
      return unwrapBrowserWorkspaceRemote(remote.create(sessionId, request))
    },
    close: (target, expectedRevision) => unwrapBrowserWorkspaceRemote(remote.close(sessionId, target, expectedRevision)),
    refresh: (target, expectedRevision, url) =>
      unwrapBrowserWorkspaceRemote(remote.navigate(sessionId, target, expectedRevision, url)),
    observe: target => unwrapBrowserWorkspaceRemote(remote.observe(sessionId, target)),
    screenshot: target => unwrapBrowserWorkspaceRemote(remote.screenshot(sessionId, target)),
  }
}
