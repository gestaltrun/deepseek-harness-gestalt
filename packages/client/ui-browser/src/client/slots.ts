/**
 * Injected faces of the Browser Dock and collapsed preview. Live Workspace
 * facts arrive through `useProjection('browserWorkspace')`; inject carries
 * only mutation verbs and page observation.
 */

import type {
  BrowserPageState,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTarget,
} from '@deepseek-ai/dsh-browser-workspace/client'

export { unwrapBrowserWorkspaceRemote as unwrapRemote } from '@deepseek-ai/dsh-browser-workspace/client'

/** Official page chrome verbs closed over the current Session. */
export interface BrowserPageChromeActions {
  /** Reload the current tab by navigating to the Runtime's current URL. */
  refresh: (target: BrowserTarget, expectedRevision: number, url: string) => Promise<BrowserPageState>
  /** Observe one Session-owned tab. */
  observe: (target: BrowserTarget) => Promise<BrowserRuntimeState>
  /** Capture one Session-owned tab. */
  screenshot: (target: BrowserTarget) => Promise<BrowserScreenshot>
}

/** Collapsed preview verbs: select a back layer or reveal the workbench tab. */
export interface BrowserPreviewActions {
  /** Reveal the official page in the current Session's workbench panel. */
  reveal: () => void
  /** Focus one Session-owned tab without opening the Dock. */
  focus: (target: BrowserTarget, expectedRevision: number) => Promise<BrowserPageState>
  /** Observe one Session-owned tab. */
  observe: (target: BrowserTarget) => Promise<BrowserRuntimeState>
  /** Capture one Session-owned tab. */
  screenshot: (target: BrowserTarget) => Promise<BrowserScreenshot>
}
