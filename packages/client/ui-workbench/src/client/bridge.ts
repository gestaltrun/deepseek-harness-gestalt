/**
 * Apply official-page ↔ sidebar-tab reconcile actions and panel follow.
 */

import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BrowserPageState, BrowserTarget, BrowserWorkspaceCreateRemoteRequest,
  BrowserWorkspaceProjection,
} from '@deepseek-ai/dsh-browser-workspace/client'
import { listBrowserWorkspacePages } from '@deepseek-ai/dsh-browser-workspace/client'
import { recoverListedMutation } from '@deepseek-ai/dsh-client-ui-browser/client'
import {
  officialProfileFromChrome, officialProfileOf, officialTabMeta, officialTargetKey, officialTargetOf,
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

/** Resolve persisted Profile metadata to the Browser Workspace create vocabulary. */
function createRequestForTab(
  meta: unknown,
  fallback: () => BrowserWorkspaceCreateRemoteRequest,
): BrowserWorkspaceCreateRemoteRequest {
  const profile = officialProfileOf(meta)
  if (profile === undefined) return fallback()
  if (profile.kind === 'persistent') return { profile: 'persistent', name: profile.name }
  return { profile: profile.kind }
}

interface MissingTargetRecovery {
  readonly missingTarget: BrowserTarget
  readonly request: BrowserWorkspaceCreateRemoteRequest
  readonly url?: string
}

/**
 * Keep snapshot browser tabs 1:1 with official Workspace pages.
 */
export class OfficialBrowserBridge {
  private known = new Map<string, string>()
  private running = false
  private queued = false
  private readonly creating = new Set<string>()
  private readonly recovering = new Set<string>()
  private readonly closing = new Set<string>()

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
   * Replace a projected target that disappeared across a Runtime restart.
   * @param tabId - Sidebar tab that must keep its occupancy.
   * @param missingTarget - Target rejected by the current Runtime.
   * @returns the replacement page, or `undefined` when the tab changed or creation failed.
   */
  async recoverOfficial(tabId: string, missingTarget: BrowserTarget): Promise<BrowserPageState | undefined> {
    const snapshot = this.deps.sidebar.getSnapshot()
    if (snapshot.sessionId === undefined) return
    if (this.recovering.has(tabId)) return
    const tab = collectSidebarBrowserTabs(snapshot.state).find(entry => entry.id === tabId)
    const bound = tab === undefined ? undefined : officialTargetOf(tab.meta)
    if (tab === undefined || bound === undefined) return
    if (officialTargetKey(bound) !== officialTargetKey(missingTarget)) return
    const remembered = listBrowserWorkspacePages(this.deps.projectionOf(snapshot.sessionId))
      .find(page => officialTargetKey(page.target) === officialTargetKey(missingTarget))
    const profile = officialProfileOf(tab.meta)
    const request = createRequestForTab(tab.meta, this.deps.createRequest)
    this.recovering.add(tabId)
    this.deps.sidebar.updateTab(tabId, {
      meta: profile === undefined ? {} : { profile },
    })
    this.known.delete(tabId)
    try {
      return await this.createOfficialOnce(tabId, {
        missingTarget,
        request,
        ...(remembered?.url === undefined ? {} : { url: remembered.url }),
      })
    } finally {
      this.recovering.delete(tabId)
      if (this.queued && !this.running && this.recovering.size === 0) {
        this.queued = false
        this.tick()
      }
    }
  }

  /**
   * Reconcile official pages and sidebar tabs for the current Session.
   */
  tick(): void {
    if (this.running || this.recovering.size > 0) {
      this.queued = true
      return
    }
    const snapshot = this.deps.sidebar.getSnapshot()
    const sessionId = snapshot.sessionId
    if (sessionId === undefined) return
    const projection = this.deps.projectionOf(sessionId)
    const listed: OfficialPage[] = listBrowserWorkspacePages(projection).map(page => ({
      target: page.target,
      revision: page.revision,
    }))
    const listedKeys = new Set(listed.map(page => officialTargetKey(page.target)))
    for (const key of this.closing) {
      if (!listedKeys.has(key)) this.closing.delete(key)
    }
    const retryClosing = listed
      .filter(page => this.closing.has(officialTargetKey(page.target)))
      .map(page => ({ kind: 'closeOfficial' as const, target: page.target, revision: page.revision }))
    const official = listed.filter(page => !this.closing.has(officialTargetKey(page.target)))
    const sidebar = collectSidebarBrowserTabs(snapshot.state)
    const planned = planOfficialPageReconcile(official, sidebar, this.known)
    this.known = planned.known
    void this.applyActions(sessionId as SessionId, [...retryClosing, ...planned.actions])
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
          this.closing.add(officialTargetKey(action.target))
          try {
            await recoverListedMutation(
              remote.close,
              remote.observe,
              action.target,
              action.revision,
            )
          } catch {
            // Keep the close intent until the projection drops the page. A later
            // reconcile retries the Runtime mutation without reopening its tab.
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
   * @returns the created page, or `undefined` when skipped or rejected.
   */
  private async createOfficialOnce(
    tabId: string,
    recovery?: MissingTargetRecovery,
  ): Promise<BrowserPageState | undefined> {
    if (this.creating.has(tabId)) return
    this.creating.add(tabId)
    try {
      return await this.createOfficialTab(tabId, recovery)
    } finally {
      this.creating.delete(tabId)
    }
  }

  /**
   * Create one official page and bind it to `tabId`.
   * Browser Workspace owns matching-Profile instance reuse.
   * @param tabId - Snapshot tab that still has no official identity.
   */
  private async createOfficialTab(
    tabId: string,
    recovery?: MissingTargetRecovery,
  ): Promise<BrowserPageState | undefined> {
    const snapshot = this.deps.sidebar.getSnapshot()
    const sessionId = snapshot.sessionId
    if (sessionId === undefined) return
    const sidebar = collectSidebarBrowserTabs(snapshot.state)
    const tab = sidebar.find(entry => entry.id === tabId)
    if (tab === undefined) return
    const bound = officialTargetOf(tab.meta)
    if (recovery === undefined && bound !== undefined) return
    if (
      recovery !== undefined
      && bound !== undefined
      && officialTargetKey(bound) !== officialTargetKey(recovery.missingTarget)
    ) return
    try {
      const request = recovery?.request ?? createRequestForTab(tab.meta, this.deps.createRequest)
      const remote = this.deps.bindRemote(sessionId as SessionId)
      const created = await remote.create(request)
      const committed = recovery?.url === undefined
        ? created
        : await remote.refresh(created.target, created.revision, recovery.url)
      this.deps.sidebar.updateTab(tabId, {
        meta: officialTabMeta(committed.target, officialProfileFromChrome(committed.chrome)),
        ...(committed.title.trim() === '' ? {} : { title: committed.title }),
      })
      this.known.set(tabId, officialTargetKey(committed.target))
      return committed
    } catch {
      // Create can reject when the Session or Runtime is gone; the empty
      // sidebar tab stays until the user closes it or a later tick retries.
    }
  }
}

export type { SidebarBrowserTab }
