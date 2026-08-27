// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobilePairing, type MobilePairingActions } from '../src/MobilePairing.tsx'

afterEach(cleanup)

describe('MobilePairing', () => {
  it('replaces the QR stage with complete-link entry and shows Desktop-matching authentication words', async () => {
    let snapshot: ReturnType<MobilePairingActions['getSnapshot']> = { status: 'ready' }
    const completeLink = vi.fn()
    let scanSignal: AbortSignal | undefined
    const scanQr = vi.fn((_preview: HTMLVideoElement, signal: AbortSignal) => {
      scanSignal = signal
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('cancelled', 'AbortError')) }, { once: true })
      })
    })
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      completeLink,
      scanQr,
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined),
      unpair: vi.fn().mockResolvedValue(undefined),
    }
    const { container, rerender } = render(createElement(MobilePairing, { actions, locale: 'zh' }))
    const link = 'https://platform.example.com/pair?secret=complete-high-entropy-invitation'
    expect(container.querySelector('[data-pairing-hero="connect"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '扫描二维码' }))
    expect(scanQr).toHaveBeenCalledWith(expect.any(HTMLVideoElement), expect.any(AbortSignal))
    expect(screen.getByText('将桌面端设置中的二维码对准取景框')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '完整的一次性配对链接' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '改为粘贴完整链接' }))
    await waitFor(() => { expect(scanSignal?.aborted).toBe(true) })
    expect(screen.queryByText('将桌面端设置中的二维码对准取景框')).toBeNull()
    expect(container.querySelector('[data-pairing-hero="connect"]')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '完整的一次性配对链接' }), { target: { value: link } })
    fireEvent.click(screen.getByRole('button', { name: '继续配对' }))
    expect(completeLink).toHaveBeenCalledWith(link)
    expect(screen.queryByLabelText(/manual|短码/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '改为扫描二维码' }))
    expect(screen.queryByRole('textbox', { name: '完整的一次性配对链接' })).toBeNull()
    expect(container.querySelector('[data-pairing-hero="connect"]')).toBeTruthy()

    snapshot = {
      status: 'pending', deviceName: 'Alice phone',
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
    }
    rerender(createElement(MobilePairing, { actions, locale: 'zh' }))
    expect(screen.getByText('amber binary cedar delta ember frost')).toBeTruthy()
    expect(screen.getByText('请在桌面端确认后继续')).toBeTruthy()
  })

  it('offers an explicit retry for a retained pairing attempt', () => {
    const retryPairing = vi.fn()
    const snapshot = { status: 'retryable', error: 'completion response was lost' } as const
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing,
      selectDesktop: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined),
      unpair: vi.fn().mockResolvedValue(undefined),
    }

    render(createElement(MobilePairing, { actions, locale: 'zh' }))
    expect(screen.getByRole('alert').textContent).toContain('completion response was lost')
    fireEvent.click(screen.getByRole('button', { name: '重试配对' }))
    expect(retryPairing).toHaveBeenCalledOnce()
  })

  it('admits a fresh invitation after Desktop rejects a terminal attempt', () => {
    let snapshot: ReturnType<MobilePairingActions['getSnapshot']> = {
      status: 'rejected', error: 'Desktop rejected Personal Pairing.',
    }
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined),
      unpair: vi.fn().mockResolvedValue(undefined),
    }

    const rendered = render(createElement(MobilePairing, { actions, locale: 'zh' }))
    expect(screen.getByRole('heading', { name: '配对未获授权' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '继续配对' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '配对另一台桌面端' }))
    expect(rendered.container.querySelector('[data-mobile-pairing="ready"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: '扫描二维码' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '改为粘贴完整链接' }))
    expect(screen.getByRole('textbox', { name: '完整的一次性配对链接' })).toBeTruthy()

    snapshot = {
      status: 'pending', deviceName: 'Alice phone',
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
    }
    rendered.rerender(createElement(MobilePairing, { actions, locale: 'zh' }))
    snapshot = { status: 'rejected', error: 'Desktop rejected Personal Pairing again.' }
    rendered.rerender(createElement(MobilePairing, { actions, locale: 'zh' }))
    expect(screen.getByRole('heading', { name: '配对未获授权' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('again')
  })

  it('activates on mount and awaits lifecycle deactivation on unmount', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    const deactivate = vi.fn().mockResolvedValue(undefined)
    const snapshot = { status: 'ready' } as const
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate,
      deactivate,
      unpair: vi.fn().mockResolvedValue(undefined),
    }
    const rendered = render(createElement(MobilePairing, { actions, locale: 'zh' }))
    expect(activate).toHaveBeenCalledOnce()
    rendered.unmount()
    expect(deactivate).toHaveBeenCalledOnce()
  })

  it('leaves lifecycle ownership with the signed-in navigation shell', () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    const deactivate = vi.fn().mockResolvedValue(undefined)
    const snapshot = { status: 'ready' } as const
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate,
      deactivate,
      unpair: vi.fn().mockResolvedValue(undefined),
    }

    const rendered = render(createElement(MobilePairing, { actions, locale: 'zh', manageLifecycle: false }))
    expect(activate).not.toHaveBeenCalled()
    rendered.unmount()
    expect(deactivate).not.toHaveBeenCalled()
  })

  it('contains and reports rejected mount and unmount lifecycle work', async () => {
    const activateFailure = new Error('activation failed')
    const deactivateFailure = new Error('deactivation failed')
    const reportLifecycleError = vi.fn()
    const snapshot = { status: 'ready' } as const
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn().mockRejectedValue(activateFailure),
      deactivate: vi.fn().mockRejectedValue(deactivateFailure),
      unpair: vi.fn(),
    }
    const rendered = render(createElement(MobilePairing, { actions, locale: 'zh', reportLifecycleError }))
    await waitFor(() => { expect(reportLifecycleError).toHaveBeenCalledWith(activateFailure) })

    rendered.unmount()

    await waitFor(() => { expect(reportLifecycleError).toHaveBeenCalledWith(deactivateFailure) })
  })

  it('reports failed unpairing and keeps the product in an explicit unresolved state', async () => {
    const failure = new AggregateError([new Error('Relay revoke failed')], 'Mobile Personal Pairing unpair failed')
    const reportLifecycleError = vi.fn()
    const home = 'pairing-home' as never
    const work = 'pairing-work' as never
    let snapshot: ReturnType<MobilePairingActions['getSnapshot']> = {
      status: 'paired',
      desktops: [
        { pairingId: home, desktopName: 'Home Mac' },
        { pairingId: work, desktopName: 'Work Mac' },
      ],
      selectedPairingId: home,
    }
    let notify = (): void => {}
    const selectDesktop = vi.fn()
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { notify = listener; return () => {} },
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop,
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined),
      unpair: vi.fn(async () => {
        snapshot = { status: 'unpair-failed', error: failure.message }
        notify()
        throw failure
      }),
    }
    render(createElement(MobilePairing, { actions, locale: 'zh', reportLifecycleError }))

    fireEvent.click(screen.getByRole('button', { name: /Work Mac/ }))
    expect(selectDesktop).toHaveBeenCalledWith(work)
    fireEvent.click(screen.getByRole('button', { name: '解除所选桌面端配对' }))

    await waitFor(() => { expect(reportLifecycleError).toHaveBeenCalledWith(failure) })
    expect(screen.getByRole('heading', { name: '解除配对失败' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('可能仍然有效')
    expect(screen.queryByText('连接已配对的桌面端')).toBeNull()
  })

  it('renders the Paired Desktop selector entirely in English', () => {
    const home = 'pairing-home' as never
    const work = 'pairing-work' as never
    const snapshot = {
      status: 'paired' as const,
      desktops: [
        { pairingId: home, desktopName: 'Home Mac' },
        { pairingId: work, desktopName: 'Work Mac' },
      ],
      selectedPairingId: home,
    }
    const actions: MobilePairingActions = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined),
      unpair: vi.fn().mockResolvedValue(undefined),
    }

    render(createElement(MobilePairing, { actions, locale: 'en' }))

    expect(screen.getByRole('heading', { name: 'Paired Desktops' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Home MacSelected/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Work MacSelect this Desktop/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unpair selected Desktop' })).toBeTruthy()
    expect(screen.queryByText(/当前选择|选择此|解除所选|配对另一台/)).toBeNull()
  })
})
