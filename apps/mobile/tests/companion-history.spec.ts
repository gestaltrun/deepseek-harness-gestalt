// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
  type ConversationSnapshot, type SessionId, type SessionListState, type WorkspaceId, type WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  COMPANION_HISTORY_PAGE_SIZE, pageCompanionHistory,
} from '../src/companion-history.ts'
import { MobileBrowse } from '../src/MobileBrowse.tsx'
import type { MobilePresentationClock } from '../src/mobile-clock.ts'

afterEach(cleanup)

const sid = (value: string): SessionId => value as SessionId
const wid = (value: string): WorkspaceId => value as WorkspaceId
const alphaId = sid('alpha')
const gammaId = sid('gamma')
const workspaceId = wid('work')

const browsePresentation = {
  locale: 'zh' as const,
  theme: 'light' as const,
  loadImage: () => Promise.resolve('data:image/gif;base64,R0lGODlhAQABAAAAACw='),
  canMutate: true,
  clock: fixedClock(10_000),
  search: { query: '', status: 'idle', items: [], hasMore: false } as const,
}

function conversation(): ConversationSnapshot {
  return {
    sessionId: alphaId,
    views: EMPTY_CONVERSATION_VIEWS,
    chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [{ kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: 'hello' }], source: {} }],
    turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [], pending: [], queue: [],
    running: false, subagent: null, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

const sessions: SessionListState = {
  ids: [alphaId, gammaId],
  byId: {
    [alphaId]: {
      id: alphaId, title: 'Alpha', displayTitle: 'Alpha', cwd: '/work',
      running: false, blank: false, updatedAt: 2,
    },
    [gammaId]: {
      id: gammaId, title: 'Gamma', displayTitle: 'Gamma',
      running: false, blank: false, updatedAt: 1,
    },
  },
  current: undefined,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}

const workspaces: readonly WorkspaceView[] = [{
  workspaceId,
  path: '/work',
  title: 'Work',
  sessionIds: [alphaId],
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}]

