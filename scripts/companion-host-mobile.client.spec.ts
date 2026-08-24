// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseInstallationId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountSessionView,
  type LoginAttemptView,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountInstallation,
  type PlatformAccountTransport,
} from '@deepseek-ai/dsh-platform-account-client'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseRelayCredential,
  parseRelayRouteId,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  CompanionForegroundRuntime,
  installCompanionRuntime,
} from '../apps/mobile/src/companion-lifecycle.ts'
import { mountMobileEntry } from '../apps/mobile/src/mobile-entry.tsx'
import {
  type MobileCompanionConnectionChannel,
  type MobileCompanionMutationChannel,
} from '../apps/mobile/src/companion-surface.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const testCleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const dispose of testCleanups.splice(0).reverse()) await dispose()
  cleanup()
})

describe('Host HTTP failure Companion projection', () => {
  it('carries a real HTTP 400 through the codec into the visible Mobile alert', async () => {
    const operationId = parseCompanionOperationId('visible-host-400')
    const tsxLoader = pathToFileURL(createRequire(join(repo, 'package.json')).resolve('tsx')).href
    const probe = join(repo, 'apps', 'desktop', 'tests', 'host-400-codec-probe.ts')
    const probeResult = await startProbe(
      ['--import', tsxLoader, probe],
      10_000,
      { TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json') },
    )
    expect(probeResult).toMatchObject({ exitCode: 0, timedOut: false, isTerminated: false })
    const { stdout } = probeResult
    const protocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const decoded = decodeCompanionMessage(protocol, Buffer.from(stdout, 'base64'))
    if (decoded.type !== 'result') throw new Error('expected decoded Companion result')

    const runtime = new CompanionForegroundRuntime()
    const mutations: MobileCompanionMutationChannel = {
      create: vi.fn(),
      submit: vi.fn(),
      cancel: vi.fn(() => ({ operationId, completion: Promise.resolve() })),
      attach: vi.fn(() => ({
        operationId: parseCompanionOperationId('unused-attachment'),
        completion: Promise.resolve(),
      })),
      search: vi.fn(() => ({ operationId, completion: Promise.resolve() })),
      observeSession: vi.fn(() => ({ operationId, completion: Promise.resolve() })),
      loadOlder: vi.fn(() => ({ operationId, completion: Promise.resolve() })),
      settle: vi.fn(),
    }
    const disposeRuntime = installCompanionRuntime(runtime)
    testCleanups.push(disposeRuntime)
    const root = document.createElement('div')
    document.body.append(root)
    const mounted = mountMobileEntry(root, {
      installation: installationWithCompletedLogin(),
      companion: runtime,
    })
    testCleanups.push(() => { mounted.unmount() })
    const surface = mounted.companionSurface
    fireEvent.click(await screen.findByRole('checkbox'))
    const login = screen.getByRole('button', { name: '使用 GitHub 继续' })
    await waitFor(() => { expect(login.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(login)
    await screen.findByText('@octocat')
    runtime.configure({
      routeId: parseRelayRouteId('visible-host-400-route'),
      endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
      revision: 1,
    })
    runtime.markConnectionOpen()
    const channel: MobileCompanionConnectionChannel = {
      mutations,
      content: { loadImage: () => Promise.reject(new Error('unused image')) },
    }
    const resync = surface.bindAuthenticatedConnection(channel)
    if (resync === undefined) throw new Error('expected Desktop resync receiver')
    resync.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: 'Paired Desktop',
      sessions: {
        ids: [], byId: {}, current: null, phase: 'ready',
        subagentsByParent: {}, jobsBySession: {}, currentAddress: null,
      },
      workspaces: [],
      conversations: [],
    })
    const results = surface.bindValidatedCompanionResults()
    if (results === undefined) throw new Error('expected Companion result receiver')
    surface.search('Host 400 visible alert')
    results.acceptValidatedCompanionResult(decoded.result)

    expect((await screen.findByRole('alert')).textContent).toBe('Desktop Host returned HTTP 400')
  })

  it('terminates and reaps a stalled codec producer at its deadline', async () => {
    const result = await startProbe(['-e', 'setInterval(() => {}, 1000)'], 100)

    expect(result).toMatchObject({ timedOut: true, isTerminated: true })
  })
})

function startProbe(
  args: readonly string[],
  timeout: number,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/KEY|PASSWORD|SECRET|TOKEN/iu.test(name)),
  )
  const child = execa(process.execPath, args, {
    cleanup: true,
    env: { ...env, ...extraEnv },
    extendEnv: false,
    forceKillAfterDelay: 500,
    killSignal: 'SIGTERM',
    maxBuffer: REMOTE_PROTOCOL_LIMITS.companionMessageBytes * 2,
    reject: false,
    timeout,
  })
  testCleanups.push(async () => {
    if (child.nodeChildProcess.exitCode === null && child.nodeChildProcess.signalCode === null) {
      child.kill('SIGTERM')
    }
    await child
  })
  return child
}

const environment = selectPlatformEnvironment(validatePlatformEnvironmentPair({
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
const installationIdentity = crypto.randomUUID()
const installationPlatform = (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 2 === 0 ? 'ios' : 'android'

const attempt: LoginAttemptView = {
  id: 'attempt-host-400' as never,
  state: 'state-host-400',
  authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=mobile',
  pollingToken: 'polling-host-400',
  expiresAt: Date.now() + 300_000,
}

const accountSession: AccountSessionView = {
  sessionId: 'session-host-400' as never,
  account: {
    id: 'account-host-400' as never,
    githubId: 583231,
    githubLogin: 'octocat',
    avatarUrl: 'https://avatars.example/octocat',
  },
  accessToken: 'access-host-400',
  refreshToken: 'refresh-host-400',
  accessExpiresAt: Date.now() + 900_000,
  refreshExpiresAt: Date.now() + 2_592_000_000,
}

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
    installationId: parseInstallationId(`mobile-${installationIdentity}`),
    installationKind: 'mobile',
    presentation: { name: `Mobile ${installationIdentity}`, platform: installationPlatform },
    transport,
    store: new MemoryInstallationAccountStore(),
    systemBrowser: { open: vi.fn() },
    crypto: globalThis.crypto,
  })
}
