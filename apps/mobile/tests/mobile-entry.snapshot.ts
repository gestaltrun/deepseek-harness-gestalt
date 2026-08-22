// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseInstallationId,
  loadOperatedPlatformEnvironment,
  type AccountSessionView,
  type LoginAttemptView,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountInstallation,
  type PlatformAccountTransport,
} from '@deepseek-ai/dsh-platform-account-client'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime, installCompanionRuntime } from '../src/companion-lifecycle.ts'
import { mountMobileEntry } from '../src/mobile-entry.tsx'

const environment = loadOperatedPlatformEnvironment({
  environment: 'production', origin: 'https://platform.fixture.example',
  callbackUrl: 'https://platform.fixture.example/v1/account/oauth/github/callback',
  githubClientId: 'mobile-fixture', credentialReference: 'credentials://fixture',
  databaseIdentity: 'database-fixture', identityNamespace: 'namespace-fixture',
})

const attempt: LoginAttemptView = {
  id: 'attempt-mobile-snapshot' as never,
  state: 'state-mobile-snapshot',
  authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=mobile',
  pollingToken: 'polling-mobile-snapshot',
  expiresAt: Date.now() + 300_000,
}

const accountSession: AccountSessionView = {
  sessionId: 'session-mobile-snapshot' as never,
  account: {
    id: 'account-mobile-snapshot' as never,
    githubId: 583231,
    githubLogin: 'fixture-account',
    avatarUrl: 'https://avatars.example/fixture-account',
  },
  accessToken: 'access-mobile-snapshot',
  refreshToken: 'refresh-mobile-snapshot',
  accessExpiresAt: Date.now() + 900_000,
  refreshExpiresAt: Date.now() + 2_592_000_000,
}

afterEach(cleanup)

describe('Mobile shipped entry foreground mutation gate', () => {
  it('keeps every human-visible mutation control disabled before current-generation validated resync', async () => {
    const runtime = new CompanionForegroundRuntime()
    const disposeRuntime = installCompanionRuntime(runtime)
    const installation = installationWithCompletedLogin()
    const root = document.createElement('div')
    document.body.append(root)

    const mounted = mountMobileEntry(root, { installation, companion: runtime })
    const surface = mounted.companionSurface

    fireEvent.click(await screen.findByRole('checkbox'))
    const login = screen.getByRole('button', { name: '使用 GitHub 继续' })
    await waitFor(() => { expect(login.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(login)
    await screen.findByText('@fixture-account')

    runtime.configure({
      routeId: parseRelayRouteId('route-mobile-snapshot'),
      endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
      revision: 1,
    })
    runtime.markConnectionOpen()
    const firstResync = surface.bindValidatedDesktopResync()
    if (firstResync === undefined) throw new Error('expected first Desktop surface resync receiver')
    firstResync.acceptValidatedDesktopResync({
      type: 'desktop-resync',
      version: 1,
      authenticated: true,
      sessions: [{
        id: 'guarded-session',
        title: 'Guarded Session',
        workspace: 'Work',
        summary: 'Pending Desktop work',
        blocks: [
          { kind: 'approval', summary: 'Allow write' },
          { kind: 'ask-user', question: 'Continue?' },
        ],
      }],
      streaming: true,
    })
    await screen.findByRole('button', { name: /Guarded Session/ })

    runtime.forgetConnection()
    runtime.markConnectionOpen()
    firstResync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true, sessions: [], streaming: false,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建 Ungrouped Session' }).hasAttribute('disabled')).toBe(true)
    })
    expect(visibleMutationControls()).toMatchInlineSnapshot(`
      [
        "button:新建 Ungrouped Session:disabled",
        "button:在 Work 新建 Session:disabled",
      ]
    `)

    fireEvent.click(screen.getByRole('button', { name: /Guarded Session/ }))
    expect(visibleMutationControls()).toMatchInlineSnapshot(`
      [
        "button:允许:disabled",
        "button:允许:disabled",
        "textbox:继续会话:disabled",
        "button:发送:disabled",
        "button:取消:disabled",
        "button:添加附件:disabled",
      ]
    `)

    mounted.unmount()
    disposeRuntime()
  })
})

function installationWithCompletedLogin(): PlatformAccountInstallation {
  const transport: PlatformAccountTransport = {
    environment,
    beginLogin: vi.fn<PlatformAccountTransport['beginLogin']>().mockResolvedValue(attempt),
    pollLogin: vi.fn<PlatformAccountTransport['pollLogin']>().mockResolvedValue({
      status: 'complete', ...accountSession,
    }),
    refresh: vi.fn<PlatformAccountTransport['refresh']>(),
    current: vi.fn<PlatformAccountTransport['current']>(),
    signOut: vi.fn<PlatformAccountTransport['signOut']>().mockResolvedValue(undefined),
  }
  return new PlatformAccountInstallation({
    environment,
    installationId: parseInstallationId('mobile-snapshot'),
    installationKind: 'mobile',
    transport,
    store: new MemoryInstallationAccountStore(),
    systemBrowser: { open: vi.fn() },
    crypto: globalThis.crypto,
  })
}

function visibleMutationControls(): string[] {
  const names = new Set(['新建 Ungrouped Session', '在 Work 新建 Session', '允许', '继续会话', '发送', '取消', '添加附件'])
  return [...document.querySelectorAll('button, textarea')].flatMap((element) => {
    const name = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''
    if (!names.has(name)) return []
    const role = element.getAttribute('role') ?? (element instanceof HTMLTextAreaElement ? 'textbox' : 'button')
    return [`${role}:${name}:${element.hasAttribute('disabled') ? 'disabled' : 'enabled'}`]
  })
}
