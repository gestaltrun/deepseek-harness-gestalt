/**
 * Pure types of the Session-owned Browser Workspace: the one home of the
 * `browserWorkspace` projection-key declaration and its durable payload.
 * @module @deepseek-ai/dsh-browser-workspace/types
 */

import type {
  BrowserCreateAttach,
  BrowserInstanceId,
  BrowserProfileId,
  BrowserTarget,
  BrowserTabId,
  BrowserWorkspaceId,
} from '@deepseek-ai/dsh-browser-runtime'

/** One open tab retained by a Session-owned browser instance. */
export interface BrowserWorkspaceTabRecord {
  readonly tabId: BrowserTabId
  /** Last Runtime revision the Binder committed for this tab, including Runtime-internal bumps. */
  readonly revision: number
}

/** One browser instance retained by a Session-owned Browser Workspace. */
export interface BrowserWorkspaceInstanceRecord {
  readonly browserId: BrowserInstanceId
  readonly tabs: readonly BrowserWorkspaceTabRecord[]
  readonly activeTabId: BrowserTabId | null
}

/** One Browser Workspace retained by a Session. */
export interface BrowserWorkspaceRecord {
  readonly workspaceId: BrowserWorkspaceId
  readonly profileId: BrowserProfileId
  readonly browsers: readonly BrowserWorkspaceInstanceRecord[]
  readonly activeBrowserId: BrowserInstanceId | null
}

/** Whole Session-owned Browser Workspace projection. */
export interface BrowserWorkspaceProjection {
  readonly workspaces: readonly BrowserWorkspaceRecord[]
  readonly activeWorkspaceId: BrowserWorkspaceId | null
}

/** One Session-owned page flattened from the Workspace hierarchy. */
export interface BrowserWorkspacePage {
  readonly target: BrowserTarget
  readonly revision: number
}

/**
 * Wire payload for one Session-owned create. AbortSignal stays off the wire;
 * attach is optional and names a Workspace or instance this Session already owns.
 */
export type BrowserWorkspaceCreateRemoteRequest =
  | { readonly profile: 'temporary'; readonly attach?: BrowserCreateAttach }
  | { readonly profile: 'persistent'; readonly name: string; readonly attach?: BrowserCreateAttach }
  | { readonly profile: 'shared'; readonly attach?: BrowserCreateAttach }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Session-owned Browser Workspace snapshot folded from `browser/workspace`.
     * Whole-value rule: every logged change carries the complete post-change state.
     */
    browserWorkspace: BrowserWorkspaceProjection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole Session-owned Browser Workspace snapshot. Log-only, last-wins.
     * Carries every owned instance, tab, and per-tab revision so Session
     * switch, reload, and replay restore the same Workspace without exposing
     * another Session's tabs.
     */
    'browser/workspace': BrowserWorkspaceProjection
  }
}
