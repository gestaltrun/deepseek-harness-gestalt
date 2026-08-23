// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BrowserPageState, BrowserScreenshot, BrowserTarget, BrowserWorkspaceProjection,
} from '@deepseek-ai/dsh-browser-workspace/client'
import { OfficialBrowserTab } from '../src/client/OfficialBrowserTab.tsx'
import { officialTabMeta } from '../src/official-tab-meta.ts'

const SESSION = 's1' as SessionId
const TARGET: BrowserTarget = {
  profileId: 'p' as BrowserTarget['profileId'],
  workspaceId: 'w' as BrowserTarget['workspaceId'],
  browserId: 'b' as BrowserTarget['browserId'],
  tabId: 't' as BrowserTarget['tabId'],
}

function page(title = 'Example'): BrowserPageState {
  return {
    status: 'open',
    target: TARGET,
    revision: 3,
    url: 'https://example.test/',
    title,
    text: 'body',
    focused: true,
    chrome: { kind: 'shared', name: 'shared' as never, partition: 'persist:shared' },
    storage: { cookies: '', localStorage: '', indexedDb: '', cache: '', serviceWorker: '' },
  }
}

function bench({
  overlay = false,
  noSessions = false,
  noLocale = false,
  noSidebar = false,
  noRemote = false,
  title = 'Example',
  projection,
}: {
  overlay?: boolean
  noSessions?: boolean
  noLocale?: boolean
  noSidebar?: boolean
  noRemote?: boolean
  title?: string
  projection?: BrowserWorkspaceProjection
} = {}) {
  if (overlay) document.documentElement.setAttribute('data-dsh-desktop-overlay', '')
  const ctx = new Context()
  const current = page(title)
  const updateTab = vi.fn()
  const ensureOfficial = vi.fn()
  const observe = vi.fn(async () => ({ ok: true as const, value: current }))
  const screenshot = vi.fn(async () => ({
    ok: true as const,
    value: {
      target: TARGET,
      revision: current.revision,
      url: current.url,
      title: current.title,
      mediaType: 'image/png',
      data: 'png',
    } satisfies BrowserScreenshot,
  }))
  if (!noSessions) {
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ byId: { [SESSION]: { projectionValues: { browserWorkspace: projection } } } }),
        subscribe: () => () => {},
      },
    })
  }
  if (!noLocale) ctx.provide('locale', { bind: () => (key: string) => key })
  if (!noSidebar) ctx.provide('betterSidebar', { updateTab })
  ctx.provide('workbenchBrowser', { ensureOfficial })
  if (!noRemote) {
    ctx.provide('remote.browserWorkspace', {
      close: vi.fn(),
      navigate: vi.fn(),
      observe,
      screenshot,
    })
  }
  return { ctx, ensureOfficial, observe, screenshot, updateTab }
}

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-dsh-desktop-overlay')
})

describe('OfficialBrowserTab', () => {
  it('renders imported page chrome and commits observed title and Profile metadata', async () => {
    const b = bench()
    render(
      <OfficialBrowserTab
        ctx={b.ctx}
        tab={{ id: 'browser:1', meta: officialTabMeta(TARGET) }}
        scope={{ sessionId: SESSION }}
      />,
    )
    await waitFor(() => {
      const address = screen.getByRole('textbox', { name: 'dock.address' })
      if (!(address instanceof HTMLInputElement)) throw new Error('address control is not an input')
      expect(address.value).toBe('https://example.test/')
    })
    expect(b.observe).toHaveBeenCalledWith(SESSION, TARGET)
    expect(b.screenshot).toHaveBeenCalledWith(SESSION, TARGET)
    expect(b.updateTab).toHaveBeenCalledWith('browser:1', {
      title: 'Example',
      meta: officialTabMeta(TARGET, { kind: 'shared' }),
    })
  })

  it('delegates an empty tab to the workbench bridge without calling create directly', () => {
    const b = bench()
    render(<OfficialBrowserTab ctx={b.ctx} tab={{ id: 'browser:2' }} scope={{ sessionId: SESSION }} />)
    expect(screen.getByText('dock.creating')).toBeTruthy()
    expect(b.ensureOfficial).toHaveBeenCalledWith('browser:2')
  })

  it('does not observe or create from the Desktop overlay document', () => {
    const b = bench({ overlay: true })
    const view = render(
      <OfficialBrowserTab
        ctx={b.ctx}
        tab={{ id: 'browser:1', meta: officialTabMeta(TARGET) }}
        scope={{ sessionId: SESSION }}
      />,
    )
    expect(view.container.firstChild).toBeNull()
    expect(b.ensureOfficial).not.toHaveBeenCalled()
    expect(b.observe).not.toHaveBeenCalled()
  })

  it('renders without optional Session, locale, or sidebar services', async () => {
    const b = bench({ noSessions: true, noLocale: true, noSidebar: true, title: '   ' })
    render(
      <OfficialBrowserTab
        ctx={b.ctx}
        tab={{ id: 'browser:1', meta: officialTabMeta(TARGET) }}
        scope={{ sessionId: SESSION }}
        visible={false}
      />,
    )
    await waitFor(() => { expect(b.observe).toHaveBeenCalledWith(SESSION, TARGET) })
    expect(b.updateTab).not.toHaveBeenCalled()
  })

  it('returns no page chrome before the Browser Workspace Remote is mounted', () => {
    const b = bench({ noRemote: true })
    const view = render(
      <OfficialBrowserTab
        ctx={b.ctx}
        tab={{ id: 'browser:1', meta: officialTabMeta(TARGET) }}
        scope={{ sessionId: SESSION }}
      />,
    )
    expect(view.container.firstChild).toBeNull()
  })

  it('commits Profile metadata without replacing a tab title with blanks', async () => {
    const b = bench({ title: '   ' })
    render(
      <OfficialBrowserTab
        ctx={b.ctx}
        tab={{ id: 'browser:1', meta: officialTabMeta(TARGET) }}
        scope={{ sessionId: SESSION }}
      />,
    )
    await waitFor(() => {
      expect(b.updateTab).toHaveBeenCalledWith('browser:1', {
        meta: officialTabMeta(TARGET, { kind: 'shared' }),
      })
    })
  })

  it('finds the listed revision after rejecting every mismatched target segment', async () => {
    const targets: BrowserTarget[] = [
      { ...TARGET, profileId: 'other-profile' as BrowserTarget['profileId'] },
      { ...TARGET, workspaceId: 'other-workspace' as BrowserTarget['workspaceId'] },
      { ...TARGET, browserId: 'other-browser' as BrowserTarget['browserId'] },
      { ...TARGET, tabId: 'other-tab' as BrowserTarget['tabId'] },
      TARGET,
    ]
    const projection: BrowserWorkspaceProjection = {
      activeWorkspaceId: TARGET.workspaceId,
      workspaces: targets.map((target, index) => ({
        workspaceId: target.workspaceId,
        profileId: target.profileId,
        activeBrowserId: target.browserId,
        browsers: [{
          browserId: target.browserId,
          activeTabId: target.tabId,
          tabs: [{ tabId: target.tabId, revision: index + 1 }],
        }],
      })),
    }
    const b = bench({ projection })
    render(
      <OfficialBrowserTab
        ctx={b.ctx}
        tab={{ id: 'browser:1', meta: officialTabMeta(TARGET) }}
        scope={{ sessionId: SESSION }}
      />,
    )
    await waitFor(() => { expect(b.observe).toHaveBeenCalledWith(SESSION, TARGET) })
  })
})
