/** Side Chat tab shell over the canonical explicit-Session conversation renderer. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  IconNewChatOutline16, IconPlusOutline16, Menu, StateDot, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { SIDE_LABEL_PREFIX, SIDE_NEW_THREAD_TITLE, sideThreadRows } from '../sidechat-core.ts'
import { api } from './api.ts'
import { IconHistoryOutline16, IconSaveOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import css from './SideChatView.module.css'

/** The thread a tab is bound to (durable in tab.meta across refreshes). */
export function sidechatThreadIdOf(tab: SidebarTab): string | undefined {
  const meta = tab.meta as { threadId?: unknown } | undefined
  return typeof meta?.threadId === 'string' ? meta.threadId : undefined
}

/** Reopen target consumed by the next Side Chat descriptor create. */
let parkedReopen: string | undefined

/** Park one existing thread for the next Side Chat tab open. */
export function parkSidechatReopen(threadId: string): void {
  parkedReopen = threadId
}

/** Consume the parked reopen target exactly once. */
export function consumeSidechatSeed(): string | undefined {
  const value = parkedReopen
  parkedReopen = undefined
  return value
}

/** React StrictMode and HMR must not create two child Sessions for one tab. */
const inFlightStarts = new Set<string>()

function threadDisplayTitle(title: string): string {
  if (title === SIDE_NEW_THREAD_TITLE) return t('sideChatUntitled')
  return title.startsWith(SIDE_LABEL_PREFIX) ? title.slice(SIDE_LABEL_PREFIX.length) : title
}

/** One Side Chat tab: thread lifecycle chrome plus the canonical conversation slot. */
export function SideChatView(props: {
  ctx: Context
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
}): React.ReactNode {
  const { ctx, scope, tab, visible } = props
  const list = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const threads = useMemo(() => sideThreadRows(list.byId, scope.sessionId), [list, scope.sessionId])
  const threadId = sidechatThreadIdOf(tab)
  const autoCreate = (tab.meta as { autoCreate?: unknown } | undefined)?.autoCreate === true
  const summary = threadId === undefined ? undefined : list.byId[threadId]
  const running = summary?.running === true
  const canSave = threadId !== undefined && summary?.blank === false && !running

  const [busy, setBusy] = useState<'starting' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const conversationHost = useRef<HTMLDivElement | null>(null)

  const startThread = useCallback(async (): Promise<void> => {
    if (inFlightStarts.has(tab.id)) return
    inFlightStarts.add(tab.id)
    setBusy('starting')
    setError(null)
    try {
      const { childId } = await api.sidechatStart(scope.sessionId)
      ctx.betterSidebar?.updateTab(tab.id, { meta: { threadId: childId } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlightStarts.delete(tab.id)
      setBusy(null)
    }
  }, [ctx, scope.sessionId, tab.id])

  useEffect(() => {
    if (threadId !== undefined || !autoCreate || !visible) return
    void startThread()
  }, [threadId, autoCreate, visible, startThread])

  useEffect(() => {
    const display = summary?.displayTitle
    if (display === undefined) return
    const title = threadDisplayTitle(display)
    if (title === '' || title === tab.title) return
    try {
      ctx.betterSidebar?.updateTab(tab.id, { title })
    } catch {
      // A stale tab title does not affect the durable Session or renderer.
    }
  }, [summary, tab.id, tab.title, ctx])

  useEffect(() => {
    const host = conversationHost.current
    if (host === null || threadId === undefined) return
    return ctx.uiRenderer.mountSession(host, 'conversation', threadId, { renderMode: 'sidechat' })
  }, [ctx.uiRenderer, threadId])

  const openNewThread = (): void => {
    setMenuOpen(false)
    ctx.betterSidebar?.openTab({ type: 'sidechat' }, scope)
  }

  const openExistingThread = (id: string): void => {
    setMenuOpen(false)
    if (id === threadId) return
    parkSidechatReopen(id)
    ctx.betterSidebar?.openTab({ type: 'sidechat' }, scope)
  }

  const menuItems = useMemo<MenuEntry[]>(() => {
    const items: MenuEntry[] = [
      { id: '$new', label: t('sideChatNew'), icon: <IconPlusOutline16 /> },
    ]
    if (threads.length === 0) return items
    items.push({ type: 'separator', id: '$sep' })
    for (const row of threads) {
      items.push({
        id: row.id,
        label: threadDisplayTitle(row.title),
        ...(row.running ? { icon: <StateDot state="ongoing" size={8} /> } : {}),
      })
    }
    return items
  }, [threads])

  const handleSave = async (): Promise<void> => {
    if (threadId === undefined || !canSave || busy !== null) return
    setBusy('saving')
    setError(null)
    setSaved(false)
    try {
      if (ctx.sessions.fork === undefined) throw new Error('session fork is unavailable')
      const newId = await ctx.sessions.fork({ sessionId: threadId, increaseTitle: true })
      const title = summary === undefined ? '' : threadDisplayTitle(summary.displayTitle).trim()
      const binding = ctx.sessions.binding?.(newId)
      if (binding !== undefined && title !== '') await binding.session.rename(title)
      ctx.sessions.open?.(newId)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (threadId === undefined) {
    return (
      <div className={css.sidechat}>
        <div className={css.sidechatHero}>
          <IconNewChatOutline16 />
          <div className={busy === 'starting'
            ? `${css.sidechatHeroTitle} ${css.sidechatShimmerText}`
            : css.sidechatHeroTitle}
          >
            {busy === 'starting' ? t('sideChatCreating') : t('sideChatEmpty')}
          </div>
          <div className={css.sidechatHeroDesc}>{t('sideChatEmptyDesc')}</div>
          {error !== null && <div className={css.sidechatError}>{t('sideChatError', { message: error })}</div>}
          {busy !== 'starting' && (
            <button type="button" className={css.sidechatPrimaryBtn} onClick={() => void startThread()}>
              {error === null ? t('sideChatNew') : t('sideChatRetry')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={css.sidechat}>
      <div className={css.sidechatDetailHeader}>
        {running && <StateDot state="ongoing" size={8} className={css.sidechatHeaderDot} />}
        <span className={css.sidechatHeaderSpacer} />
        <Menu
          open={menuOpen}
          anchor={(
            <button
              type="button"
              className={css.sidechatIconBtn}
              onClick={() => { setMenuOpen(value => !value) }}
              title={t('sideChatThreads')}
            >
              <IconHistoryOutline16 />
            </button>
          )}
          items={menuItems}
          selectedId={threadId}
          onSelect={(id) => { id === '$new' ? openNewThread() : openExistingThread(id) }}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          portal
          dense
        />
        <button
          type="button"
          className={css.sidechatIconBtn}
          onClick={() => void handleSave()}
          disabled={!canSave || busy !== null}
          title={`${t('sideChatSave')} — ${t('sideChatSaveTitle')}`}
        >
          <IconSaveOutline16 />
        </button>
      </div>
      {!canSave && !running && <div className={css.sidechatHint}>{t('sideChatNoTurn')}</div>}
      {saved && <div className={css.sidechatHint}>{t('sideChatSaved')}</div>}
      {error !== null && <div className={css.sidechatError}>{t('sideChatError', { message: error })}</div>}
      <div ref={conversationHost} className={css.sidechatCanonical} />
    </div>
  )
}
