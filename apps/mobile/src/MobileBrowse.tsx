import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  COMPANION_HISTORY_PAGE_SIZE,
  pageCompanionHistory,
  type CompanionConversationMap,
} from './companion-history.ts'
import type { MobileCompanionOperationFailure, MobileCompanionSearchSnapshot } from './companion-surface.ts'
import { MobileConversation } from './MobileConversation.tsx'
import type {
  SessionId, SessionListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationPresentationLocale } from '@deepseek-ai/dsh-client-ui-conversation/presentation'
import {
  expandedSessionGroups, SessionListPresentation, workspacePresentationTranslate,
} from '@deepseek-ai/dsh-client-ui-workspace/presentation'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import css from './MobileBrowse.module.css'
import type { MobilePresentationClock } from './mobile-clock.ts'
import type { CompanionConnectionFailure } from './companion-lifecycle.ts'

/** Mobile Companion browse props. */
export interface MobileBrowseProps {
  /** Selected Desktop display name. */
  desktopName: string
  /** Live Remote Online / Offline label. */
  connection: 'online' | 'offline'
  /** Stable Relay or Companion failure retained while the foreground lifecycle retries. */
  connectionFailure?: CompanionConnectionFailure | undefined
  /** Desktop-confirmed Session history. */
  sessions: SessionListState
  /** Desktop Workspace projection consumed by the shared grouping owner. */
  workspaces: readonly WorkspaceView[]
  /** Desktop conversations keyed by the same Session ids. */
  conversations: CompanionConversationMap
  /** Product locale inherited by list and detail views. */
  locale: ConversationPresentationLocale
  /** Product theme inherited by shared detail components. */
  theme: 'light' | 'dark'
  /** Session-authorized historical-image loader. */
  loadImage: (sessionId: SessionId, attachment: ImageAttachmentRef) => Promise<string>
  /** Whether the current foreground synchronization admits mutations. */
  canMutate: boolean
  /** Latest non-attachment mutation or refresh failure. */
  operationFailure?: MobileCompanionOperationFailure | undefined
  /** Latest cache deletion failure. */
  cacheFailure?: string | undefined
  /** Live clock owner used by shared relative-time rows. */
  clock: MobilePresentationClock
  /** Optional create handler used by Workspace and global create actions. */
  onCreate?: ((input: { workspace?: string }) => void) | undefined
  /** Submit one prompt to the selected Desktop Session. */
  onSubmit?: ((sessionId: SessionId, text: string) => void | Promise<void>) | undefined
  /** Cancel one active Desktop Session. */
  onCancel?: ((sessionId: SessionId) => void) | undefined
  /** Select an attachment for the opened Session. */
  onAttach?: ((sessionId: SessionId, file: File) => void) | undefined
  /** Load older history for one selected Session. */
  onLoadOlder?: ((sessionId: SessionId) => void) | undefined
  /** Select the one Session that receives full live conversation projection. */
  onObserveSession?: ((sessionId?: SessionId) => void) | undefined
  /** Desktop-authoritative full-text Session search state. */
  search: MobileCompanionSearchSnapshot
  /** Request one full-text Session search from Desktop. */
  onSearch?: ((query: string) => void) | undefined
  /** Clear cached content for this Paired Desktop without deleting pairing keys. */
  onClearCache?: (() => void | Promise<void>) | undefined
}

