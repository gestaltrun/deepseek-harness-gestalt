// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobilePairing, type MobilePairingActions } from '../src/MobilePairing.tsx'

afterEach(cleanup)

describe('MobilePairing', () => {
  it('uses a complete link or QR and shows Desktop-matching authentication words', () => {
    let snapshot: ReturnType<MobilePairingActions['getSnapshot']> = { status: 'ready' }
    const completeLink = vi.fn()
    const scanQr = vi.fn()
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
    const { rerender } = render(createElement(MobilePairing, { actions }))
    const link = 'https://platform.example.com/pair?secret=complete-high-entropy-invitation'
    fireEvent.click(screen.getByRole('button', { name: '扫描 QR' }))
    expect(scanQr).toHaveBeenCalledWith(expect.any(HTMLVideoElement), expect.any(AbortSignal))
    expect(screen.getByText('将 Desktop Settings 中的 QR 对准取景框')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '完整的一次性配对链接' }), { target: { value: link } })
    fireEvent.click(screen.getByRole('button', { name: '继续配对' }))
    expect(completeLink).toHaveBeenCalledWith(link)
    expect(screen.queryByLabelText(/manual|短码/i)).toBeNull()

    snapshot = {
      status: 'pending', deviceName: 'Alice phone',
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
    }
    rerender(createElement(MobilePairing, { actions }))
    expect(screen.getByText('amber binary cedar delta ember frost')).toBeTruthy()
    expect(screen.getByText('请在 Desktop 确认后继续')).toBeTruthy()
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

    render(createElement(MobilePairing, { actions }))
    expect(screen.getByRole('alert').textContent).toContain('completion response was lost')
    fireEvent.click(screen.getByRole('button', { name: '重试配对' }))
    expect(retryPairing).toHaveBeenCalledOnce()
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
    const rendered = render(createElement(MobilePairing, { actions }))
    expect(activate).toHaveBeenCalledOnce()
    rendered.unmount()
    expect(deactivate).toHaveBeenCalledOnce()
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
    const rendered = render(createElement(MobilePairing, { actions, reportLifecycleError }))
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
    render(createElement(MobilePairing, { actions, reportLifecycleError }))

    fireEvent.click(screen.getByRole('button', { name: /Work Mac/ }))
    expect(selectDesktop).toHaveBeenCalledWith(work)
    fireEvent.click(screen.getByRole('button', { name: '解除所选 Desktop 配对' }))

    await waitFor(() => { expect(reportLifecycleError).toHaveBeenCalledWith(failure) })
    expect(screen.getByRole('heading', { name: '解除配对失败' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('可能仍然有效')
    expect(screen.queryByText('连接 Paired Desktop')).toBeNull()
  })
})
