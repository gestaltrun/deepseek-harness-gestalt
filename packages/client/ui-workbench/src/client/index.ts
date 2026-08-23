/**
 * Workbench adapter, browser half: official page chrome in the snapshot
 * browser tab, 1:1 with Session-owned Workspace pages.
 */
import { createElement, type ReactElement } from 'react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BrowserWorkspaceCreateRemoteRequest, BrowserWorkspaceProjection } from '@deepseek-ai/dsh-browser-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  BROWSER_SETTINGS_NAMESPACE,
  DEFAULT_BROWSER_SETTINGS,
  browserCreateRequestFromSettings,
  type BrowserSettings,
} from '@deepseek-ai/dsh-client-ui-browser/client'
import { isDesktopOverlayDocument } from '../desktop-overlay-document.ts'
import { OfficialBrowserTab, type OfficialBrowserTabProps } from './OfficialBrowserTab.tsx'
import { OfficialBrowserBridge, type WorkbenchSidebarFace } from './bridge.ts'
import { bindBrowserWorkspace, type BrowserWorkspaceRemoteFace } from './remote-bind.ts'

export const inject = [
  'betterSidebar', 'sessions', 'remote', 'remote.browserWorkspace', 'settingsScope',
] as const

interface SessionListRow {
  projectionValues?: { browserWorkspace?: BrowserWorkspaceProjection }
}

/** Face published for preview reveal and snapshot BrowserView. */
export interface WorkbenchBrowserFace {
  /** Render official chrome for one snapshot browser tab. */
  renderTab: (props: OfficialBrowserTabProps) => ReactElement
  /** Expand the workbench and focus the active official page. */
  reveal: (sessionId: string) => void
  /** Settings-derived create identity for an empty `+ → Browser` tab. */
  createRequest: () => BrowserWorkspaceCreateRemoteRequest
  /** Bind an empty snapshot tab to a new official page. */
  ensureOfficial: (tabId: string) => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbenchBrowser: WorkbenchBrowserFace
  }
}

/**
 * Client plugin body: publish official tab chrome and keep pages paired.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const sidebar = ctx.get('betterSidebar') as WorkbenchSidebarFace | undefined
  if (sidebar === undefined) {
    throw new Error('ui-workbench: betterSidebar is not published; mount the snapshot client first')
  }
  const remote = ctx.remote.browserWorkspace as BrowserWorkspaceRemoteFace
  const settings = ctx.settingsScope.bind<BrowserSettings>({ namespace: BROWSER_SETTINGS_NAMESPACE })
  const createRequest = (): BrowserWorkspaceCreateRemoteRequest => browserCreateRequestFromSettings({
    ...DEFAULT_BROWSER_SETTINGS,
    ...settings.getSnapshot().value,
  })
  const bridge = new OfficialBrowserBridge({
    sidebar,
    bindRemote: sessionId => bindBrowserWorkspace(remote, sessionId),
    projectionOf: (sessionId) => {
      const row = ctx.sessions.list.getSnapshot().byId[sessionId as SessionId] as SessionListRow | undefined
      return row?.projectionValues?.browserWorkspace
    },
    createRequest,
  })
  const face: WorkbenchBrowserFace = {
    renderTab: props => createElement(OfficialBrowserTab, props),
    reveal: (sessionId) => { bridge.reveal(sessionId) },
    createRequest,
    ensureOfficial: (tabId) => {
      if (isDesktopOverlayDocument()) return
      bridge.ensureOfficial(tabId)
    },
  }
  ctx.provide('workbenchBrowser', face)

  if (isDesktopOverlayDocument()) return
  const tick = (): void => { bridge.tick() }
  const subscribeState = sidebar.subscribeState
  if (subscribeState !== undefined) {
    ctx.effect(() => subscribeState(tick), 'ui-workbench: sidebar reconcile')
  }
  ctx.effect(() => ctx.sessions.list.subscribe(tick), 'ui-workbench: projection reconcile')
  tick()
}