/** Phone-sized Workspace/Session browse without Desktop columns. */
export function MobileBrowse({
  desktopName, connection, connectionFailure, sessions, workspaces, conversations, locale, theme, loadImage,
  canMutate, clock, onCreate, onSubmit, onCancel, onAttach, onLoadOlder, onObserveSession,
  search, onSearch, onClearCache, operationFailure,
  cacheFailure,
}: MobileBrowseProps): ReactNode {
  const [openId, setOpenId] = useState<SessionId>()
  const [page, setPage] = useState(0)
  const [searchDraft, setSearchDraft] = useState(search.query)
  useEffect(() => { setSearchDraft(search.query) }, [search.query])
  useEffect(() => {
    if (canMutate) onObserveSession?.(openId)
  }, [canMutate, onObserveSession, openId])
  const searchActive = search.query !== ''
  const paged = useMemo(
    () => pageCompanionHistory(sessions, workspaces, page, COMPANION_HISTORY_PAGE_SIZE),
    [sessions, workspaces, page],
  )
  const groups = useMemo(
    () => expandedSessionGroups(paged.sessions, paged.workspaces),
    [paged.sessions, paged.workspaces],
  )
  const tw = useMemo(() => workspacePresentationTranslate(locale), [locale])
  const now = useSyncExternalStore(
    listener => clock.subscribe(listener),
    () => clock.getSnapshot(),
  )
  const open = openId === undefined ? undefined : sessions.byId[openId]
  const openSearchHit = openId === undefined
    ? undefined
    : search.items.find(item => item.sessionId === openId)
  const openTitle = open?.displayTitle ?? openSearchHit?.sessionId
  const conversation = openId === undefined ? undefined : conversations[openId]
  const detailFailure = operationFailure !== undefined
    && (operationFailure.operation === 'refresh' || operationFailure.sessionId === openId)
    ? operationFailure.failure
    : undefined
  const connectionAlert = connectionFailure === undefined
    ? undefined
    : companionConnectionFailureMessage(connectionFailure, locale)
  const openSession = (id: SessionId): void => {
    setOpenId(id)
    if (conversations[id] === undefined) onLoadOlder?.(id)
  }

  if (openId !== undefined && openTitle !== undefined) {
    if (conversation !== undefined) {
      return (
        <>
          {connectionAlert !== undefined && <p role="alert">{connectionAlert}</p>}
          <MobileConversation
            title={openTitle}
            onBack={() => { setOpenId(undefined) }}
            snapshot={conversation}
            locale={locale}
            theme={theme}
            loadImage={attachment => loadImage(openId, attachment)}
            cwd={open?.cwd}
            mutationEnabled={canMutate}
            operationFailure={detailFailure}
            {...(onSubmit === undefined ? {} : { onSubmit: (text: string) => onSubmit(openId, text) })}
            {...(onCancel === undefined ? {} : { onCancel: () => { onCancel(openId) } })}
            {...(onAttach === undefined ? {} : { onAttach: (file: File) => { onAttach(openId, file) } })}
            {...(onLoadOlder === undefined ? {} : { onLoadOlder: () => { onLoadOlder(openId) } })}
          />
        </>
      )
    }
    return (
      <section className={css.page} data-mobile-browse="conversation" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
        <header className={css.header}>
          <button type="button" className={css.back} onClick={() => { setOpenId(undefined) }}>{locale === 'zh' ? '返回' : 'Back'}</button>
          <h1>{openTitle}</h1>
        </header>
        {connectionAlert !== undefined && <p role="alert">{connectionAlert}</p>}
        {detailFailure !== undefined && <p role="alert">{detailFailure.message}</p>}
        <p className={css.summary}>{locale === 'zh' ? '尚未加载此 Session 的对话。' : 'This Session conversation is not loaded.'}</p>
      </section>
    )
  }

  return (
    <section className={css.page} data-mobile-browse="list" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
      <header className={css.header}>
        <p className={css.desktop}>{desktopName}</p>
        <p className={css.connection} data-connection={connection}>{connection === 'online' ? 'Remote Online' : 'Remote Offline'}</p>
        {connectionAlert !== undefined && (
          <p role="alert" data-connection-failure={connectionFailure?.code}>{connectionAlert}</p>
        )}
        {onSearch !== undefined && (
          <form
            className={css.search}
            onSubmit={(event) => { event.preventDefault(); onSearch(searchDraft) }}
          >
            <input
              type="search"
              aria-label={locale === 'zh' ? '搜索 Desktop Sessions' : 'Search Desktop Sessions'}
              value={searchDraft}
              disabled={!canMutate}
              onChange={(event) => { setSearchDraft(event.target.value) }}
            />
            <button type="submit" disabled={!canMutate}>{locale === 'zh' ? '搜索' : 'Search'}</button>
          </form>
        )}
        {search.status === 'error' && <p role="alert">{search.error.message}</p>}
        {(operationFailure?.operation === 'refresh' || operationFailure?.operation === 'create')
          && <p role="alert">{operationFailure.failure.message}</p>}
        {cacheFailure !== undefined && <p role="alert">{cacheFailure}</p>}
        {onClearCache !== undefined && (
          <button type="button" onClick={() => { void onClearCache() }}>
            {locale === 'zh' ? '清除此 Desktop 的缓存' : 'Clear this Desktop cache'}
          </button>
        )}
        {onCreate !== undefined && (
          <button type="button" disabled={!canMutate} onClick={() => { if (canMutate) onCreate({}) }}>
            {locale === 'zh' ? '新建 Ungrouped Session' : 'New ungrouped Session'}
          </button>
        )}
      </header>
      {searchActive && (
        <AuthoritativeSearchResults search={search} locale={locale} onOpen={openSession} />
      )}
      {!searchActive && groups.map((group) => {
        const label = group.workspaceId === undefined ? tw('group.ungrouped') : group.label
        return (
          <section key={group.key} className={css.group} aria-label={label}>
            <h2>{label}</h2>
            {onCreate !== undefined && group.workspaceId !== undefined && (
              <button type="button" disabled={!canMutate} onClick={() => {
                if (canMutate && group.workspaceId !== undefined) onCreate({ workspace: group.workspaceId })
              }}>
                {locale === 'zh' ? `在 ${group.label} 新建 Session` : `New Session in ${group.label}`}
              </button>
            )}
            <SessionListPresentation
              label={label}
              nodes={group.sessions}
              currentId={openId}
              now={now}
              onOpen={openSession}
              t={tw}
            />
          </section>
        )
      })}
      {!searchActive && paged.spilled > 0 && (
        <button type="button" className={css.more} onClick={() => { setPage(current => current + 1) }}>
          {locale === 'zh' ? `加载更多（还有 ${paged.spilled}）` : `Load more (${paged.spilled} remaining)`}
        </button>
      )}
    </section>
  )
}

