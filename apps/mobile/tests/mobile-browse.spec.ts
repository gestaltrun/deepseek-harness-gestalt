/** Mobile Session-browser gesture coverage. */
// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CHAT_SNAPSHOT,
  EMPTY_CONVERSATION_VIEWS,
  type ConversationSnapshot,
  type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { MobileBrowse } from '../src/MobileBrowse.tsx'
import { fixedMobilePresentationClock } from '../src/mobile-clock.ts'

afterEach(cleanup)

const sessions = {
  ids: [],
  byId: {},
  current: undefined,
  phase: 'ready' as const,
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}

const search = { query: '', status: 'idle', items: [], hasMore: false } as const
const attachmentSessionId = 'session-attachment' as SessionId
const attachmentSessions = {
  ...sessions,
  ids: [attachmentSessionId],
  byId: {
    [attachmentSessionId]: {
      id: attachmentSessionId,
      title: 'Attachment',
      displayTitle: 'Attachment',
      running: false,
      blank: false,
      updatedAt: 1,
    },
  },
  current: attachmentSessionId,
}
const attachmentConversation: ConversationSnapshot = {
  sessionId: attachmentSessionId,
  views: EMPTY_CONVERSATION_VIEWS,
  chat: EMPTY_CHAT_SNAPSHOT,
  nodes: [],
  turnTimings: new Map(),
  turnEnds: new Map(),
  partial: null,
  runningCalls: [],
  pending: [],
  queue: [],
  running: false,
  subagent: null,
  composerPhase: 'active',
  removed: false,
  openState: 'open',
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
}

describe('Mobile Session browser', () => {
  it('pulls the empty Session list to refresh its selected Desktop projection', async () => {
    const onRefresh = vi.fn()
    const props = {
      desktopName: 'Paired Desktop',
      connection: 'online',
      onOpenAccount: () => {},
      sessions,
      workspaces: [],
      conversations: {},
      locale: 'en',
      theme: 'light',
      loadImage: async () => '',
      canMutate: true,
      clock: fixedMobilePresentationClock(0),
      search,
      onRefresh,
    } as const
    const view = render(createElement(MobileBrowse, props))
    const page = screen.getByRole('main')

    fireEvent.touchStart(page, { touches: [{ clientY: 20 }] })
    fireEvent.touchMove(page, { touches: [{ clientY: 108 }] })
    expect(screen.getByRole('status').textContent).toContain('Release to refresh')
    fireEvent.touchEnd(page, { changedTouches: [{ clientY: 108 }] })

    expect(onRefresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('Refreshing…')
    view.rerender(createElement(MobileBrowse, { ...props, sessions: { ...sessions } }))
    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull() })
  })

  it('explains that an offline Desktop cannot refill a cleared cache', () => {
    const onRefresh = vi.fn()
    render(createElement(MobileBrowse, {
      desktopName: 'Paired Desktop',
      connection: 'offline',
      onOpenAccount: () => {},
      sessions,
      workspaces: [],
      conversations: {},
      locale: 'en',
      theme: 'light',
      loadImage: async () => '',
      canMutate: false,
      clock: fixedMobilePresentationClock(0),
      search,
      onRefresh,
    }))
    const page = screen.getByRole('main')

    fireEvent.touchStart(page, { touches: [{ clientY: 20 }] })
    fireEvent.touchMove(page, { touches: [{ clientY: 108 }] })
    fireEvent.touchEnd(page, { changedTouches: [{ clientY: 108 }] })

    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent)
      .toContain('Remote Offline. Reconnect before refreshing.')
  })

  it('retains a native picker file across detail remount until foreground synchronization returns', async () => {
    const onAttach = vi.fn()
    const file = new File([Uint8Array.of(7, 6, 5)], 'foreground.png', { type: 'image/png' })
    const props = {
      desktopName: 'Paired Desktop',
      connection: 'online' as const,
      onOpenAccount: () => {},
      sessions: attachmentSessions,
      workspaces: [],
      conversations: { [attachmentSessionId]: attachmentConversation },
      locale: 'zh' as const,
      theme: 'light' as const,
      loadImage: async () => '',
      canMutate: true,
      clock: fixedMobilePresentationClock(0),
      search,
      onSubmit: () => {},
      onAttach,
    }
    const view = render(createElement(MobileBrowse, props))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '添加附件' }).hasAttribute('disabled')).toBe(false)
    })
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('expected attachment file input')

    view.rerender(createElement(MobileBrowse, { ...props, canMutate: false }))
    fireEvent.change(input, { target: { files: [file] } })
    view.rerender(createElement(MobileBrowse, { ...props, canMutate: false, conversations: {} }))
    expect(onAttach).not.toHaveBeenCalled()

    view.rerender(createElement(MobileBrowse, { ...props, canMutate: true }))
    await waitFor(() => {
      expect(onAttach).toHaveBeenCalledWith(attachmentSessionId, file)
    })
  })

  it('drops a pending native picker file when the user leaves the conversation', async () => {
    const onAttach = vi.fn()
    const file = new File([Uint8Array.of(4)], 'abandoned.png', { type: 'image/png' })
    const props = {
      desktopName: 'Paired Desktop',
      connection: 'online' as const,
      onOpenAccount: () => {},
      sessions: attachmentSessions,
      workspaces: [],
      conversations: { [attachmentSessionId]: attachmentConversation },
      locale: 'zh' as const,
      theme: 'light' as const,
      loadImage: async () => '',
      canMutate: false,
      clock: fixedMobilePresentationClock(0),
      search,
      onSubmit: () => {},
      onAttach,
    }
    const view = render(createElement(MobileBrowse, props))
    await waitFor(() => { expect(screen.queryByRole('button', { name: '返回' })).not.toBeNull() })
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('expected attachment file input')
    fireEvent.change(input, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    view.rerender(createElement(MobileBrowse, { ...props, canMutate: true }))
    expect(onAttach).not.toHaveBeenCalled()
  })
})
