/**
 * Snapshot browser tab body when the workbench adapter is mounted:
 * official page chrome bound to tab.meta.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BrowserPageState, BrowserWorkspaceProjection,
} from '@deepseek-ai/dsh-browser-workspace/client'
import { listBrowserWorkspacePages } from '@deepseek-ai/dsh-browser-workspace/client'
import { BrowserPageChrome } from '@deepseek-ai/dsh-client-ui-browser/client'
import { isDesktopOverlayDocument } from '../desktop-overlay-document.ts'
import {
  officialProfileFromChrome, officialTabMeta, officialTargetKey, officialTargetOf,
} from '../official-tab-meta.ts'
import { bindBrowserWorkspace, type BrowserWorkspaceRemoteFace } from './remote-bind.ts'

/** Structural props the snapshot tab descriptor passes through. */
export interface OfficialBrowserTabProps {
  /** Client root context. */
  ctx: Context
  /** Snapshot tab record. */
  tab: { id: string; meta?: unknown }
  /** Session that owns this tab. */
  scope: { sessionId: string }
  /** False when this snapshot tab is hidden. */
  visible?: boolean
}

interface SessionListRow {
  projectionValues?: { browserWorkspace?: BrowserWorkspaceProjection }
}

interface SessionListSnapshot {
  byId: Record<string, SessionListRow | undefined>
}

interface SessionListFace {
  getSnapshot(): SessionListSnapshot
  subscribe(listener: () => void): () => void
}

interface WorkbenchBrowserCreateFace {
  ensureOfficial?: (tabId: string) => void
}

/**
 * Official page chrome for one snapshot browser tab.
 * @param props - Snapshot tab props plus the client context.
 * @returns the official chrome, or a creating placeholder.
 */
export function OfficialBrowserTab({ ctx, tab, scope, visible }: OfficialBrowserTabProps) {
  const sessionId = scope.sessionId as SessionId
  const list = (ctx.get('sessions') as { list: SessionListFace } | undefined)?.list
  const snapshot = useSyncExternalStore(
    list === undefined ? emptySubscribe : listener => list.subscribe(listener),
    () => list?.getSnapshot().byId[sessionId]?.projectionValues?.browserWorkspace,
  )
  const bound = officialTargetOf(tab.meta)
  const listedRevision = useMemo(() => {
    if (bound === undefined) return undefined
    return listBrowserWorkspacePages(snapshot).find(page => (
      page.target.profileId === bound.profileId
      && page.target.workspaceId === bound.workspaceId
      && page.target.browserId === bound.browserId
      && page.target.tabId === bound.tabId
    ))?.revision
  }, [bound, snapshot])
  // The snapshot tab passes its own ctx, which does not inject this Remote.
  const t = (ctx.get('locale') as { bind: (ns: string) => (key: string) => string } | undefined)
    ?.bind('browser') ?? ((key: string) => key)
  const sidebar = ctx.get('betterSidebar') as {
    updateTab?: (id: string, patch: { title?: string; meta?: unknown }) => void
  } | undefined
  const onCommittedPage = useCallback((page: BrowserPageState) => {
    const title = page.title.trim()
    if (sidebar?.updateTab === undefined) return
    sidebar.updateTab(tab.id, {
      meta: officialTabMeta(page.target, officialProfileFromChrome(page.chrome)),
      ...(title === '' ? {} : { title }),
    })
  }, [sidebar, tab.id])

  const workbench = ctx.get('workbenchBrowser') as WorkbenchBrowserCreateFace | undefined
  const actions = useMemo(() => {
    const remote = ctx.get('remote.browserWorkspace') as BrowserWorkspaceRemoteFace | undefined
    return remote === undefined ? undefined : bindBrowserWorkspace(remote, sessionId)
  }, [ctx, sessionId])
  const boundKey = bound === undefined ? '' : officialTargetKey(bound)
  useEffect(() => {
    if (isDesktopOverlayDocument() || bound !== undefined) return
    workbench?.ensureOfficial?.(tab.id)
  }, [boundKey, tab.id, workbench])

  if (isDesktopOverlayDocument() || actions === undefined) return null

  return (
    <BrowserPageChrome
      target={bound}
      {...(listedRevision === undefined ? {} : { listedRevision })}
      refresh={actions.refresh}
      observe={actions.observe}
      screenshot={actions.screenshot}
      t={t}
      {...(visible === undefined ? {} : { visible })}
      onCommittedPage={onCommittedPage}
    />
  )
}

function emptySubscribe(): () => void {
  return () => {}
}
