// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DesktopBridge, DesktopSub2ApiSnapshot } from '../src/protocol.ts'
import { Sub2ApiControl } from '../src/client/Sub2ApiControl.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.dshDesktop
  document.documentElement.style.colorScheme = ''
  document.documentElement.lang = ''
})

const t = (key: string) => (en as Record<string, string>)[key] ?? key

describe('Sub2ApiControl', () => {
  it('renders the offer with data and uninstall semantics and enables from missing', () => {
    const desktop = bridge()
    window.dshDesktop = desktop
    renderControl({ state: 'missing', enabled: true })

    expect(screen.getByRole('heading', { name: 'Sub2API account pool' })).toBeTruthy()
    expect(screen.getByText(/\.dsh\/sub2api\/data/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download and enable' }))
    expect(desktop.sub2ApiEnable).toHaveBeenCalledOnce()
  })

  it('renders progress phases without action buttons', () => {
    window.dshDesktop = bridge()
    renderControl({ state: 'downloading', enabled: true, downloadPercent: 42 })
    expect(screen.getByText('Downloading 42%')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()

    cleanup()
    renderControl({ state: 'downloading', enabled: true })
    expect(screen.getByText('Downloading…')).toBeTruthy()

    cleanup()
    renderControl({ state: 'verifying', enabled: true })
    expect(screen.getByText(/Verifying SHA256SUMS/)).toBeTruthy()

    cleanup()
    renderControl({ state: 'starting', enabled: true })
    expect(screen.getByText(/Starting the local component/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not require a manual restart action while installed and enabled', () => {
    const desktop = bridge()
    window.dshDesktop = desktop
    renderControl({ state: 'installed', enabled: true, version: '0.1.0' })

    expect(screen.getByText('Installed · 0.1.0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restart Web Host and start' })).toBeNull()
    expect(desktop.sub2ApiEnable).not.toHaveBeenCalled()

    // An install whose package manifest is unreadable renders without a version.
    cleanup()
    renderControl({ state: 'installed', enabled: true })
    expect(screen.getByText('Installed')).toBeTruthy()
  })

  it('offers enable and uninstall while disabled', () => {
    const desktop = bridge()
    window.dshDesktop = desktop
    renderControl({ state: 'installed', enabled: false })

    expect(screen.getByText(/Disabled: the component does not start/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    expect(desktop.sub2ApiEnable).toHaveBeenCalledOnce()

    cleanup()
    renderControl({ state: 'installed', enabled: false })
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall (keep account data)' }))
    expect(desktop.sub2ApiUninstall).toHaveBeenCalledWith(false)
  })

  it('drives disable and the two-step uninstall while running', () => {
    const desktop = bridge()
    window.dshDesktop = desktop
    renderControl({ state: 'running', enabled: true, version: '0.1.0' })

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    expect(desktop.sub2ApiDisable).toHaveBeenCalledOnce()

    // Uninstall is two-step: the choice row appears only after the request.
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall (keep account data)' }))
    expect(desktop.sub2ApiUninstall).toHaveBeenCalledWith(false)

    cleanup()
    renderControl({ state: 'running', enabled: true })
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Uninstall and delete account data' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and delete account data' }))
    expect(desktop.sub2ApiUninstall).toHaveBeenCalledWith(true)
  })

  it('embeds the native account workspace by default while running', () => {
    window.dshDesktop = bridge()
    document.documentElement.style.colorScheme = 'dark'
    document.documentElement.lang = 'zh-CN'
    renderControl({ state: 'running', enabled: true, version: '0.1.0' })

    expect(screen.queryByRole('button', { name: 'Open account console' })).toBeNull()
    expect(screen.getByTitle('Sub2API account console').getAttribute('src')).toBe(
      '/plugins/dsh-sub2api/ui/admin/accounts?embed=desktop&theme=dark&lang=zh',
    )
    expect(screen.getByText('Running · 0.1.0').closest('header')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Disable' }).closest('header')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Uninstall' }).closest('header')).not.toBeNull()
  })

  it('grows the native account workspace so Settings owns vertical scrolling', () => {
    const observers: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = []
    vi.stubGlobal('ResizeObserver', class {
      readonly callback: ResizeObserverCallback
      readonly disconnect = vi.fn()
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        observers.push(this)
      }
      observe = vi.fn()
      unobserve = vi.fn()
    })
    window.dshDesktop = bridge()
    renderControl({ state: 'running', enabled: true })
    const frame = screen.getByTitle('Sub2API account console') as HTMLIFrameElement
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      value: null,
    })
    fireEvent.load(frame)
    expect(observers).toHaveLength(0)

    const embeddedRoot = document.createElement('html')
    const embeddedBody = document.createElement('body')
    Object.defineProperty(embeddedRoot, 'scrollHeight', {
      configurable: true,
      value: 1180,
    })
    Object.defineProperty(embeddedBody, 'scrollHeight', {
      configurable: true,
      value: 1120,
    })
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      value: { documentElement: embeddedRoot, body: embeddedBody },
    })

    fireEvent.load(frame)

    expect(frame.style.height).toBe('1180px')
    expect(observers).toHaveLength(1)
    observers[0]?.callback([], {} as ResizeObserver)
    expect(frame.style.height).toBe('1180px')
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      value: null,
    })
    observers[0]?.callback([], {} as ResizeObserver)
    cleanup()
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce()
  })

  it('follows live Desktop theme and locale changes', async () => {
    window.dshDesktop = bridge()
    document.documentElement.style.colorScheme = 'light'
    document.documentElement.lang = 'en'
    renderControl({ state: 'running', enabled: true })
    const frame = screen.getByTitle('Sub2API account console')
    expect(frame.getAttribute('src')).toContain('theme=light&lang=en')

    document.documentElement.style.colorScheme = 'dark'
    document.documentElement.lang = 'zh-CN'
    await waitFor(() => {
      expect(frame.getAttribute('src')).toContain('theme=dark&lang=zh')
    })
  })

  it('uses the system theme without reloading for an equivalent presentation', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener,
      removeEventListener,
    })))
    window.dshDesktop = bridge()
    document.documentElement.lang = 'en'
    renderControl({ state: 'running', enabled: true })
    const frame = screen.getByTitle('Sub2API account console')
    const initialUrl = frame.getAttribute('src')

    expect(initialUrl).toContain('theme=dark&lang=en')
    document.documentElement.lang = 'en-US'
    const listener = addEventListener.mock.calls[0]?.[1] as (() => void) | undefined
    if (listener === undefined) throw new Error('system theme listener was not registered')
    listener()
    expect(frame.getAttribute('src')).toBe(initialUrl)

    cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('change', listener)
  })

  it('shows the actionable error with retry and uninstall exits', () => {
    const desktop = bridge()
    window.dshDesktop = desktop
    renderControl({ state: 'error', enabled: true, error: 'SHA-256 mismatch' })

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('SHA-256 mismatch')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(desktop.sub2ApiEnable).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and delete account data' }))
    expect(desktop.sub2ApiUninstall).toHaveBeenCalledWith(true)
  })

  it('renders nothing without the Desktop bridge', () => {
    renderControl({ state: 'missing', enabled: true })
    expect(screen.queryByText('Sub2API account pool')).toBeNull()
  })
})

