// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  BrowserPageState,
  BrowserScreenshot,
  BrowserTarget,
} from '@deepseek-ai/dsh-browser-workspace/client'
import { BrowserPageChrome, type BrowserPageChromeProps } from '../src/client/BrowserPageChrome.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

const TARGET: BrowserTarget = {
  profileId: 'profile-1' as BrowserTarget['profileId'],
  workspaceId: 'ws-1' as BrowserTarget['workspaceId'],
  browserId: 'br-1' as BrowserTarget['browserId'],
  tabId: 'tab-1' as BrowserTarget['tabId'],
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function page(overrides: Partial<BrowserPageState> = {}): BrowserPageState {
  return {
    status: 'open',
    target: TARGET,
    revision: 4,
    url: 'https://alpha.test/path',
    title: 'Alpha',
    text: 'page text',
    focused: true,
    chrome: { kind: 'persistent', name: 'work' as never, partition: 'persist:work' },
    storage: {
      cookies: 'c', localStorage: 'l', indexedDb: 'i', cache: 'k', serviceWorker: 's',
    },
    ...overrides,
  }
}

function shot(): BrowserScreenshot {
  return {
    target: TARGET, revision: 4, url: 'https://alpha.test/path', title: 'Alpha',
    mediaType: 'image/png', data: PNG,
  }
}

function props(options: {
  target?: BrowserTarget | undefined
  page?: BrowserPageState | undefined
  screenshot?: BrowserScreenshot | undefined
} = {}): BrowserPageChromeProps {
  const current = options.page === undefined && !('page' in options) ? page() : options.page
  return {
    target: options.target === undefined && !('target' in options) ? TARGET : options.target,
    listedRevision: 4,
    refresh: vi.fn().mockResolvedValue(current ?? page()),
    observe: vi.fn().mockResolvedValue(current ?? { status: 'closed', target: TARGET, revision: 0 }),
    screenshot: vi.fn().mockResolvedValue(options.screenshot ?? shot()),
    t: makeTranslate(zh),
  }
}

describe('BrowserPageChrome', () => {
  it('shows a creating placeholder without a target', () => {
    render(<BrowserPageChrome {...props({ target: undefined })} />)
    expect(screen.getByText('正在创建页面')).toBeTruthy()
  })

  it('shows title, persistent Profile, screenshot, and page text', async () => {
    render(<BrowserPageChrome {...props()} />)
    await waitFor(() => {
      expect(screen.getByAltText('Alpha')).toBeTruthy()
    })
    expect(screen.getByText('work')).toBeTruthy()
    expect(screen.getByDisplayValue('https://alpha.test/path')).toBeTruthy()
    expect(document.querySelector('[data-browser-viewport]')).toBeTruthy()
    expect(screen.queryByText('page text')).toBeNull()
    expect(screen.queryByRole('button', { name: '接管' })).toBeNull()
    expect(screen.queryByRole('button', { name: '交还智能体' })).toBeNull()
  })

  it('refreshes from the Runtime page', async () => {
    const input = props()
    render(<BrowserPageChrome {...input} />)
    await waitFor(() => { expect(screen.getByDisplayValue('https://alpha.test/path')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(input.refresh).toHaveBeenCalledWith(TARGET, 4, 'https://alpha.test/path')
    })
  })

  it('notifies the parent when an open page settles', async () => {
    const onCommittedPage = vi.fn()
    render(<BrowserPageChrome {...props()} onCommittedPage={onCommittedPage} />)
    await waitFor(() => {
      expect(onCommittedPage).toHaveBeenCalled()
    })
  })

  it('stops after a conflict retry observes a closed tab', async () => {
    const input = props()
    let observes = 0
    input.observe = vi.fn(async () => {
      observes += 1
      if (observes >= 3) return { status: 'closed' as const, target: TARGET, revision: 6 }
      return page({ revision: 5 })
    })
    input.refresh = vi.fn().mockRejectedValue(Object.assign(new Error('BROWSER_REVISION_CONFLICT'), {
      code: 'BROWSER_REVISION_CONFLICT',
    }))
    render(<BrowserPageChrome {...input} />)
    await waitFor(() => { expect(screen.getByDisplayValue('https://alpha.test/path')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(input.refresh).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retries navigate after a revision conflict', async () => {
    const input = props()
    input.observe = vi.fn().mockResolvedValue(page({ revision: 5 }))
    input.refresh = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('browser revision conflict: expected 5, current 6'), {
        code: 'BROWSER_REVISION_CONFLICT',
      }))
      .mockResolvedValueOnce(page({ revision: 7 }))
    render(<BrowserPageChrome {...input} />)
    await waitFor(() => { expect(screen.getByDisplayValue('https://alpha.test/path')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(input.refresh).toHaveBeenCalledTimes(2)
    })
    expect(input.refresh).toHaveBeenLastCalledWith(TARGET, 5, 'https://alpha.test/path')
  })

  it('keeps the screenshot under the live viewport hole', async () => {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
      browserPresent: vi.fn(),
      browserConceal: vi.fn(),
    }
    render(<BrowserPageChrome {...props()} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('https://alpha.test/path')).toBeTruthy()
    })
    expect(screen.getByRole('img')).toBeTruthy()
    expect(document.querySelector('[data-browser-live]')).toBeTruthy()
    delete (globalThis as { dshDesktop?: unknown }).dshDesktop
  })

  it('navigates when the address form is submitted', async () => {
    const input = props()
    render(<BrowserPageChrome {...input} />)
    const field = await waitFor(() => screen.getByRole('textbox', { name: '地址' }))
    fireEvent.change(field, { target: { value: 'example.com' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => {
      expect(input.refresh).toHaveBeenCalledWith(TARGET, 4, 'https://example.com/')
    })
  })

  it('rejects a draft that is not a page URL', async () => {
    const input = props()
    render(<BrowserPageChrome {...input} />)
    const field = await waitFor(() => screen.getByRole('textbox', { name: '地址' }))
    fireEvent.change(field, { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('无法打开该地址')
    })
    expect(input.refresh).not.toHaveBeenCalled()
  })

  it('shows page text only when no screenshot is painted', async () => {
    const input = props()
    input.screenshot = vi.fn().mockResolvedValue(undefined)
    render(<BrowserPageChrome {...input} />)
    await waitFor(() => {
      expect(screen.getByText('page text')).toBeTruthy()
    })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('hides an about:blank screenshot', async () => {
    const blank = page({
      url: 'about:blank',
      title: 'New Tab',
      text: '',
      chrome: { kind: 'temporary', partition: 'tmp' },
    })
    render(<BrowserPageChrome {...props({
      page: blank,
      screenshot: { ...shot(), url: 'about:blank', title: 'New Tab' },
    })} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('about:blank')).toBeTruthy()
    })
    expect(screen.getByText('输入地址并回车')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('keeps occupancy when observe rejects', async () => {
    const input = props({ page: undefined })
    input.observe = vi.fn().mockRejectedValue(new Error('no session'))
    render(<BrowserPageChrome {...input} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('没有打开的页面')).toBeTruthy()
  })

  it('refreshes from the Runtime page instead of stale about:blank chrome', async () => {
    const blank = page({
      revision: 0,
      url: 'about:blank',
      title: 'New Tab',
      text: '',
      chrome: { kind: 'temporary', partition: 'tmp' },
    })
    const navigated = page({
      revision: 1,
      url: 'https://example.com/',
      title: 'Example Domain',
      text: 'Example Domain',
      chrome: { kind: 'temporary', partition: 'tmp' },
    })
    const input = props({ page: blank })
    input.observe = vi.fn()
      .mockResolvedValueOnce(blank)
      .mockResolvedValueOnce(navigated)
    input.refresh = vi.fn().mockResolvedValue(navigated)
    render(<BrowserPageChrome {...input} listedRevision={0} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('about:blank')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(input.refresh).toHaveBeenCalledWith(TARGET, 1, 'https://example.com/')
    })
    expect(input.refresh).not.toHaveBeenCalledWith(TARGET, 0, 'about:blank')
  })

  it('keeps occupancy when refresh observe rejects or the tab closed', async () => {
    const blank = page({
      revision: 0,
      url: 'about:blank',
      title: 'New Tab',
      text: '',
      chrome: { kind: 'temporary', partition: 'tmp' },
    })
    const rejected = props({ page: blank })
    rejected.observe = vi.fn()
      .mockResolvedValueOnce(blank)
      .mockRejectedValueOnce(new Error('session closed'))
    render(<BrowserPageChrome {...rejected} listedRevision={0} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('about:blank')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await act(async () => { await Promise.resolve() })
    expect(rejected.refresh).not.toHaveBeenCalled()
    cleanup()

    const closed = props({ page: blank })
    closed.observe = vi.fn()
      .mockResolvedValueOnce(blank)
      .mockResolvedValueOnce({ status: 'closed', target: TARGET, revision: 0 })
    render(<BrowserPageChrome {...closed} listedRevision={0} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('about:blank')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await act(async () => { await Promise.resolve() })
    expect(closed.refresh).not.toHaveBeenCalled()
  })

  it('surfaces a navigate that fails', async () => {
    const input = props()
    input.refresh = vi.fn().mockRejectedValue(new Error('tab closed'))
    render(<BrowserPageChrome {...input} />)
    await waitFor(() => { expect(screen.getByDisplayValue('https://alpha.test/path')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('无法完成该操作')
    })
  })

  it('does not navigate from the address bar before observe settles', () => {
    const input = props({ page: undefined, screenshot: undefined })
    input.observe = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<BrowserPageChrome {...input} />)
    const field = screen.getByRole('textbox', { name: '地址' })
    fireEvent.change(field, { target: { value: 'example.com' } })
    fireEvent.submit(field.closest('form')!)
    expect(input.refresh).not.toHaveBeenCalled()
  })

  it('does not refresh while observe has not settled', () => {
    const input = props({ page: undefined, screenshot: undefined })
    input.observe = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<BrowserPageChrome {...input} />)
    expect(screen.getByText('没有打开的页面')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '正在刷新' }))
    expect(input.refresh).not.toHaveBeenCalled()
  })

  it('marks the refresh control busy while observe or navigate is in flight', async () => {
    let settleObserve!: (value: BrowserPageState) => void
    const input = props()
    input.observe = vi.fn().mockReturnValue(new Promise((resolve) => { settleObserve = resolve }))
    render(<BrowserPageChrome {...input} />)
    const pending = screen.getByRole('button', { name: '正在刷新' })
    expect(pending.getAttribute('aria-busy')).toBe('true')
    expect(pending.getAttribute('data-busy')).toBe('true')
    await act(async () => { settleObserve(page()) })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBeNull()
    })

    let settleRefresh!: (value: BrowserPageState) => void
    input.refresh = vi.fn().mockReturnValue(new Promise((resolve) => { settleRefresh = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '正在刷新' }).getAttribute('aria-busy')).toBe('true')
    })
    await act(async () => { settleRefresh(page()) })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBeNull()
    })
  })
})