function companionConnectionFailureMessage(
  failure: CompanionConnectionFailure,
  locale: ConversationPresentationLocale,
): string {
  if (failure.code === 'COMPANION_UPDATE_REQUIRED'
    || failure.code === 'COMPANION_SECURITY_CAPABILITY_MISSING') {
    if (failure.updateEndpoint === 'mobile') {
      return locale === 'zh'
        ? '请升级 Mobile 后再连接此 Desktop。'
        : 'Update Mobile to connect to this Desktop.'
    }
    if (failure.updateEndpoint === 'desktop') {
      return locale === 'zh'
        ? '请升级 Desktop 后再从 Mobile 连接。'
        : 'Update Desktop to connect from this Mobile.'
    }
  }
  if (failure.code === 'PLATFORM_CAPACITY') {
    const retry = failure.retryAfterMs === undefined
      ? undefined
      : formatRetryDelay(failure.retryAfterMs, locale)
    return locale === 'zh'
      ? retry === undefined
        ? 'Platform 当前容量已满，正在重试。'
        : `Platform 当前容量已满，将在 ${retry}后重试。`
      : retry === undefined
        ? 'Platform capacity is full. Retrying.'
        : `Platform capacity is full. Retrying in ${retry}.`
  }
  if (failure.code === 'REMOTE_OFFLINE') {
    return locale === 'zh'
      ? 'Paired Desktop 当前离线，正在重试。'
      : 'Paired Desktop is Remote Offline. Retrying.'
  }
  return locale === 'zh'
    ? `远程连接失败（${failure.code}），正在重试。`
    : `Remote connection failed (${failure.code}). Retrying.`
}

function formatRetryDelay(milliseconds: number, locale: ConversationPresentationLocale): string {
  const seconds = (milliseconds / 1_000).toFixed(3).replace(/(?:\.0+|(\.\d*?)0+)$/u, '$1')
  if (locale === 'zh') return `${seconds} 秒`
  return `${seconds} ${seconds === '1' ? 'second' : 'seconds'}`
}

function AuthoritativeSearchResults({
  search,
  locale,
  onOpen,
}: {
  search: MobileCompanionSearchSnapshot
  locale: ConversationPresentationLocale
  onOpen: (id: SessionId) => void
}): ReactNode {
  const text = locale === 'zh'
    ? {
      label: 'Desktop 搜索结果', loading: '正在搜索 Desktop Session 内容…',
      empty: '没有匹配的 Session', more: '结果较多，请缩小搜索范围。',
    }
    : {
      label: 'Desktop search results', loading: 'Searching Desktop Session content…',
      empty: 'No matching Sessions', more: 'More results are available. Narrow the search.',
    }
  return (
    <section className={css.group} aria-label={text.label}>
      <h2>{text.label}</h2>
      {search.status === 'loading' && <p>{text.loading}</p>}
      {search.status !== 'loading' && search.items.length === 0 && <p>{text.empty}</p>}
      <ul className={css.sessions}>
        {search.items.map((hit) => {
          const sessionId = hit.sessionId
          return (
            <li key={hit.sessionId} className={css.searchResult}>
              <button
                type="button"
                onClick={() => { onOpen(sessionId) }}
              >
                <strong>{hit.sessionId}</strong>
                <span>{hit.snippet}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {search.hasMore && <p>{text.more}</p>}
    </section>
  )
}