function renderControl(snapshot: DesktopSub2ApiSnapshot): ReturnType<typeof render> {
  return render(
    <Sub2ApiControl
      t={t as never}
      useSessions={(() => { throw new Error('unused') })}
      useWorkspaces={(() => { throw new Error('unused') })}
      useSub2api={selector => selector(snapshot)}
      close={vi.fn()}
    />,
  )
}

function bridge(): DesktopBridge {
  return {
    platform: 'darwin',
    getStatus: async () => ({ state: 'idle', lastCheckedAt: null }),
    checkNow: vi.fn(),
    downloadNow: vi.fn(),
    quitAndInstall: vi.fn(),
    onStatus: () => () => {},
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    accountGetSnapshot: vi.fn().mockResolvedValue({ status: 'unavailable', privacyAccepted: false }),
    accountAcceptPrivacy: vi.fn(),
    accountBeginLogin: vi.fn(),
    accountSignOut: vi.fn(),
    onAccountSnapshot: () => () => {},
    pairingGetSnapshot: vi.fn(),
    pairingSetEnabled: vi.fn(),
    pairingCreateChallenge: vi.fn(),
    pairingCancelChallenge: vi.fn(),
    pairingConfirm: vi.fn(),
    pairingReject: vi.fn(),
    pairingRevoke: vi.fn(),
    onPairingSnapshot: () => () => {},
    sub2ApiGetSnapshot: vi.fn(() => Promise.resolve<DesktopSub2ApiSnapshot>({ state: 'missing', enabled: true })),
    sub2ApiEnable: vi.fn(() => Promise.resolve<DesktopSub2ApiSnapshot>({ state: 'missing', enabled: true })),
    sub2ApiDisable: vi.fn(() => Promise.resolve<DesktopSub2ApiSnapshot>({ state: 'missing', enabled: true })),
    sub2ApiUninstall: vi.fn(() => Promise.resolve<DesktopSub2ApiSnapshot>({ state: 'missing', enabled: true })),
    onSub2ApiSnapshot: () => () => {},
    chromeOverlayShow: async () => {},
    chromeOverlayHide: async () => {},
    chromeOverlayGetState: async () => null,
    chromeOverlayResult: () => {},
    onChromeOverlayState: () => () => {},
    onChromeOverlayResult: () => () => {},
  }
}
