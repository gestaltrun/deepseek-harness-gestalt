// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  parsePairingChallengeId,
  parsePendingPairingId,
  parsePersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import type { DesktopAccountSnapshot, DesktopBridge, DesktopPairingSnapshot } from '../src/protocol.ts'
import { AccountControl } from '../src/client/AccountControl.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  delete window.dshDesktop
})

const t = (key: string) => (en as Record<string, string>)[key] ?? key

describe('AccountControl', () => {
  it('shows both privacy notices and blocks authorization until consent', () => {
    const snapshot: DesktopAccountSnapshot = { status: 'idle', privacyAccepted: false }
    const desktop = bridge(snapshot)
    window.dshDesktop = desktop
    renderControl(snapshot)

    expect(screen.getByText(/Platform 会保存 GitHub 数字 ID/)).toBeTruthy()
    expect(screen.getByText(/Platform stores the numeric GitHub id/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue to GitHub' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(desktop.accountAcceptPrivacy).toHaveBeenCalledOnce()
    expect(desktop.accountBeginLogin).not.toHaveBeenCalled()
  })

  it('starts authorization after consent and signs out only the shown installation', () => {
    const accepted: DesktopAccountSnapshot = { status: 'idle', privacyAccepted: true }
    const desktop = bridge(accepted)
    window.dshDesktop = desktop
    renderControl(accepted)
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }))
    expect(desktop.accountBeginLogin).toHaveBeenCalledOnce()

    cleanup()
    const signedIn: DesktopAccountSnapshot = {
      status: 'signed-in',
      privacyAccepted: true,
      account: {
        id: 'account-1',
        githubId: 13994321,
        githubLogin: 'octocat',
        avatarUrl: 'https://avatars.example/octocat',
      },
    }
    renderControl(signedIn)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out this installation' }))
    expect(desktop.accountSignOut).toHaveBeenCalledOnce()
    expect(screen.getByText(/preserves Personal Pairings/)).toBeTruthy()
  })

  it('configures Personal Pairing only inside the signed-in Settings section', () => {
    const signedIn: DesktopAccountSnapshot = {
      status: 'signed-in', privacyAccepted: true,
      account: { id: 'account-1', githubId: 1, githubLogin: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
    }
    const pairing: DesktopPairingSnapshot = { status: 'ready', enabled: false, pairings: [] }
    const desktop = bridge(signedIn)
    window.dshDesktop = desktop
    renderControl(signedIn, pairing)

    expect(screen.getByRole('switch', { name: 'Mobile Access' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Mobile Access' }))
    expect(desktop.pairingSetEnabled).toHaveBeenCalledWith(true)

    cleanup()
    renderControl(signedIn, { status: 'ready', enabled: true, pairings: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Create phone pairing' }))
    expect(desktop.pairingCreateChallenge).toHaveBeenCalledOnce()

    cleanup()
    renderControl(signedIn, {
      status: 'challenge', enabled: true, pairings: [],
      challenge: {
        id: parsePairingChallengeId('challenge-1'), expiresAt: Date.now() + 120_000,
        oneTimeLink: 'https://platform.example.com/pair?secret=complete-high-entropy-value',
        qrPayload: 'https://platform.example.com/pair?secret=complete-high-entropy-value',
      },
    })
    expect(screen.getAllByText('https://platform.example.com/pair?secret=complete-high-entropy-value')).toHaveLength(2)
    expect(screen.getByLabelText('Pairing QR payload').textContent).toContain('complete-high-entropy-value')
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel pairing' }))
    expect(desktop.pairingCancelChallenge).toHaveBeenCalledOnce()

    cleanup()
    renderControl(signedIn, {
      status: 'pending', enabled: true, pairings: [],
      pending: {
        id: parsePendingPairingId('pending-1'),
        deviceName: 'Alice phone',
        authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      },
    })
    expect(screen.getByText('amber binary cedar delta ember frost')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' }))
    expect(desktop.pairingConfirm).toHaveBeenCalledWith('pending-1')
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(desktop.pairingReject).toHaveBeenCalledWith('pending-1')

    cleanup()
    renderControl(signedIn, {
      status: 'ready', enabled: true,
      pairings: [{
        id: parsePersonalPairingId('pairing-1'), deviceName: 'Alice phone', platform: 'ios', pairedAt: 1, lastAccessAt: 1, online: false,
      }],
      error: 'temporary warning',
    })
    expect(screen.getByText('Alice phone')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('temporary warning')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke pairing' }))
    expect(desktop.pairingRevoke).toHaveBeenCalledWith('pairing-1')

    cleanup()
    renderControl(signedIn, {
      status: 'ready', enabled: true,
      pairings: [{
        id: parsePersonalPairingId('pairing-2'), deviceName: 'Bob tablet', platform: 'android', pairedAt: 1_000, lastAccessAt: 2_000, online: true,
      }],
    })
    expect(screen.getByText('Bob tablet')).toBeTruthy()
    expect(screen.getByText('android')).toBeTruthy()
    expect(screen.getByText('online')).toBeTruthy()
    const times = [...document.querySelectorAll('time')]
    expect(times.map(time => time.getAttribute('datetime'))).toEqual([
      new Date(1_000).toISOString(),
      new Date(2_000).toISOString(),
    ])
  })

  it('projects every Account state and renders nothing without the Desktop bridge', () => {
    const idle: DesktopAccountSnapshot = { status: 'idle', privacyAccepted: false }
    const empty = renderControl(idle)
    expect(empty.container.textContent).toBe('')

    const desktop = bridge(idle)
    window.dshDesktop = desktop
    cleanup()
    renderControl({ status: 'unavailable', privacyAccepted: false })
    expect(screen.getByText('Platform Account is not configured for this installation.')).toBeTruthy()

    cleanup()
    renderControl({ status: 'unavailable', privacyAccepted: false, error: 'secure storage unavailable' })
    expect(screen.getByText('secure storage unavailable')).toBeTruthy()

    for (const status of ['polling', 'authorizing'] as const) {
      cleanup()
      renderControl({ status, privacyAccepted: true })
      expect(screen.getByText('Finish GitHub sign-in in your system browser')).toBeTruthy()
    }

    cleanup()
    renderControl({ status: 'failed', privacyAccepted: true, error: 'login failed' })
    expect(screen.getByText('login failed')).toBeTruthy()

    cleanup()
    renderControl({
      status: 'signing-out', privacyAccepted: true,
      account: { id: 'account-1', githubId: 1, githubLogin: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
    })
    expect(screen.getByRole('button', { name: 'Sign out this installation' }).hasAttribute('disabled')).toBe(true)
  })
})

function renderControl(
  snapshot: DesktopAccountSnapshot,
  pairing: DesktopPairingSnapshot = { status: 'unavailable', enabled: false, pairings: [] },
): ReturnType<typeof render> {
  return render(
    <AccountControl
      t={t as never}
      useSessions={(() => { throw new Error('unused') })}
      useWorkspaces={(() => { throw new Error('unused') })}
      useAccount={selector => selector(snapshot)}
      usePairing={selector => selector(pairing)}
      close={vi.fn()}
    />,
  )
}

function bridge(snapshot: DesktopAccountSnapshot): DesktopBridge {
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
    accountGetSnapshot: vi.fn().mockResolvedValue(snapshot),
    accountAcceptPrivacy: vi.fn().mockResolvedValue({ ...snapshot, privacyAccepted: true }),
    accountBeginLogin: vi.fn().mockResolvedValue({ status: 'polling', privacyAccepted: true }),
    accountSignOut: vi.fn().mockResolvedValue({ status: 'idle', privacyAccepted: true }),
    onAccountSnapshot: () => () => {},
    pairingGetSnapshot: vi.fn(),
    pairingSetEnabled: vi.fn(),
    pairingCreateChallenge: vi.fn(),
    pairingCancelChallenge: vi.fn(),
    pairingConfirm: vi.fn(),
    pairingReject: vi.fn(),
    pairingRevoke: vi.fn(),
    onPairingSnapshot: () => () => {},
  }
}
