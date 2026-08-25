import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
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
  desktopName?: string | undefined
  /** Live Remote Online / Offline label. */
  connection: 'unpaired' | 'online' | 'offline'
  /** Signed-in Platform Account login shown in the navigation header. */
  accountLogin: string
  /** Signed-in Platform Account avatar shown in the navigation header. */
  accountAvatarUrl: string
  /** Open the separate current-Installation Account page. */
  onOpenAccount: () => void
  /** Open the separate Personal Pairing page while no Desktop is selected. */
  onOpenPairing?: (() => void) | undefined
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
  /** Notify the connection owner after the selected Session detail view commits. */
  onSessionOpened?: ((sessionId: SessionId) => void) | undefined
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
  desktopName, connection, accountLogin, accountAvatarUrl, onOpenAccount, onOpenPairing,
  connectionFailure, sessions, workspaces, conversations, locale, theme, loadImage,
  canMutate, clock, onCreate, onSessionOpened, onSubmit, onCancel, onAttach, onLoadOlder, onObserveSession,
  search, onSearch, operationFailure,
  cacheFailure,
}: MobileBrowseProps): ReactNode {
  const [openId, setOpenId] = useState<SessionId>()
  const [page, setPage] = useState(0)
  const [searchDraft, setSearchDraft] = useState(search.query)
  const adoptedCurrent = useRef<SessionId>()
  const historyRequested = useRef<SessionId>()
  useEffect(() => { setSearchDraft(search.query) }, [search.query])
  useEffect(() => {
    const current = sessions.current
    if (current === undefined || sessions.byId[current] === undefined) {
      adoptedCurrent.current = undefined
      return
    }
    if (adoptedCurrent.current === current) return
    adoptedCurrent.current = current
    setOpenId(current)
  }, [sessions.byId, sessions.current])
  useEffect(() => {
    if (openId === undefined) {
      historyRequested.current = undefined
      return
    }
    onSessionOpened?.(openId)
    if (!canMutate) {
      historyRequested.current = undefined
      return
    }
    if (conversations[openId] !== undefined || historyRequested.current === openId) return
    historyRequested.current = openId
    onLoadOlder?.(openId)
  }, [canMutate, conversations, onLoadOlder, onSessionOpened, openId])
  useEffect(() => {
    if (canMutate) onObserveSession?.(openId)
  }, [canMutate, onObserveSession, openId])
  const searchActive = search.query !== ''
  const connectionLabel = connection === 'unpaired'
    ? locale === 'zh' ? '未连接' : 'Not paired'
    : connection === 'online' ? 'Remote Online' : 'Remote Offline'
  const paged = useMemo(
    () => pageCompanionHistory(sessions, workspaces, page, COMPANION_HISTORY_PAGE_SIZE),
    [sessions, workspaces, page],
  )
  const groups = useMemo(
    () => expandedSessionGroups(paged.sessions, paged.workspaces),
    [paged.sessions, paged.workspaces],
  )
  const tw = useMemo(() => workspacePresentationTranslate(locale), [locale])
  const subscribeClock = useCallback((listener: () => void) => clock.subscribe(listener), [clock])
  const now = useSyncExternalStore(
    subscribeClock,
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
      <header className={css.remoteHeader}>
        <button type="button" className={css.account} aria-label={locale === 'zh' ? '查看账号' : 'View account'} onClick={onOpenAccount}>
          <img src={accountAvatarUrl} alt="" />
          <span>@{accountLogin}</span>
        </button>
        <div>
          <strong>{locale === 'zh' ? '远程' : 'Remote'}</strong>
          {connection !== 'unpaired' && (
            <span>
              <i className={connection === 'online' ? css.dotOnline : css.dotOffline} />
              {laptopIcon}
              {desktopName ?? (locale === 'zh' ? '已配对 Desktop' : 'Paired Desktop')}
            </span>
          )}
          <p className={css.connection} data-connection={connection}>{connectionLabel}</p>
        </div>
        {connection === 'unpaired' && onOpenPairing !== undefined
          ? (
            <button
              type="button"
              className={css.iconButton}
              aria-label={locale === 'zh' ? '扫描配对' : 'Scan to pair'}
              onClick={onOpenPairing}
            >{scanIcon}</button>
          )
          : <span className={css.headerSlot} />}
      </header>
      <main className={css.projectList}>
        {connectionAlert !== undefined && (
          <p className={css.error} role="alert" data-connection-failure={connectionFailure?.code}>{connectionAlert}</p>
        )}
        {search.status === 'error' && <p className={css.error} role="alert">{search.error.message}</p>}
        {(operationFailure?.operation === 'refresh' || operationFailure?.operation === 'create')
          && <p className={css.error} role="alert">{operationFailure.failure.message}</p>}
        {cacheFailure !== undefined && <p className={css.error} role="alert">{cacheFailure}</p>}
        {connection === 'unpaired' ? (
          <div className={css.emptyState}>
            <p>{locale === 'zh' ? '扫码连接 Desktop 后即可查看 Session' : 'Pair a Desktop to browse Sessions.'}</p>
          </div>
        ) : (
          <>
            <div className={css.projectTitle}><h1>{locale === 'zh' ? '项目' : 'Projects'}</h1></div>
            {searchActive && (
              <AuthoritativeSearchResults search={search} locale={locale} onOpen={openSession} />
            )}
            {!searchActive && groups.map((group) => {
              const label = group.workspaceId === undefined ? tw('group.ungrouped') : group.label
              return (
                <section key={group.key} className={css.group} aria-label={label}>
                  <header>
                    <div className={css.projectName}>{folderIcon}<h2>{label}</h2></div>
                    {onCreate !== undefined && (
                      <button
                        type="button"
                        className={css.compose}
                        disabled={!canMutate}
                        aria-label={locale === 'zh' ? `在 ${label} 新建 Session` : `New Session in ${label}`}
                        onClick={() => {
                          if (!canMutate) return
                          if (group.workspaceId === undefined) onCreate({})
                          else onCreate({ workspace: group.workspaceId })
                        }}
                      >{composeIcon}</button>
                    )}
                  </header>
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
          </>
        )}
      </main>
      {connection !== 'unpaired' && (
        <footer className={css.dock}>
          <div className={css.chatHeading}>
            <span>{locale === 'zh' ? '聊天' : 'Chats'}</span>
            {onCreate !== undefined && (
              <button
                type="button"
                className={css.compose}
                disabled={!canMutate}
                aria-label={locale === 'zh' ? '新建聊天' : 'New chat'}
                onClick={() => { if (canMutate) onCreate({}) }}
              >{composeIcon}</button>
            )}
          </div>
          <div className={css.dockActions}>
            {onSearch !== undefined && (
              <form className={css.search} onSubmit={(event) => { event.preventDefault(); onSearch(searchDraft) }}>
                <button
                  type="submit"
                  className={css.searchSubmit}
                  aria-label={locale === 'zh' ? '搜索' : 'Search'}
                  disabled={!canMutate}
                >{searchIcon}</button>
                <input
                  type="search"
                  aria-label={locale === 'zh' ? '搜索 Desktop Sessions' : 'Search Desktop Sessions'}
                  placeholder={locale === 'zh' ? '搜索聊天记录' : 'Search chat history'}
                  value={searchDraft}
                  disabled={!canMutate}
                  onChange={(event) => { setSearchDraft(event.target.value) }}
                />
              </form>
            )}
            {onCreate !== undefined && (
              <button
                type="button"
                className={css.round}
                disabled={!canMutate}
                aria-label={locale === 'zh' ? '新建 Ungrouped Session' : 'New ungrouped Session'}
                onClick={() => { if (canMutate) onCreate({}) }}
              >{composeIcon}</button>
            )}
          </div>
        </footer>
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

const scanIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M7 5H5v2M17 5h2v2M7 19H5v-2M17 19h2v-2M8 12h8" />
  </svg>
)

const folderIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v7A2.5 2.5 0 0 1 18.5 18h-13A2.5 2.5 0 0 1 3 15.5v-9Z" />
  </svg>
)

const laptopIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="4" y="5" width="16" height="11" rx="1.5" />
    <path d="M2 19h20" />
  </svg>
)

const searchIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </svg>
)

const composeIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M13.5 5.5 18.5 10.5M4 20l3.2-.7L19 7.5a2.1 2.1 0 0 0-3-3L4.7 16.3 4 20Z" />
  </svg>
)
