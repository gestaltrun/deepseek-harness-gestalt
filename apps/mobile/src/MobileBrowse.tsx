import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode, type TouchEvent,
} from 'react'
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
  /** Request the current Desktop Session and Workspace baseline. */
  onRefresh?: (() => void | Promise<void>) | undefined
  /** Clear cached content for this Paired Desktop without deleting pairing keys. */
  onClearCache?: (() => void | Promise<void>) | undefined
}

type MobileBrowseScreen = 'list' | 'search' | 'creating'
type PullRefreshState = 'idle' | 'refreshing' | 'offline' | 'failed'

const PULL_REFRESH_THRESHOLD = 72

interface MobileCreateTarget {
  input: { workspace?: string }
  label: string
}

/** Phone-sized Workspace/Session browse without Desktop columns. */
export function MobileBrowse({
  desktopName, connection, onOpenAccount, onOpenPairing,
  connectionFailure, sessions, workspaces, conversations, locale, theme, loadImage,
  canMutate, clock, onCreate, onSessionOpened, onSubmit, onCancel, onAttach, onLoadOlder, onObserveSession,
  search, onSearch, onRefresh, operationFailure,
  cacheFailure,
}: MobileBrowseProps): ReactNode {
  const [openId, setOpenId] = useState<SessionId>()
  const [screen, setScreen] = useState<MobileBrowseScreen>(() => search.query === '' ? 'list' : 'search')
  const [returnScreen, setReturnScreen] = useState<'list' | 'search'>('list')
  const [createTarget, setCreateTarget] = useState<MobileCreateTarget>()
  const [pagesByGroup, setPagesByGroup] = useState<Readonly<Record<string, number>>>({})
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [searchDraft, setSearchDraft] = useState(search.query)
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshState, setRefreshState] = useState<PullRefreshState>('idle')
  const adoptedCurrent = useRef<SessionId>()
  const historyRequested = useRef<SessionId>()
  const pullStart = useRef<number>()
  const pullDistanceRef = useRef(0)
  const refreshSessions = useRef(sessions)
  useEffect(() => {
    setSearchDraft(search.query)
    if (search.query !== '') setScreen(current => current === 'list' ? 'search' : current)
  }, [search.query])
  useEffect(() => {
    const current = sessions.current
    if (current === undefined || sessions.byId[current] === undefined) {
      adoptedCurrent.current = undefined
      return
    }
    if (adoptedCurrent.current === current) return
    adoptedCurrent.current = current
    setCreateTarget(undefined)
    setReturnScreen('list')
    setScreen('list')
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
  useEffect(() => {
    if (refreshState === 'refreshing' && sessions !== refreshSessions.current) setRefreshState('idle')
  }, [refreshState, sessions])
  useEffect(() => {
    if (refreshState === 'refreshing' && operationFailure?.operation === 'refresh') setRefreshState('failed')
  }, [operationFailure, refreshState])
  useEffect(() => {
    if (connection === 'online' && refreshState === 'offline') setRefreshState('idle')
  }, [connection, refreshState])
  const connectionLabel = connection === 'unpaired'
    ? locale === 'zh' ? '未连接' : 'Not paired'
    : connection === 'online' ? 'Remote Online' : 'Remote Offline'
  const groups = useMemo(
    () => expandedSessionGroups(sessions, workspaces),
    [sessions, workspaces],
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
    setReturnScreen(screen === 'search' ? 'search' : 'list')
    setOpenId(id)
  }
  const closeSearch = (): void => {
    setScreen('list')
    setSearchDraft('')
    onSearch?.('')
  }
  const beginCreate = (target: MobileCreateTarget): void => {
    if (onCreate === undefined) return
    setCreateTarget(target)
    setScreen('creating')
    if (canMutate) onCreate(target.input)
  }
  const closeConversation = (): void => {
    setOpenId(undefined)
    setScreen(returnScreen)
  }
  const startPull = (event: TouchEvent<HTMLElement>): void => {
    if (refreshState === 'refreshing' || event.currentTarget.scrollTop > 0) return
    const firstTouch = event.touches[0]
    if (firstTouch === undefined) return
    pullStart.current = firstTouch.clientY
    pullDistanceRef.current = 0
    setPullDistance(0)
    if (refreshState !== 'idle') setRefreshState('idle')
  }
  const movePull = (event: TouchEvent<HTMLElement>): void => {
    const start = pullStart.current
    const firstTouch = event.touches[0]
    if (start === undefined || firstTouch === undefined) return
    const distance = Math.max(0, firstTouch.clientY - start)
    pullDistanceRef.current = distance
    setPullDistance(distance)
  }
  const finishPull = (): void => {
    const distance = pullDistanceRef.current
    pullStart.current = undefined
    pullDistanceRef.current = 0
    setPullDistance(0)
    if (distance < PULL_REFRESH_THRESHOLD) return
    if (connection !== 'online' || !canMutate || onRefresh === undefined) {
      setRefreshState('offline')
      return
    }
    refreshSessions.current = sessions
    setRefreshState('refreshing')
    try {
      const result = onRefresh()
      void Promise.resolve(result).catch(() => { setRefreshState('failed') })
    } catch {
      setRefreshState('failed')
    }
  }
  const refreshText = refreshState === 'refreshing'
    ? locale === 'zh' ? '正在刷新…' : 'Refreshing…'
    : refreshState === 'offline'
      ? locale === 'zh' ? 'Remote Offline，重新连接后才能刷新。' : 'Remote Offline. Reconnect before refreshing.'
      : refreshState === 'failed'
        ? locale === 'zh' ? '刷新失败，请重试。' : 'Refresh failed. Try again.'
        : pullDistance > 8
          ? pullDistance >= PULL_REFRESH_THRESHOLD
            ? locale === 'zh' ? '松开刷新' : 'Release to refresh'
            : locale === 'zh' ? '下拉刷新' : 'Pull down to refresh'
          : undefined
  const refreshHeight = refreshState === 'idle'
    ? Math.min(40, pullDistance * 0.45)
    : 40

  if (openId !== undefined && openTitle !== undefined) {
    if (conversation !== undefined) {
      return (
        <MobileConversation
          title={openTitle}
          onBack={closeConversation}
          snapshot={conversation}
          locale={locale}
          theme={theme}
          loadImage={attachment => loadImage(openId, attachment)}
          cwd={open?.cwd}
          mutationEnabled={canMutate}
          connectionAlert={connectionAlert}
          operationFailure={detailFailure}
          {...(onSubmit === undefined ? {} : { onSubmit: (text: string) => onSubmit(openId, text) })}
          {...(onCancel === undefined ? {} : { onCancel: () => { onCancel(openId) } })}
          {...(onAttach === undefined ? {} : { onAttach: (file: File) => { onAttach(openId, file) } })}
          {...(onLoadOlder === undefined ? {} : { onLoadOlder: () => { onLoadOlder(openId) } })}
        />
      )
    }
    return (
      <section className={css.page} data-mobile-browse="conversation" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
        <header className={css.header}>
          <button type="button" className={css.back} onClick={closeConversation}>{locale === 'zh' ? '返回' : 'Back'}</button>
          <h1>{openTitle}</h1>
        </header>
        {connectionAlert !== undefined && <p role="alert">{connectionAlert}</p>}
        {detailFailure !== undefined && <p role="alert">{detailFailure.message}</p>}
        <p className={css.summary}>{locale === 'zh' ? '尚未加载此 Session 的对话。' : 'This Session conversation is not loaded.'}</p>
      </section>
    )
  }

  if (screen === 'search') {
    const searchText = locale === 'zh'
      ? {
        title: '搜索', back: '返回项目', field: '搜索 Desktop Sessions', submit: '搜索',
        placeholder: '搜索聊天记录', intro: '输入关键词搜索 Desktop Session 内容。',
      }
      : {
        title: 'Search', back: 'Back to projects', field: 'Search Desktop Sessions', submit: 'Search',
        placeholder: 'Search chat history', intro: 'Search Desktop Session content.',
      }
    return (
      <section className={css.page} data-mobile-browse="search" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
        <BrowseRouteHeader title={searchText.title} backLabel={searchText.back} onBack={closeSearch} />
        <main className={css.routeBody}>
          {connectionAlert !== undefined && <p className={css.error} role="alert">{connectionAlert}</p>}
          {search.status === 'error' && <p className={css.error} role="alert">{search.error.message}</p>}
          <form className={css.searchPanel} onSubmit={(event) => { event.preventDefault(); onSearch?.(searchDraft) }}>
            {searchIcon}
            <input
              autoFocus
              type="search"
              aria-label={searchText.field}
              placeholder={searchText.placeholder}
              value={searchDraft}
              disabled={!canMutate}
              onChange={(event) => { setSearchDraft(event.target.value) }}
            />
            <button type="submit" disabled={!canMutate || searchDraft.trim() === ''}>{searchText.submit}</button>
          </form>
          {search.query === '' && search.status === 'idle'
            ? <p className={css.routeHint}>{searchText.intro}</p>
            : <AuthoritativeSearchResults search={search} locale={locale} onOpen={openSession} />}
        </main>
      </section>
    )
  }

  if (screen === 'creating' && createTarget !== undefined) {
    const createFailure = operationFailure?.operation === 'create' ? operationFailure.failure : undefined
    const createText = locale === 'zh'
      ? {
        title: '新 Session', back: '返回项目', pending: `正在由 Desktop 在 ${createTarget.label} 中创建 Session…`,
        offline: 'Remote Offline，重新连接并同步后才能创建 Session。', retry: '重试创建',
      }
      : {
        title: 'New Session', back: 'Back to projects', pending: `Desktop is creating a Session in ${createTarget.label}…`,
        offline: 'Remote Offline. Reconnect and synchronize before creating a Session.', retry: 'Retry creation',
      }
    return (
      <section className={css.page} data-mobile-browse="creating" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
        <BrowseRouteHeader
          title={createText.title}
          backLabel={createText.back}
          onBack={() => { setCreateTarget(undefined); setScreen('list') }}
        />
        <main className={css.creatingBody}>
          <span className={css.creatingIcon} aria-hidden="true">{composeIcon}</span>
          <p>{canMutate ? createText.pending : createText.offline}</p>
          {createFailure !== undefined && (
            <p className={css.error} role="alert">{companionCreateFailureMessage(locale)}</p>
          )}
          {createFailure !== undefined && (
            <button type="button" disabled={!canMutate} onClick={() => { beginCreate(createTarget) }}>{createText.retry}</button>
          )}
        </main>
      </section>
    )
  }

  return (
    <section className={css.page} data-mobile-browse="list" data-theme={theme} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
      <header className={css.remoteHeader}>
        <button type="button" className={css.account} aria-label={locale === 'zh' ? '查看账号' : 'View account'} onClick={onOpenAccount}>
          {menuIcon}
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
      <main
        className={css.projectList}
        onTouchStart={startPull}
        onTouchMove={movePull}
        onTouchEnd={finishPull}
        onTouchCancel={finishPull}
      >
        {refreshText !== undefined && (
          <div
            className={css.pullRefresh}
            data-refresh-state={refreshState}
            role="status"
            style={{ '--mobile-pull-height': `${String(refreshHeight)}px` } as CSSProperties}
          >
            <span className={refreshState === 'refreshing' ? css.refreshSpinner : css.refreshArrow} aria-hidden="true">↓</span>
            <span>{refreshText}</span>
          </div>
        )}
        {connectionAlert !== undefined && (
          <p className={css.error} role="alert" data-connection-failure={connectionFailure?.code}>{connectionAlert}</p>
        )}
        {search.status === 'error' && <p className={css.error} role="alert">{search.error.message}</p>}
        {operationFailure?.operation === 'refresh'
          && <p className={css.error} role="alert">{operationFailure.failure.message}</p>}
        {cacheFailure !== undefined && <p className={css.error} role="alert">{cacheFailure}</p>}
        {connection === 'unpaired' ? (
          <div className={css.emptyState}>
            <p>{locale === 'zh' ? '扫码连接 Desktop 后即可查看 Session' : 'Pair a Desktop to browse Sessions.'}</p>
          </div>
        ) : (
          <>
            <div className={css.projectTitle}>
              <h1>{locale === 'zh' ? '项目' : 'Projects'}</h1>
            </div>
            {groups.map((group) => {
              const label = group.workspaceId === undefined ? tw('group.ungrouped') : group.label
              const collapsed = collapsedGroups.has(group.key)
              const paged = pageCompanionHistory(
                group.sessions,
                pagesByGroup[group.key] ?? 0,
                COMPANION_HISTORY_PAGE_SIZE,
              )
              return (
                <section key={group.key} className={css.group} aria-label={label}>
                  <header>
                    <button
                      type="button"
                      className={css.projectToggle}
                      aria-expanded={!collapsed}
                      aria-label={locale === 'zh'
                        ? `${collapsed ? '展开' : '收起'} ${label}`
                        : `${collapsed ? 'Expand' : 'Collapse'} ${label}`}
                      onClick={() => {
                        setCollapsedGroups((current) => {
                          const next = new Set(current)
                          if (next.has(group.key)) next.delete(group.key)
                          else next.add(group.key)
                          return next
                        })
                      }}
                    >
                      <span className={css.projectName}>{folderIcon}<h2>{label}</h2></span>
                      <span className={css.disclosure} data-collapsed={collapsed}>{chevronIcon}</span>
                    </button>
                    {onCreate !== undefined && (
                      <button
                        type="button"
                        className={css.compose}
                        aria-label={locale === 'zh' ? `在 ${label} 新建 Session` : `New Session in ${label}`}
                        onClick={() => {
                          beginCreate(group.workspaceId === undefined
                            ? { input: {}, label }
                            : { input: { workspace: group.workspaceId }, label })
                        }}
                      >{composeIcon}</button>
                    )}
                  </header>
                  {!collapsed && (
                    <>
                      <SessionListPresentation
                        label={label}
                        nodes={paged.items}
                        currentId={openId}
                        now={now}
                        onOpen={openSession}
                        t={tw}
                      />
                      {paged.spilled > 0 && (
                        <button
                          type="button"
                          className={css.groupMore}
                          aria-label={locale === 'zh'
                            ? `在 ${label} 加载更多（还有 ${paged.spilled}）`
                            : `Load more in ${label} (${paged.spilled} remaining)`}
                          onClick={() => {
                            setPagesByGroup(current => ({
                              ...current,
                              [group.key]: (current[group.key] ?? 0) + 1,
                            }))
                          }}
                        >
                          <span>{locale === 'zh' ? '加载更多' : 'Load more'}</span>
                          <small>{locale === 'zh' ? `剩余 ${paged.spilled}` : `${paged.spilled} remaining`}</small>
                        </button>
                      )}
                    </>
                  )}
                </section>
              )
            })}
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
                aria-label={locale === 'zh' ? '新建聊天' : 'New chat'}
                onClick={() => { beginCreate({ input: {}, label: tw('group.ungrouped') }) }}
              >{composeIcon}</button>
            )}
          </div>
          <div className={css.dockActions}>
            {onSearch !== undefined && (
              <button
                type="button"
                className={css.searchPill}
                aria-label={locale === 'zh' ? '搜索聊天记录' : 'Search chat history'}
                onClick={() => { setScreen('search') }}
              >{searchIcon}<span>{locale === 'zh' ? '搜索聊天记录' : 'Search chat history'}</span></button>
            )}
            {onCreate !== undefined && (
              <button
                type="button"
                className={css.round}
                aria-label={locale === 'zh' ? '新建 Ungrouped Session' : 'New ungrouped Session'}
                onClick={() => { beginCreate({ input: {}, label: tw('group.ungrouped') }) }}
              >{composeIcon}</button>
            )}
          </div>
        </footer>
      )}
    </section>
  )
}

function BrowseRouteHeader({
  title,
  backLabel,
  onBack,
}: {
  title: string
  backLabel: string
  onBack: () => void
}): ReactNode {
  return (
    <header className={css.routeHeader}>
      <button type="button" className={css.back} aria-label={backLabel} onClick={onBack}>{backIcon}</button>
      <h1>{title}</h1>
      <span aria-hidden="true" />
    </header>
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

function companionCreateFailureMessage(locale: ConversationPresentationLocale): string {
  return locale === 'zh'
    ? '无法创建 Session。目标 Workspace 可能已被删除，请返回后重试。'
    : 'The Session could not be created. The target Workspace may have been removed. Go back and try again.'
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

const menuIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M5 8h14M5 16h10" />
  </svg>
)

const backIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
)

const folderIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v7A2.5 2.5 0 0 1 18.5 18h-13A2.5 2.5 0 0 1 3 15.5v-9Z" />
  </svg>
)

const chevronIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
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
