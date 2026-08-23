/**
 * Apply official-page ↔ sidebar-tab reconcile actions and panel follow.
 */

import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BrowserWorkspaceCreateRemoteRequest,
  BrowserWorkspaceProjection,
} from '@deepseek-ai/dsh-browser-workspace/client'
import { listBrowserWorkspacePages } from '@deepseek-ai/dsh-browser-workspace/client'
import {
  officialProfileFromChrome, officialTabMeta, officialTargetKey, officialTargetOf,
} from '../official-tab-meta.ts'
import { planOfficialPageReconcile, type OfficialPage, type SidebarBrowserTab } from '../reconcile.ts'
import { collectSidebarBrowserTabs, type SidebarStateSlice } from '../sidebar-tabs.ts'
import type { BoundBrowserWorkspace } from './remote-bind.ts'

/** Snapshot sidebar verbs this bridge needs. */
export interface WorkbenchSidebarFace {
  openTab: (seed: { type: string }) => void
  updateTab: (tabId: string, patch: { title?: string; meta?: unknown }) => void
  closeTab: (tabId: string) => void
  activateTab: (tabId: string) => void
  setPanelOpen: (open: boolean) => void
  getSnapshot: () => { sessionId?: string; state?: SidebarStateSlice }
  subscribeState?: (listener: () => void) => () => void
}

/** Inputs the bridge rereads on every tick. */
export interface OfficialBrowserBridgeDeps {
  /** Mounted sidebar service. */
  sidebar: WorkbenchSidebarFace
  /** Bind remotes for the current Session. */
  bindRemote: (sessionId: SessionId) => BoundBrowserWorkspace
  /** Current Session list row projection. */
  projectionOf: (sessionId: string) => BrowserWorkspaceProjection | undefined
  /** Settings-derived create identity. */
  createRequest: () => BrowserWorkspaceCreateRemoteRequest
}

/**
 * Keep snapshot browser tabs 1:1 with official Workspace pages.
 */
export class OfficialBrowserBridge {
  private known = new Map<string, string>()
  private running = false
  private queued = false
  private readonly creating = new Set<string>()

  /**
   * @param deps - Sidebar, Remote, projection, and create-identity faces.
   */
  constructor(private readonly deps: OfficialBrowserBridgeDeps) {}

  /**
   * Expand the workbench and focus the sidebar tab for the active official page.
   * @param sessionId - Session whose workbench should open.
   */
  reveal(sessionId: string): void {
    const snapshot = this.deps.sidebar.getSnapshot()
    if (snapshot.sessionId !== undefined && snapshot.sessionId !== sessionId) return
    this.deps.sidebar.setPanelOpen(true)
    const projection = this.deps.projectionOf(sessionId)
    const pages = listBrowserWorkspacePages(projection)
    const active = pages.at(-1)
    if (active === undefined) return
    const tabs = collectSidebarBrowserTabs(snapshot.state)
    const match = tabs.find((tab) => {
      const bound = officialTargetOf(tab.meta)
      return bound !== undefined && officialTargetKey(bound) === officialTargetKey(active.target)
    })
    if (match !== undefined) this.deps.sidebar.activateTab(match.id)
  }

  /**
   * Create an official page for one empty sidebar tab.
   * Creates for the same tab serialize behind the in-flight attempt.
   * @param tabId - Snapshot tab id (`browser:N`).
   */
  ensureOfficial(tabId: string): void {
    void this.createOfficialOnce(tabId)
  }

  /**
   * Reconcile official pages and sidebar tabs for the current Session.
   */
  tick(): void {
    if (this.running) {
      this.queued = true
      return
    }
    const snapshot = this.deps.sidebar.getSnapshot()
    const sessionId = snapshot.sessionId
    if (sessionId === undefined) return
    const projection = this.deps.projectionOf(sessionId)
    const official: OfficialPage[] = listBrowserWorkspacePages(projection).map(page => ({
      target: page.target,
      revision: page.revision,
    }))
    const sidebar = collectSidebarBrowserTabs(snapshot.state)
    const planned = planOfficialPageReconcile(official, sidebar, this.known)
    this.known = planned.known
    void this.applyActions(sessionId as SessionId, planned.actions)
  }

  private async applyActions(
    sessionId: SessionId,
    actions: ReturnType<typeof planOfficialPageReconcile>['actions'],
  ): Promise<void> {
    this.running = true
    try {
      const remote = this.deps.bindRemote(sessionId)
      for (const action of actions) {
        if (action.kind === 'attach') {
          this.deps.sidebar.updateTab(action.tabId, {
            meta: officialTabMeta(action.target),
          })
          this.known.set(action.tabId, officialTargetKey(action.target))
          continue
        }
        if (action.kind === 'closeSidebar') {
          this.deps.sidebar.closeTab(action.tabId)
          this.known.delete(action.tabId)
          continue
        }
        if (action.kind === 'closeOfficial') {
          try {
            await remote.close(action.target, action.revision)
          } catch {
            // The Runtime may already have closed the tab; the next tick drops it.
          }
          continue
        }
        if (action.kind === 'openSidebar') {
          this.deps.sidebar.openTab({ type: 'browser' })
          continue
        }
        await this.createOfficialOnce(action.tabId)
      }
    } finally {
      this.running = false
      if (this.queued) {
        this.queued = false
        this.tick()
      }
    }
  }

  /**
   * Run at most one create for an empty sidebar tab.
   * @param tabId - Snapshot tab that still has no official identity.
   * @returns when that tab's create attempt settles.
   */
  private async createOfficialOnce(tabId: string): Promise<void> {
    if (this.creating.has(tabId)) return
    this.creating.add(tabId)
    try {
      await this.createOfficialTab(tabId)
    } finally {
      this.creating.delete(tabId)
    }
  }

  /**
   * Create one official page and bind it to `tabId`.
   * Browser Workspace owns matching-Profile instance reuse.
   * @param tabId - Snapshot tab that still has no official identity.
   */
  private async createOfficialTab(tabId: string): Promise<void> {
    const snapshot = this.deps.sidebar.getSnapshot()
    const sessionId = snapshot.sessionId
    if (sessionId === undefined) return
    const sidebar = collectSidebarBrowserTabs(snapshot.state)
    const tab = sidebar.find(entry => entry.id === tabId)
    if (tab === undefined || officialTargetOf(tab.meta) !== undefined) return
    try {
      const request = this.deps.createRequest()
      const created = await this.deps.bindRemote(sessionId as SessionId).create(request)
      this.deps.sidebar.updateTab(tabId, {
        meta: officialTabMeta(created.target, officialProfileFromChrome(created.chrome)),
        ...(created.title.trim() === '' ? {} : { title: created.title }),
      })
      this.known.set(tabId, officialTargetKey(created.target))
    } catch {
      // Create can reject when the Session or Runtime is gone; the empty
      // sidebar tab stays until the user closes it or a later tick retries.
    }
  }
}

export type { SidebarBrowserTab }