describe('Mobile Companion browse projection', () => {
  it('updates relative Session time from the subscribed clock owner', () => {
    const clock = mutableClock(5 * 60_000 + 2)
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces,
      conversations: {}, ...browsePresentation, clock,
    }))
    expect(screen.getAllByText('5分钟')).toHaveLength(2)
    act(() => { clock.set(10 * 60_000 + 2) })
    expect(screen.getAllByText('10分钟')).toHaveLength(2)
  })

  it('pages the exact Desktop SessionListState without introducing another row model', () => {
    const ids = Array.from({ length: COMPANION_HISTORY_PAGE_SIZE + 3 }, (_, index) => sid(`id-${String(index)}`))
    const many = { ...sessions, ids }
    expect(pageCompanionHistory(many, workspaces, 0).sessions.ids).toHaveLength(COMPANION_HISTORY_PAGE_SIZE)
    expect(pageCompanionHistory(many, workspaces, 0).spilled).toBe(3)
    expect(pageCompanionHistory(many, workspaces, 1).sessions.ids).toHaveLength(COMPANION_HISTORY_PAGE_SIZE + 3)
    expect(pageCompanionHistory(many, workspaces, 1).spilled).toBe(0)
  })

  it('limits Workspace-owned rows until the user loads the next page', () => {
    const ids = Array.from({ length: COMPANION_HISTORY_PAGE_SIZE + 3 }, (_, index) => sid(`workspace-${String(index)}`))
    const byId = Object.fromEntries(ids.map((id, index) => [id, {
      id,
      title: `Session ${String(index)}`,
      displayTitle: `Session ${String(index)}`,
      cwd: '/work',
      running: false,
      blank: false,
      updatedAt: ids.length - index,
    }]))
    const many: SessionListState = { ...sessions, ids, byId }
    const manyWorkspaces: readonly WorkspaceView[] = [{ ...workspaces[0]!, sessionIds: ids }]

    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions: many, workspaces: manyWorkspaces,
      conversations: {}, ...browsePresentation,
    }))

    expect(screen.getAllByRole('treeitem')).toHaveLength(COMPANION_HISTORY_PAGE_SIZE)
    fireEvent.click(screen.getByRole('button', { name: '加载更多（还有 3）' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(COMPANION_HISTORY_PAGE_SIZE + 3)
  })

  it('uses shared Desktop Session rows and opens authoritative conversations full-screen', () => {
    const onObserveSession = vi.fn()
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces,
      conversations: { [alphaId]: conversation() }, ...browsePresentation, onObserveSession,
    }))
    expect(screen.getByText('Studio Mac')).toBeTruthy()
    expect(screen.getByText('Remote Online')).toBeTruthy()
    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.getByText('未分组')).toBeTruthy()
    const alpha = screen.getByRole('treeitem', { name: /Alpha/ })
    expect(alpha.getAttribute('data-session-row')).toBe(alphaId)
    fireEvent.click(alpha)
    expect(onObserveSession).toHaveBeenLastCalledWith(alphaId)
    expect(screen.getByText('hello')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onObserveSession).toHaveBeenLastCalledWith(undefined)
    fireEvent.click(screen.getByRole('treeitem', { name: /Gamma/ }))
    expect(onObserveSession).toHaveBeenLastCalledWith(gammaId)
    expect(screen.getByText('尚未加载此 Session 的对话。')).toBeTruthy()
  })

  it('opens the authoritative current Session before acknowledging its pending creation selection', async () => {
    const createdId = sid('created-blank')
    const onSessionOpened = vi.fn()
    const onLoadOlder = vi.fn()
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online',
      sessions: {
        ...sessions,
        ids: [...sessions.ids, createdId],
        byId: {
          ...sessions.byId,
          [createdId]: {
            id: createdId, title: 'Created blank', displayTitle: 'Created blank',
            running: false, blank: true, updatedAt: 3,
          },
        },
        current: createdId,
      },
      workspaces,
      conversations: {},
      ...browsePresentation,
      onSessionOpened,
      onLoadOlder,
    }))

    await screen.findByRole('heading', { name: 'Created blank' })
    await waitFor(() => { expect(onSessionOpened).toHaveBeenCalledWith(createdId) })
    expect(onLoadOlder).toHaveBeenCalledWith(createdId)
  })

  it('keeps a correlated operation failure visible in the opened conversation', () => {
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces,
      conversations: { [alphaId]: conversation() }, ...browsePresentation,
      operationFailure: {
        operationId: 'history-alpha' as never,
        operation: 'history',
        sessionId: alphaId,
        failure: { kind: 'business', code: 'history-refused', message: 'Desktop rejected history' },
      },
    }))

    fireEvent.click(screen.getByRole('treeitem', { name: /Alpha/ }))
    expect(screen.getByRole('alert').textContent).toContain('Desktop rejected history')
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(screen.getByRole('treeitem', { name: /Gamma/ }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['COMPANION_UPDATE_REQUIRED', 'zh', 'mobile', '请升级 Mobile 后再连接此 Desktop。'],
    ['COMPANION_UPDATE_REQUIRED', 'zh', 'desktop', '请升级 Desktop 后再从 Mobile 连接。'],
    ['COMPANION_UPDATE_REQUIRED', 'en', 'mobile', 'Update Mobile to connect to this Desktop.'],
    ['COMPANION_UPDATE_REQUIRED', 'en', 'desktop', 'Update Desktop to connect from this Mobile.'],
    ['COMPANION_SECURITY_CAPABILITY_MISSING', 'zh', 'mobile', '请升级 Mobile 后再连接此 Desktop。'],
    ['COMPANION_SECURITY_CAPABILITY_MISSING', 'zh', 'desktop', '请升级 Desktop 后再从 Mobile 连接。'],
    ['COMPANION_SECURITY_CAPABILITY_MISSING', 'en', 'mobile', 'Update Mobile to connect to this Desktop.'],
    ['COMPANION_SECURITY_CAPABILITY_MISSING', 'en', 'desktop', 'Update Desktop to connect from this Mobile.'],
  ] as const)('renders an explicit %s %s %s requirement', (code, locale, updateEndpoint, expected) => {
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'offline', sessions, workspaces, conversations: {},
      ...browsePresentation, locale,
      connectionFailure: {
        code,
        message: `${updateEndpoint} update required`,
        updateEndpoint,
      },
    }))

    expect(screen.getByRole('alert').textContent).toBe(expected)
  })

  it.each([
    ['zh', 5_000, 'Platform 当前容量已满，将在 5 秒后重试。'],
    ['zh', 1_500, 'Platform 当前容量已满，将在 1.5 秒后重试。'],
    ['en', 5_000, 'Platform capacity is full. Retrying in 5 seconds.'],
    ['en', 1_000, 'Platform capacity is full. Retrying in 1 second.'],
    ['zh', undefined, 'Platform 当前容量已满，正在重试。'],
    ['en', undefined, 'Platform capacity is full. Retrying.'],
  ] as const)('renders %s Platform capacity retry timing %s', (locale, retryAfterMs, expected) => {
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'offline', sessions, workspaces, conversations: {},
      ...browsePresentation, locale,
      connectionFailure: {
        code: 'PLATFORM_CAPACITY', message: 'Remote Relay returned PLATFORM_CAPACITY',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    }))

    expect(screen.getByRole('alert').textContent).toBe(expected)
  })

  it('targets real Workspace ids and disables creation before foreground synchronization', () => {
    const onCreate = vi.fn()
    const view = render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces, conversations: {},
      ...browsePresentation, onCreate,
    }))
    fireEvent.click(screen.getByRole('button', { name: '在 Work 新建 Session' }))
    fireEvent.click(screen.getByRole('button', { name: '新建 Ungrouped Session' }))
    expect(onCreate).toHaveBeenNthCalledWith(1, { workspace: workspaceId })
    expect(onCreate).toHaveBeenNthCalledWith(2, {})

    view.rerender(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces, conversations: {},
      ...browsePresentation, canMutate: false, onCreate,
    }))
    expect(screen.getByRole('button', { name: '在 Work 新建 Session' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '新建 Ungrouped Session' }).hasAttribute('disabled')).toBe(true)
  })

  it('renders Desktop-authoritative hits even when the Companion Cache lacks the Session', () => {
    const onSearch = vi.fn()
    const onLoadOlder = vi.fn()
    const { rerender } = render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces, conversations: {},
      ...browsePresentation,
      search: {
        query: 'needle',
        status: 'ready',
        items: [
          { sessionId: 'alpha' as never, snippet: 'Desktop indexed needle' },
          { sessionId: 's-uncached' as never, snippet: 'Authoritative uncached needle' },
        ],
        hasMore: false,
      },
      onSearch,
      onLoadOlder,
    }))
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Desktop indexed needle')).toBeTruthy()
    expect(screen.getByText('Authoritative uncached needle')).toBeTruthy()
    expect(screen.getByText('s-uncached')).toBeTruthy()
    expect(screen.queryByText('needle in local title')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /s-uncached/u }))
    expect(onLoadOlder).toHaveBeenCalledWith('s-uncached')
    expect(screen.getByRole('heading', { name: 's-uncached' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 Desktop Sessions' }), {
      target: { value: 'next query' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(onSearch).toHaveBeenCalledWith('next query')

    rerender(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces, conversations: {},
      ...browsePresentation,
      search: {
        query: 'bad request',
        status: 'error',
        items: [],
        hasMore: false,
        error: {
          kind: 'http', code: 'HOST_HTTP_STATUS', message: 'Desktop Host returned HTTP 400', status: 400,
        },
      },
      onSearch,
      onLoadOlder,
    }))
    expect(screen.getByRole('alert').textContent).toContain('HTTP 400')
  })

  it('renders authoritative search controls and status entirely in English', () => {
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac', connection: 'online', sessions, workspaces, conversations: {},
      ...browsePresentation,
      locale: 'en',
      search: {
        query: 'needle', status: 'loading', items: [], hasMore: true,
      },
      onSearch: vi.fn(),
    }))

    expect(screen.getByRole('searchbox', { name: 'Search Desktop Sessions' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Desktop search results' })).toBeTruthy()
    expect(screen.getByText('Searching Desktop Session content…')).toBeTruthy()
    expect(screen.getByText('More results are available. Narrow the search.')).toBeTruthy()
    expect(screen.queryByText(/搜索|正在|结果较多/u)).toBeNull()
  })
})

function fixedClock(now: number): MobilePresentationClock {
  return { getSnapshot: () => now, subscribe: () => () => {} }
}

function mutableClock(initial: number): MobilePresentationClock & { set(now: number): void } {
  let now = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => now,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { now = next; for (const listener of listeners) listener() },
  }
}
