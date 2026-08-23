// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopBridge, UpdaterStatus } from '../src/protocol.ts'
import { applyUpdaterClick, UpdateControl } from '../src/client/UpdateControl.tsx'
import { bindDesktopUpdater, createUpdaterSource } from '../src/client/status-source.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  delete window.dshDesktop
})

const t = (key: string) => (en as Record<string, string>)[key] ?? key

function mount(status: UpdaterStatus, bridge?: Partial<DesktopBridge>) {
  const desktop = mountBridge({
    getStatus: () => Promise.resolve(status),
    ...bridge,
  })
  render(
    <UpdateControl
      wide
      t={t as never}
      useSessions={(() => { throw new Error('unused') })}
      useWorkspaces={(() => { throw new Error('unused') })}
      useUpdater={select => select(status)}
    />,
  )
  return desktop
}

describe('UpdateControl', () => {
  it('renders nothing without the Desktop bridge', () => {
    render(
      <UpdateControl
        wide
        t={t as never}
        useSessions={(() => { throw new Error('unused') })}
        useWorkspaces={(() => { throw new Error('unused') })}
        useUpdater={select => select({ state: 'idle', lastCheckedAt: null })}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    { state: 'disabled', lastCheckedAt: null },
    { state: 'idle', lastCheckedAt: null },
    { state: 'checking', lastCheckedAt: null },
    { state: 'error', lastCheckedAt: 1, errorMessage: 'offline' },
  ] satisfies UpdaterStatus[])('does not expose a control for inactive status $state', (status) => {
    mount(status)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('projects disabled state without an accessible control', () => {
    mount({ state: 'disabled', lastCheckedAt: null })
    const marker = document.querySelector('[data-desktop-updater-state="disabled"]')
    expect(marker).not.toBeNull()
    expect(marker?.hasAttribute('hidden')).toBe(true)
    expect(marker?.textContent).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('projects an asynchronous idle to disabled renderer transition', async () => {
    let resolveStatus: ((status: UpdaterStatus) => void) | undefined
    const source = createUpdaterSource()
    const desktop = mountBridge({
      getStatus: () => new Promise((resolve) => { resolveStatus = resolve }),
    })
    const stop = bindDesktopUpdater(source, desktop)
    const useUpdater: SnapshotSelectorHook<UpdaterStatus> = selector => selector(useSyncExternalStore(
      source.subscribe,
      source.getSnapshot,
    ))
    render(
      <UpdateControl
        wide
        t={t as never}
        useSessions={(() => { throw new Error('unused') })}
        useWorkspaces={(() => { throw new Error('unused') })}
        useUpdater={useUpdater}
      />,
    )
    expect(document.querySelector('[data-desktop-updater-state="idle"]')).not.toBeNull()

    resolveStatus?.({ state: 'disabled', lastCheckedAt: null })

    await waitFor(() => {
      expect(document.querySelector('[data-desktop-updater-state="disabled"]')).not.toBeNull()
    })
    expect(document.querySelector('[data-desktop-update-control]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    stop()
  })

  it('downloads when a version is available', () => {
    const available = mount({ state: 'available', lastCheckedAt: 1, newVersion: '0.1.1' })
    const control = screen.getByRole('button', { name: 'Download 0.1.1' })
    expect(control.getAttribute('data-desktop-update-control')).toBe('')
    fireEvent.click(control)
    expect(available.downloadNow).toHaveBeenCalledOnce()
  })

  it('does not install while Squirrel is still preparing', () => {
    const preparing = mount({ state: 'preparing', lastCheckedAt: 1, newVersion: '0.1.4' })
    const control = screen.getByRole('button', { name: 'Preparing update' })
    expect(control.hasAttribute('disabled')).toBe(true)
    fireEvent.click(control)
    expect(preparing.quitAndInstall).not.toHaveBeenCalled()
    applyUpdaterClick('preparing', preparing)
    expect(preparing.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installs after download', () => {
    const downloaded = mount({ state: 'downloaded', lastCheckedAt: 1, newVersion: '0.1.1' })
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }))
    expect(downloaded.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('surfaces post-discovery errors and download progress copy', () => {
    const errored = mount({ state: 'error', lastCheckedAt: 1, newVersion: '0.1.1', errorMessage: 'offline' })
    const errorButton = screen.getByRole('button', { name: 'Update failed' })
    expect(errorButton.getAttribute('title')).toBe('offline')
    fireEvent.click(errorButton)
    expect(errored.checkNow).toHaveBeenCalledOnce()
    cleanup()
    mount({ state: 'available', lastCheckedAt: 1 })
    expect(screen.getByRole('button', { name: /Download/ })).toBeTruthy()
    cleanup()
    mount({ state: 'downloading', lastCheckedAt: 1 })
    expect(screen.getByRole('button', { name: 'Downloading 0%' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    mount({ state: 'downloading', lastCheckedAt: 1, downloadPercent: 40 })
    expect(screen.getByRole('button', { name: 'Downloading 40%' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    mount({ state: 'downloading', lastCheckedAt: 1, downloadPercent: 12.345678 })
    expect(screen.getByRole('button', { name: 'Downloading 12%' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    mount({ state: 'installing', lastCheckedAt: 1, newVersion: '0.1.1' })
    expect(screen.getByRole('button', { name: 'Install and restart' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    window.dshDesktop = {
      platform: 'darwin',
      getStatus: () => Promise.resolve({ state: 'available', lastCheckedAt: 1 }),
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
      pairingGetSnapshot: vi.fn(), pairingSetEnabled: vi.fn(), pairingCreateChallenge: vi.fn(),
      pairingCancelChallenge: vi.fn(), pairingConfirm: vi.fn(), pairingReject: vi.fn(), pairingRevoke: vi.fn(),
      onPairingSnapshot: () => () => {},
      chromeOverlayShow: async () => {},
      chromeOverlayHide: async () => {},
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayState: () => () => {},
      onChromeOverlayResult: () => () => {},
    }
    render(
      <UpdateControl
        wide={false}
        t={t as never}
        useSessions={(() => { throw new Error('unused') })}
        useWorkspaces={(() => { throw new Error('unused') })}
        useUpdater={select => select({ state: 'available', lastCheckedAt: 1 })}
      />,
    )
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  it('no-ops while a check or download is already running', () => {
    const desktop = mount({ state: 'idle', lastCheckedAt: null })
    applyUpdaterClick('checking', desktop)
    applyUpdaterClick('downloading', desktop)
    applyUpdaterClick('installing', desktop)
    applyUpdaterClick('idle', desktop)
    applyUpdaterClick('disabled', desktop)
    expect(desktop.checkNow).toHaveBeenCalledTimes(2)
    expect(desktop.downloadNow).not.toHaveBeenCalled()
    expect(desktop.quitAndInstall).not.toHaveBeenCalled()
  })
})

function mountBridge(bridge?: Partial<DesktopBridge>): DesktopBridge {
  const desktop: DesktopBridge = {
    platform: 'darwin',
    getStatus: () => Promise.resolve({ state: 'idle', lastCheckedAt: null }),
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
    pairingGetSnapshot: vi.fn(), pairingSetEnabled: vi.fn(), pairingCreateChallenge: vi.fn(),
    pairingCancelChallenge: vi.fn(), pairingConfirm: vi.fn(), pairingReject: vi.fn(), pairingRevoke: vi.fn(),
    onPairingSnapshot: () => () => {},
    chromeOverlayShow: async () => {},
    chromeOverlayHide: async () => {},
    chromeOverlayGetState: async () => null,
    chromeOverlayResult: () => {},
    onChromeOverlayState: () => () => {},
    onChromeOverlayResult: () => () => {},
    ...bridge,
  }
  window.dshDesktop = desktop
  return desktop
}
