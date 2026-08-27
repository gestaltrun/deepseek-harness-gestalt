/** Mobile Session-browser gesture coverage. */
// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
