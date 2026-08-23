// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  BrowserPageState,
  BrowserScreenshot,
  BrowserTarget,
  BrowserWorkspaceProjection,
} from '@deepseek-ai/dsh-browser-workspace/client'
import { BrowserPreview, type BrowserPreviewProps } from '../src/client/BrowserPreview.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const TARGET: BrowserTarget = {
  profileId: 'profile-1' as BrowserTarget['profileId'],
  workspaceId: 'ws-1' as BrowserTarget['workspaceId'],
  browserId: 'br-1' as BrowserTarget['browserId'],
  tabId: 'tab-1' as BrowserTarget['tabId'],
}

const BACK: BrowserTarget = { ...TARGET, tabId: 'tab-0' as BrowserTarget['tabId'] }

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function page(): BrowserPageState {
  return {
    status: 'open',
    target: TARGET,
    revision: 3,
    url: 'https://alpha.test/',
    title: 'Alpha',
    text: 'page text',
    focused: true,
    chrome: { kind: 'temporary', partition: 'tmp' },
    storage: {
      cookies: 'c', localStorage: 'l', indexedDb: 'i', cache: 'k', serviceWorker: 's',
    },
  }
}

function snapshot(overrides: Partial<BrowserWorkspaceProjection> = {}): BrowserWorkspaceProjection {
  return {
    activeWorkspaceId: TARGET.workspaceId,
    workspaces: [{
      workspaceId: TARGET.workspaceId,
      profileId: TARGET.profileId,
      activeBrowserId: TARGET.browserId,
      browsers: [{
        browserId: TARGET.browserId,
        activeTabId: TARGET.tabId,
        tabs: [
          { tabId: BACK.tabId, revision: 2 },
          { tabId: TARGET.tabId, revision: 3 },
        ],
      }],
    }],
    ...overrides,
  }
}

function props(current: BrowserWorkspaceProjection | null | undefined = snapshot()): BrowserPreviewProps {
  const open = page()
  return {
    useProjection: () => current,
    reveal: vi.fn(),
    focus: vi.fn().mockResolvedValue(open),
    observe: vi.fn().mockResolvedValue(open),
    screenshot: vi.fn().mockResolvedValue({
      target: TARGET, revision: 3, url: open.url, title: open.title, mediaType: 'image/png', data: PNG,
    } satisfies BrowserScreenshot),
    t: makeTranslate(zh),
  } as unknown as BrowserPreviewProps
}

describe('BrowserPreview occupancy', () => {
  it('renders nothing without tabs and paints whenever pages exist', async () => {
    expect(render(<BrowserPreview {...props(null)} />).container.firstChild).toBeNull()
    cleanup()
    const input = props(snapshot())
    render(<BrowserPreview {...input} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '展开 Alpha' })).toBeTruthy()
    })
  })

  it('opens the current layer and focuses a back layer', async () => {
    const input = props()
    render(<BrowserPreview {...input} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '展开 Alpha' })).toBeTruthy()
    })
    expect(screen.getByText('Alpha · alpha.test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '展开 Alpha' }))
    expect(input.reveal).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '切换到 Alpha' }))
    expect(input.focus).toHaveBeenCalledWith(BACK, 2)
  })

  it('observes once and retries a back-layer focus after a listed-revision conflict', async () => {
    const input = props()
    const healed = page()
    input.focus = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('browser revision conflict: expected 2, current 3'), {
        code: 'BROWSER_REVISION_CONFLICT',
      }))
      .mockResolvedValueOnce(healed)
    input.observe = vi.fn().mockResolvedValue({ ...healed, target: BACK, revision: 3 })
    render(<BrowserPreview {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '切换到 无标题' }))
    await waitFor(() => {
      expect(input.focus).toHaveBeenCalledTimes(2)
    })
    expect(input.observe).toHaveBeenCalledWith(BACK)
    expect(input.focus).toHaveBeenLastCalledWith(BACK, 3)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces a back-layer focus that stays failed after observe and retry', async () => {
    const input = props()
    input.focus = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('BROWSER_REVISION_CONFLICT'), {
        code: 'BROWSER_REVISION_CONFLICT',
      }))
      .mockRejectedValueOnce(new Error('still stale'))
    input.observe = vi.fn().mockResolvedValue({ ...page(), target: BACK, revision: 4 })
    render(<BrowserPreview {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '切换到 无标题' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('无法完成该操作')
    })
  })

  it('focuses a back layer from the listing revision before observe settles', () => {
    const input = props()
    input.observe = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<BrowserPreview {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '切换到 无标题' }))
    expect(input.focus).toHaveBeenCalledWith(BACK, 2)
  })
})
