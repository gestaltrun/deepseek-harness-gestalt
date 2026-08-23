// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type {
  BrowserPageState,
  BrowserRuntimeState,
  BrowserScreenshot,
  BrowserTarget,
} from '@deepseek-ai/dsh-browser-workspace/client'
import { useBrowserPage } from '../src/client/use-browser-page.ts'

afterEach(cleanup)

const TARGET: BrowserTarget = {
  profileId: 'profile-1' as BrowserTarget['profileId'],
  workspaceId: 'ws-1' as BrowserTarget['workspaceId'],
  browserId: 'br-1' as BrowserTarget['browserId'],
  tabId: 'tab-1' as BrowserTarget['tabId'],
}

function page(overrides: Partial<BrowserPageState> = {}): BrowserPageState {
  return {
    status: 'open',
    target: TARGET,
    revision: 1,
    url: 'https://alpha.test/',
    title: 'Alpha',
    text: 'text',
    focused: true,
    chrome: { kind: 'temporary', partition: 'tmp' },
    storage: {
      cookies: 'c', localStorage: 'l', indexedDb: 'i', cache: 'k', serviceWorker: 's',
    },
    ...overrides,
  }
}

function Probe(props: {
  target?: BrowserTarget
  listedRevision?: number
  observe: (target: BrowserTarget) => Promise<BrowserRuntimeState>
  screenshot: (target: BrowserTarget) => Promise<BrowserScreenshot>
}) {
  const facts = useBrowserPage(props.target, props.observe, props.screenshot, props.listedRevision)
  return (
    <div>
      <span data-testid="title">{facts.page?.title ?? 'none'}</span>
      <span data-testid="url">{facts.page?.url ?? 'none'}</span>
      <span data-testid="shot">{facts.screenshot === undefined ? 'none' : 'yes'}</span>
    </div>
  )
}

describe('useBrowserPage', () => {
  it('clears facts without a target and ignores a cancelled load', async () => {
    const observe = vi.fn(async () => page())
    const screenshot = vi.fn(async () => ({
      target: TARGET, revision: 1, url: 'https://alpha.test/', title: 'Alpha',
      mediaType: 'image/png' as const, data: 'abc',
    }))
    const view = render(<Probe observe={observe} screenshot={screenshot} />)
    expect(view.getByTestId('title').textContent).toBe('none')
    view.rerender(<Probe target={TARGET} observe={observe} screenshot={screenshot} />)
    await waitFor(() => { expect(view.getByTestId('title').textContent).toBe('Alpha') })
    expect(view.getByTestId('shot').textContent).toBe('yes')
    view.rerender(<Probe observe={observe} screenshot={screenshot} />)
    expect(view.getByTestId('title').textContent).toBe('none')
  })

  it('discards a late observe after unmount', async () => {
    let resolveObserve: ((value: BrowserPageState) => void) | undefined
    const observe = vi.fn(() => new Promise<BrowserPageState>((resolve) => { resolveObserve = resolve }))
    const screenshot = vi.fn(async () => ({
      target: TARGET, revision: 1, url: 'https://alpha.test/', title: 'Alpha',
      mediaType: 'image/png' as const, data: 'abc',
    }))
    const view = render(<Probe target={TARGET} observe={observe} screenshot={screenshot} />)
    await waitFor(() => { expect(observe).toHaveBeenCalled() })
    view.unmount()
    resolveObserve?.(page())
    await Promise.resolve()
    expect(screenshot).not.toHaveBeenCalled()
  })

  it('discards a late screenshot after unmount', async () => {
    let resolveShot: ((value: BrowserScreenshot) => void) | undefined
    const observe = vi.fn(async () => page())
    const screenshot = vi.fn(() => new Promise<BrowserScreenshot>((resolve) => { resolveShot = resolve }))
    const view = render(<Probe target={TARGET} observe={observe} screenshot={screenshot} />)
    await waitFor(() => { expect(screenshot).toHaveBeenCalled() })
    view.unmount()
    resolveShot?.({
      target: TARGET, revision: 1, url: 'https://alpha.test/', title: 'Alpha',
      mediaType: 'image/png', data: 'abc',
    })
    await Promise.resolve()
    expect(view.queryByTestId('title')).toBeNull()
  })

  it('re-observes when the listing revision advances on the same tab', async () => {
    const observe = vi.fn()
      .mockResolvedValueOnce(page({ revision: 0, url: 'about:blank', title: 'New Tab' }))
      .mockResolvedValueOnce(page())
    const screenshot = vi.fn()
      .mockResolvedValueOnce({
        target: TARGET, revision: 0, url: 'about:blank', title: 'New Tab',
        mediaType: 'image/png' as const, data: 'blank',
      })
      .mockResolvedValueOnce({
        target: TARGET, revision: 1, url: 'https://alpha.test/', title: 'Alpha',
        mediaType: 'image/png' as const, data: 'abc',
      })
    const view = render(
      <Probe target={TARGET} listedRevision={0} observe={observe} screenshot={screenshot} />,
    )
    await waitFor(() => { expect(view.getByTestId('url').textContent).toBe('about:blank') })
    view.rerender(
      <Probe target={TARGET} listedRevision={1} observe={observe} screenshot={screenshot} />,
    )
    await waitFor(() => { expect(view.getByTestId('url').textContent).toBe('https://alpha.test/') })
    expect(view.getByTestId('title').textContent).toBe('Alpha')
    expect(observe).toHaveBeenCalledTimes(2)
  })

  it('discards a screenshot rejection after the tab unmounted', async () => {
    const observe = vi.fn(async () => page())
    const viewRef: { current?: ReturnType<typeof render> } = {}
    const screenshot = vi.fn(() => {
      viewRef.current?.unmount()
      return Promise.reject(new Error('capture failed'))
    })
    const view = render(<Probe target={TARGET} observe={observe} screenshot={screenshot} />)
    viewRef.current = view
    await waitFor(() => { expect(screenshot).toHaveBeenCalled() })
    expect(view.queryByTestId('title')).toBeNull()
  })

  it('keeps the observed page when the screenshot rejects', async () => {
    const observe = vi.fn(async () => page())
    const screenshot = vi.fn(async () => {
      throw new Error('capture failed')
    })
    const view = render(<Probe target={TARGET} observe={observe} screenshot={screenshot} />)
    await waitFor(() => { expect(view.getByTestId('title').textContent).toBe('Alpha') })
    expect(view.getByTestId('url').textContent).toBe('https://alpha.test/')
    expect(view.getByTestId('shot').textContent).toBe('none')
  })

  it('skips the screenshot when the tab is closed', async () => {
    const observe = vi.fn(async () => ({ status: 'closed' as const, target: TARGET, revision: 0 }))
    const screenshot = vi.fn(async () => {
      throw new Error('screenshot must not run')
    })
    const view = render(<Probe target={TARGET} observe={observe} screenshot={screenshot} />)
    await waitFor(() => { expect(view.getByTestId('title').textContent).toBe('none') })
    expect(screenshot).not.toHaveBeenCalled()
  })
})
