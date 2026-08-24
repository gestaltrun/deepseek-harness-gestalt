// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  parseInstallationId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountSessionView,
  type LoginAttemptView,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountInstallation,
  type PlatformAccountTransport,
} from '@deepseek-ai/dsh-platform-account-client'
import { MobileAccount } from '../src/MobileAccount.tsx'
import type { MobilePairingActions } from '../src/MobilePairing.tsx'
import { fixedMobilePresentationClock } from '../src/mobile-clock.ts'

afterEach(cleanup)

const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://dev.example',
    callbackUrl: 'https://dev.example/v1/account/oauth/github/callback',
    githubClientId: 'mobile-development', credentialReference: 'credentials://development',
    databaseIdentity: 'database-development', identityNamespace: 'namespace-development',
  },
  production: {
    environment: 'production', origin: 'https://prod.example',
    callbackUrl: 'https://prod.example/v1/account/oauth/github/callback',
    githubClientId: 'mobile-production', credentialReference: 'credentials://production',
    databaseIdentity: 'database-production', identityNamespace: 'namespace-production',
  },
}), 'development')

const attempt: LoginAttemptView = {
  id: 'attempt-mobile' as never,
  state: 'state-mobile',
  authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=mobile',
  pollingToken: 'polling-mobile',
  expiresAt: Date.now() + 300_000,
}

const session: AccountSessionView = {
  sessionId: 'session-mobile' as never,
  account: {
    id: 'account-mobile' as never,
    githubId: 583231,
    githubLogin: 'octocat',
    avatarUrl: 'https://avatars.example/octocat',
  },
  accessToken: 'access-mobile',
  refreshToken: 'refresh-mobile',
  accessExpiresAt: Date.now() + 900_000,
  refreshExpiresAt: Date.now() + 2_592_000_000,
}
const clock = fixedMobilePresentationClock(0)

describe('MobileAccount', () => {
  it('shows both privacy notices and blocks GitHub until consent', async () => {
    const { installation, openSystemBrowser } = fixture()
    render(createElement(MobileAccount, { installation, locale: 'zh', theme: 'light', clock }))

    expect(screen.getByText(/Platform 会保存 GitHub 数字 ID/)).toBeTruthy()
    expect(screen.getByText(/Platform stores the numeric GitHub id/)).toBeTruthy()
    const continueButton = screen.getByRole('button', { name: '使用 GitHub 继续' })
    expect(continueButton.hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => { expect(continueButton.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(continueButton)
    await waitFor(() => { expect(openSystemBrowser).toHaveBeenCalledWith(attempt.authorizationUrl) })
  })

  it('polls to the current-installation account and signs out only that installation', async () => {
    const { installation, api } = fixture()
    const unavailablePairing = { status: 'unavailable', error: 'independent review pending' } as const
    const deactivate = vi.fn().mockResolvedValue(undefined)
    const pairing: MobilePairingActions = {
      getSnapshot: () => unavailablePairing,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate,
      unpair: vi.fn().mockResolvedValue(undefined),
    }
    render(createElement(MobileAccount, { installation, pairing, locale: 'zh', theme: 'light', clock }))

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => { expect(screen.getByRole('button', { name: '使用 GitHub 继续' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '使用 GitHub 继续' }))
    await screen.findByText('@octocat')
    expect(screen.getByText('当前安装')).toBeTruthy()
    expect(screen.getByText('independent review pending')).toBeTruthy()
    expect(screen.queryByText('Paired Desktop')).toBeNull()
    expect(screen.queryByText('Remote Offline')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '退出此安装' }))
    await waitFor(() => { expect(api.signOut).toHaveBeenCalledOnce() })
    await screen.findByRole('button', { name: '使用 GitHub 继续' })
    expect(deactivate).toHaveBeenCalledOnce()
  })
})

function fixture(): {
  installation: PlatformAccountInstallation
  api: MockTransport
  openSystemBrowser: ReturnType<typeof vi.fn>
} {
  const api: MockTransport = {
    environment: ENVIRONMENT,
    beginLogin: vi.fn<PlatformAccountTransport['beginLogin']>().mockResolvedValue(attempt),
    pollLogin: vi.fn<PlatformAccountTransport['pollLogin']>().mockResolvedValue({ status: 'complete', ...session }),
    refresh: vi.fn<PlatformAccountTransport['refresh']>(),
    current: vi.fn<PlatformAccountTransport['current']>(),
    signOut: vi.fn<PlatformAccountTransport['signOut']>().mockResolvedValue(undefined),
  }
  const openSystemBrowser = vi.fn()
  return {
    api,
    openSystemBrowser,
    installation: new PlatformAccountInstallation({
      environment: ENVIRONMENT,
      installationId: parseInstallationId('mobile-ui'),
      installationKind: 'mobile',
      presentation: { name: 'Mobile UI test', platform: 'ios' },
      transport: api,
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: openSystemBrowser },
      crypto: globalThis.crypto,
    }),
  }
}

interface MockTransport {
  environment: SelectedPlatformEnvironment
  beginLogin: Mock<PlatformAccountTransport['beginLogin']>
  pollLogin: Mock<PlatformAccountTransport['pollLogin']>
  refresh: Mock<PlatformAccountTransport['refresh']>
  current: Mock<PlatformAccountTransport['current']>
  signOut: Mock<PlatformAccountTransport['signOut']>
}
