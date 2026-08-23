/** Side Chat tab shell over the canonical explicit-Session conversation renderer. */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { SIDE_LABEL_PREFIX, SIDE_NEW_THREAD_TITLE } from '../sidechat-core.ts'
import { registerSidechatDraft } from './api.ts'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import css from './SideChatView.module.css'

/** The thread a tab is bound to (durable in tab.meta across refreshes). */
export function sidechatThreadIdOf(tab: SidebarTab): string | undefined {
  const meta = tab.meta as { threadId?: unknown } | undefined
  return typeof meta?.threadId === 'string' ? meta.threadId : undefined
}

function threadDisplayTitle(title: string): string {
  if (title === SIDE_NEW_THREAD_TITLE) return t('sideChatUntitled')
  return title.startsWith(SIDE_LABEL_PREFIX) ? title.slice(SIDE_LABEL_PREFIX.length) : title
}

/** One Side Chat tab: thread creation plus the canonical conversation slot. */
export function SideChatView(props: {
  ctx: Context
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
}): React.ReactNode {
  const { ctx, scope, tab } = props
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const threadId = sidechatThreadIdOf(tab)
  const provisional = (tab.meta as { provisional?: unknown } | undefined)?.provisional === true
  const summary = threadId === undefined ? undefined : list.byId[threadId]
  const published = summary?.blank === false
  const conversationHost = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (threadId === undefined || !provisional || published) return
    const forgetDraft = registerSidechatDraft(threadId, scope.sessionId)
    const unstage = ctx.sessions.stageProvisional({
      sessionId: threadId as never,
      parentSessionId: scope.sessionId as never,
      origin: 'subagent',
      title: SIDE_NEW_THREAD_TITLE,
    })
    return () => {
      forgetDraft()
      unstage()
    }
  }, [ctx.sessions, provisional, published, scope.sessionId, threadId])

  useEffect(() => {
    if (threadId === undefined || !provisional || !published) return
    ctx.betterSidebar?.updateTab(tab.id, { meta: { threadId } })
  }, [ctx.betterSidebar, provisional, published, tab.id, threadId])

  useEffect(() => {
    const display = summary?.displayTitle
    if (display === undefined || !published) return
    const title = threadDisplayTitle(display)
    if (title === '' || title === tab.title) return
    try {
      ctx.betterSidebar?.updateTab(tab.id, { title })
    } catch {
      // A stale tab title does not affect the durable Session or renderer.
    }
  }, [summary, published, tab.id, tab.title, ctx])

  useEffect(() => {
    const host = conversationHost.current
    if (host === null || threadId === undefined) return
    return ctx.uiRenderer.mountSession(host, 'conversation', threadId, { renderMode: 'sidechat' })
  }, [ctx.uiRenderer, threadId])

  if (threadId === undefined) return null

  return (
    <div className={css.sidechat}>
      <div ref={conversationHost} className={css.sidechatCanonical} />
    </div>
  )
}
