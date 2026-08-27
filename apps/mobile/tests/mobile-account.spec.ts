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
import type { MobileCompanionPresentation } from '../src/companion-history.ts'
import { fixedMobilePresentationClock } from '../src/mobile-clock.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

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

  it('localizes the complete signed-out Account surface in English', () => {
    const { installation } = fixture()
    render(createElement(MobileAccount, { installation, locale: 'en', theme: 'light', clock }))

    expect(screen.getByRole('heading', { name: 'Connect your Platform Account' })).toBeTruthy()
    expect(screen.getByText('Read before authorization')).toBeTruthy()
    expect(screen.getByText('Public identity · no OAuth scopes')).toBeTruthy()
    expect(screen.getByText('IP ≤ 7 days · security events ≤ 30 days')).toBeTruthy()
    expect(screen.getByText('Not available in the first release')).toBeTruthy()
    expect(screen.getByText('I have read both privacy notices')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue with GitHub' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('This account identifies only this installation; it grants no Desktop access.')).toBeTruthy()
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
    expect(await screen.findByText('未连接')).toBeTruthy()
    expect(screen.queryByText('@octocat')).toBeNull()
    expect(screen.getByText('independent review pending')).toBeTruthy()
    expect(screen.queryByText('当前安装')).toBeNull()
    expect(screen.queryByText('个人配对')).toBeNull()
    expect(screen.queryByText('Paired Desktop')).toBeNull()
    expect(screen.queryByText('Remote Offline')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '查看账号' }))
    expect(await screen.findByText('当前安装')).toBeTruthy()
    expect(screen.getByText('@octocat')).toBeTruthy()
    expect(screen.queryByText('未连接')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => { expect(api.signOut).toHaveBeenCalledOnce() })
    await screen.findByRole('button', { name: '使用 GitHub 继续' })
    expect(deactivate).toHaveBeenCalledOnce()
  })

  it('keeps account identity beside the avatar and switches the signed-in shell language', async () => {
    const { installation } = fixture()
    render(createElement(MobileAccount, { installation, locale: 'en', theme: 'light', clock }))

    fireEvent.click(screen.getByRole('checkbox'))
    const login = screen.getByRole('button', { name: 'Continue with GitHub' })
    await waitFor(() => { expect(login.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(login)
    fireEvent.click(await screen.findByRole('button', { name: 'View account' }))

    const identity = screen.getByText('@octocat').closest('[data-account-identity]')
    expect(identity?.querySelector('img')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByRole('heading', { name: '账号' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy()
    expect(localStorage.getItem('dsh-mobile-locale')).toBe('zh')
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.getByText('远程')).toBeTruthy()
  })

  it('opens Personal Pairing from the unpaired home and returns without stacking the flow', async () => {
    const { installation } = fixture()
    const ready = { status: 'ready' } as const
    const pairing: MobilePairingActions = {
      getSnapshot: () => ready,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined),
      unpair: vi.fn().mockResolvedValue(undefined),
    }
    render(createElement(MobileAccount, { installation, pairing, locale: 'zh', theme: 'light', clock }))

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => { expect(screen.getByRole('button', { name: '使用 GitHub 继续' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '使用 GitHub 继续' }))

    expect(await screen.findByText('未连接')).toBeTruthy()
    expect(screen.getByText('扫码连接 Desktop 后即可查看 Session')).toBeTruthy()
    expect(screen.queryByText('连接已配对的桌面端')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '扫描配对' }))
    expect(await screen.findByText('连接已配对的桌面端')).toBeTruthy()
    expect(screen.queryByText('未连接')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(await screen.findByText('未连接')).toBeTruthy()
    expect(screen.queryByText('连接已配对的桌面端')).toBeNull()
  })

  it('does not let a stale Companion projection override missing selected-pairing authority', async () => {
    const { installation } = fixture()
    const ready = { status: 'ready' } as const
    const pairing: MobilePairingActions = {
      getSnapshot: () => ready,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined),
      unpair: vi.fn().mockResolvedValue(undefined),
    }
    const companion: MobileCompanionPresentation = {
      desktopName: 'Stale Desktop',
      connection: 'online',
      sessions: {
        ids: [], byId: {}, current: undefined, phase: 'ready',
        subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
      },
      workspaces: [],
      conversations: {},
      loadImage: () => Promise.reject(new Error('unavailable')),
      canMutate: true,
      search: { query: '', status: 'idle', items: [], hasMore: false },
      attachment: { status: 'idle' },
    }
    render(createElement(MobileAccount, { installation, pairing, companion, locale: 'zh', theme: 'light', clock }))

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => { expect(screen.getByRole('button', { name: '使用 GitHub 继续' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '使用 GitHub 继续' }))

    expect(await screen.findByText('未连接')).toBeTruthy()
    expect(screen.queryByText('Stale Desktop')).toBeNull()
    expect(screen.queryByText('Remote Online')).toBeNull()
  })

  it('hands sign-out deactivation to the pairing lifecycle owner immediately', async () => {
    const { installation } = fixture()
    const ready = { status: 'ready' } as const
    let finishActivation = (): void => {}
    const activation = new Promise<void>((resolve) => { finishActivation = resolve })
    const deactivate = vi.fn().mockResolvedValue(undefined)
    const pairing: MobilePairingActions = {
      getSnapshot: () => ready,
      subscribe: () => () => {},
      completeLink: vi.fn(),
      scanQr: vi.fn(),
      retryPairing: vi.fn(),
      selectDesktop: vi.fn(),
      activate: vi.fn(() => activation),
      deactivate,
      unpair: vi.fn().mockResolvedValue(undefined),
    }
    render(createElement(MobileAccount, { installation, pairing, locale: 'zh', theme: 'light', clock }))

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => { expect(screen.getByRole('button', { name: '使用 GitHub 继续' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '使用 GitHub 继续' }))
    await screen.findByText('未连接')
    fireEvent.click(screen.getByRole('button', { name: '查看账号' }))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    await screen.findByRole('button', { name: '使用 GitHub 继续' })
    expect(deactivate).toHaveBeenCalledOnce()
    finishActivation()
    await activation
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
