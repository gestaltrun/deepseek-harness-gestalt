/** REAL Loader and TCP composition for the complete Platform Account HTTP lifecycle. */

import { webcrypto } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  AccountError,
  parseInstallationId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
  accountStorageNamespace,
} from '@deepseek-ai/dsh-platform-account-client'
import {
  ACCESS_TOKEN_TTL_MS,
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as PlatformAccountHttp from '../src/index.ts'

const ENVIRONMENT_PAIR = validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://platform.dev.example.com',
    callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'assembled-development', credentialReference: 'credentials://development',
    databaseIdentity: 'assembled-database-development', identityNamespace: 'assembled-development',
  },
  production: {
    environment: 'production', origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'assembled-production', credentialReference: 'credentials://production',
    databaseIdentity: 'assembled-database-production', identityNamespace: 'assembled-production',
  },
})

const ENVIRONMENT = selectPlatformEnvironment(ENVIRONMENT_PAIR, 'development')
const PRODUCTION = selectPlatformEnvironment(ENVIRONMENT_PAIR, 'production')

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const loaded of contexts) await loaded.fiber.dispose()
  contexts.length = 0
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.length = 0
})

describe('real Platform Account HTTP composition', () => {
  it.each([
    { label: 'missing', origin: undefined },
    { label: 'mismatched', origin: 'https://platform.example.com' },
  ])('fails Loader composition for a $label HTTP origin before traffic', async ({ origin }) => {
    let failure: unknown
    try {
      await loadComposition(validationProvider(ENVIRONMENT), origin)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toContain(
      origin === undefined ? 'origin' : 'does not match the selected Platform environment',
    )
  })

  it('boots Loader and proves P-256 polling, rotation, JSON parsing, and cross-instance sign-out', { timeout: 60_000 }, async () => {
    let now = Date.parse('2026-08-17T10:00:00.000Z')
    const backend = new MemoryAccountBackend(ENVIRONMENT.databaseIdentity)
    const invalidation = new MemoryAccountInvalidationBus()
    let secondary: PlatformAccount | undefined
    let callback: { code: string; state: string } | undefined
    const github: GitHubIdentityProvider = {
      environment: ENVIRONMENT,
      authorizationUrl(input) {
        callback = { code: 'assembled-code', state: input.state }
        const url = new URL('https://github.com/login/oauth/authorize')
        url.searchParams.set('client_id', ENVIRONMENT.githubClientId)
        url.searchParams.set('redirect_uri', input.callbackUrl)
        url.searchParams.set('state', input.state)
        url.searchParams.set('code_challenge', input.codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        return url.href
      },
      async exchange() {
        return { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
      },
    }
    const Provider = {
      name: 'assembled-platform-account-provider',
      apply(ctx: Context) {
        const options = {
          backend, invalidation, github, environment: ENVIRONMENT,
          config: { tokenSigningKey: Buffer.alloc(32, 7), pollingSigningKey: Buffer.alloc(32, 9) },
          clock: { now: () => now },
        }
        new PlatformAccount(ctx, options)
        secondary = new PlatformAccount(new Context(), options)
      },
    }
    const loaded = await loadComposition(Provider, ENVIRONMENT.origin)
    const port = loaded.webServer.port
    const requests: Array<{ url: string; init: RequestInit }> = []
    const networkFetch: typeof fetch = async (input, init = {}) => {
      const source = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const headers = new Headers(init.headers)
      headers.set('origin', ENVIRONMENT.origin)
      const target = `http://127.0.0.1:${String(port)}${source.pathname}${source.search}`
      requests.push({ url: source.href, init: { ...init, headers } })
      return fetch(target, { ...init, headers })
    }
    const transport = new PlatformAccountHttpTransport({ environment: ENVIRONMENT, fetch: networkFetch })
    const store = new MemoryInstallationAccountStore()
    const opened = vi.fn()
    const installation = new PlatformAccountInstallation({
      environment: ENVIRONMENT,
      installationId: parseInstallationId('assembled-desktop'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      transport,
      store,
      systemBrowser: { open: opened },
      crypto: webcrypto as Crypto,
      now: () => now,
    })

    installation.acceptPrivacy()
    await installation.beginLogin()
    const authorization = new URL(opened.mock.calls[0]?.[0] as string)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.has('scope')).toBe(false)
    expect(authorization.searchParams.get('redirect_uri')).toBe(ENVIRONMENT.callbackUrl)
    if (callback === undefined) throw new Error('assembled provider did not receive authorization input')
    const callbackResponse = await networkFetch(`${ENVIRONMENT.callbackUrl}?${new URLSearchParams(callback)}`)
    expect(callbackResponse.status).toBe(200)
    const polled = await installation.pollLogin()
    if (polled.status !== 'complete') throw new Error('assembled login remained pending')
    expect(installation.getSnapshot()).toMatchObject({ status: 'signed-in', account: { githubLogin: 'octocat' } })

    const instance = requireSecondary(secondary)
    const close = vi.fn()
    await instance.trackConnection(polled.sessionId, close)
    const initialRefresh = polled.refreshToken
    now += ACCESS_TOKEN_TTL_MS + 1
    await installation.load()
    const rotated = await store.loadSession('development')
    expect(rotated?.session.refreshToken).not.toBe(initialRefresh)
    expect(rotated?.session.refreshExpiresAt).toBe(polled.refreshExpiresAt)

    await installation.signOut()
    expect(close).toHaveBeenCalledOnce()
    expect(await store.loadSession('development')).toBeUndefined()
    const proofRequest = requests.find(request => request.url.endsWith('/v1/account/session'))
    const proofHeaders = new Headers(proofRequest?.init.headers)
    expect(proofHeaders.get('x-gestalt-proof-jti')).not.toBeNull()
    expect(proofHeaders.get('x-gestalt-proof-signature')).not.toBeNull()
    expect(requests.every(request => request.url.startsWith(ENVIRONMENT.origin))).toBe(true)
  })

  it('signs in two installations, isolates an account switch, and revokes only the signing-out installation', { timeout: 60_000 }, async () => {
    let now = Date.parse('2026-08-18T09:00:00.000Z')
    const githubUsers = [
      { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
      { providerSubject: 721119, login: 'mona', avatarUrl: 'https://avatars.example/mona' },
      { providerSubject: 5558901, login: 'newman', avatarUrl: 'https://avatars.example/newman' },
    ]
    const callbacks: Array<{ code: string; state: string }> = []
    let exchangeCount = 0
    let secondary: PlatformAccount | undefined
    const github: GitHubIdentityProvider = {
      environment: ENVIRONMENT,
      authorizationUrl(input) {
        callbacks.push({ code: `code-${String(callbacks.length)}`, state: input.state })
        const url = new URL('https://github.com/login/oauth/authorize')
        url.searchParams.set('client_id', ENVIRONMENT.githubClientId)
        url.searchParams.set('redirect_uri', input.callbackUrl)
        url.searchParams.set('state', input.state)
        url.searchParams.set('code_challenge', input.codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        return url.href
      },
      async exchange() {
        const user = githubUsers[exchangeCount]
        exchangeCount += 1
        if (user === undefined) throw new Error('assembled provider ran out of GitHub users')
        return user
      },
    }
    const Provider = {
      name: 'assembled-platform-account-provider',
      apply(ctx: Context) {
        const options = {
          backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
          invalidation: new MemoryAccountInvalidationBus(),
          github, environment: ENVIRONMENT,
          config: { tokenSigningKey: Buffer.alloc(32, 7), pollingSigningKey: Buffer.alloc(32, 9) },
          clock: { now: () => now },
        }
        new PlatformAccount(ctx, options)
        secondary = new PlatformAccount(new Context(), options)
      },
    }
    const loaded = await loadComposition(Provider, ENVIRONMENT.origin)
    const port = loaded.webServer.port
    const networkFetch = environmentFetch(ENVIRONMENT, port)
    const transport = new PlatformAccountHttpTransport({ environment: ENVIRONMENT, fetch: networkFetch })
    const desktopStore = new MemoryInstallationAccountStore()
    const desktop = new PlatformAccountInstallation({
      environment: ENVIRONMENT,
      installationId: parseInstallationId('two-installation-desktop'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      transport,
      store: desktopStore,
      systemBrowser: { open: () => {} },
      crypto: webcrypto as Crypto,
      now: () => now,
    })
    const mobile = new PlatformAccountInstallation({
      environment: ENVIRONMENT,
      installationId: parseInstallationId('two-installation-mobile'),
      installationKind: 'mobile',
      presentation: { name: 'Two-installation mobile', platform: 'android' },
      transport,
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: () => {} },
      crypto: webcrypto as Crypto,
      now: () => now,
    })

    desktop.acceptPrivacy()
    mobile.acceptPrivacy()
    await desktop.beginLogin()
    await mobile.beginLogin()
    await completeCallback(networkFetch, ENVIRONMENT, callbacks[0])
    await completeCallback(networkFetch, ENVIRONMENT, callbacks[1])
    const desktopFirst = await desktop.pollLogin()
    const mobileFirst = await mobile.pollLogin()
    if (desktopFirst.status !== 'complete' || mobileFirst.status !== 'complete') {
      throw new Error('assembled two-installation login remained pending')
    }
    expect(desktop.getSnapshot().account?.githubLogin).toBe('octocat')
    expect(mobile.getSnapshot().account?.githubLogin).toBe('mona')
    expect(desktopFirst.sessionId).not.toBe(mobileFirst.sessionId)

    desktopStore.setAccountMaterial(desktopFirst.account.id, 'pairing-key', 'octocat-pairing-key')
    desktopStore.setAccountMaterial(desktopFirst.account.id, 'receipt', 'octocat-receipt')

    const instance = requireSecondary(secondary)
    const desktopReplacedClosed = vi.fn()
    const mobileClosed = vi.fn()
    await instance.trackConnection(desktopFirst.sessionId, desktopReplacedClosed)
    await instance.trackConnection(mobileFirst.sessionId, mobileClosed)

    await desktop.beginLogin()
    await completeCallback(networkFetch, ENVIRONMENT, callbacks[2])
    const desktopSecond = await desktop.pollLogin()
    if (desktopSecond.status !== 'complete') throw new Error('assembled account switch remained pending')
    expect(desktop.getSnapshot().account?.githubLogin).toBe('newman')
    expect(desktopReplacedClosed).toHaveBeenCalledOnce()
    expect(mobileClosed).not.toHaveBeenCalled()
    expect(accountStorageNamespace('development', desktopFirst.account.id))
      .not.toBe(accountStorageNamespace('development', desktopSecond.account.id))
    expect(desktopStore.getAccountMaterial(desktopFirst.account.id, 'pairing-key')).toBe('octocat-pairing-key')
    expect(desktopStore.getAccountMaterial(desktopFirst.account.id, 'receipt')).toBe('octocat-receipt')
    expect(desktopStore.getAccountMaterial(desktopSecond.account.id, 'pairing-key')).toBeUndefined()
    expect(desktopStore.getAccountMaterial(desktopSecond.account.id, 'receipt')).toBeUndefined()
    now += ACCESS_TOKEN_TTL_MS + 1
    await mobile.load()
    expect(mobile.getSnapshot()).toMatchObject({ status: 'signed-in', account: { githubLogin: 'mona' } })
    await desktop.load()
    expect(desktop.getSnapshot()).toMatchObject({ status: 'signed-in', account: { githubLogin: 'newman' } })

    const desktopSignedOutClosed = vi.fn()
    await instance.trackConnection(desktopSecond.sessionId, desktopSignedOutClosed)
    await desktop.signOut()
    expect(desktopSignedOutClosed).toHaveBeenCalledOnce()
    expect(mobileClosed).not.toHaveBeenCalled()
    expect(mobile.getSnapshot().status).toBe('signed-in')
    expect(desktopStore.getAccountMaterial(desktopFirst.account.id, 'pairing-key')).toBe('octocat-pairing-key')
    expect(desktopStore.getAccountMaterial(desktopFirst.account.id, 'receipt')).toBe('octocat-receipt')
    await mobile.signOut()
    expect(mobileClosed).toHaveBeenCalledOnce()
  })

  it('rejects a development session inside the production identity namespace', { timeout: 60_000 }, async () => {
    const now = Date.parse('2026-08-18T11:00:00.000Z')
    const callbacks: Array<{ code: string; state: string }> = []
    const provider = (environment: SelectedPlatformEnvironment) => ({
      name: 'assembled-platform-account-provider',
      apply(ctx: Context) {
        new PlatformAccount(ctx, {
          backend: new MemoryAccountBackend(environment.databaseIdentity),
          invalidation: new MemoryAccountInvalidationBus(),
          github: {
            environment,
            authorizationUrl(input) {
              callbacks.push({ code: `code-${String(callbacks.length)}`, state: input.state })
              return `https://github.com/login/oauth/authorize?state=${input.state}`
            },
            async exchange() {
              return { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
            },
          },
          environment,
          clock: { now: () => now },
          config: {
            tokenSigningKey: Buffer.alloc(32, 7),
            pollingSigningKey: Buffer.alloc(32, 9),
          },
        })
      },
    })

    const development = await loadComposition(provider(ENVIRONMENT), ENVIRONMENT.origin)
    const developmentTransport = new PlatformAccountHttpTransport({
      environment: ENVIRONMENT,
      fetch: environmentFetch(ENVIRONMENT, development.webServer.port),
    })
    const installation = new PlatformAccountInstallation({
      environment: ENVIRONMENT,
      installationId: parseInstallationId('cross-environment-desktop'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      transport: developmentTransport,
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: () => {} },
      crypto: webcrypto as Crypto,
      now: () => now,
    })
    installation.acceptPrivacy()
    await installation.beginLogin()
    await completeCallback(environmentFetch(ENVIRONMENT, development.webServer.port), ENVIRONMENT, callbacks[0])
    const polled = await installation.pollLogin()
    if (polled.status !== 'complete') throw new Error('assembled development login remained pending')

    const production = await loadComposition(provider(PRODUCTION), PRODUCTION.origin)
    const productionTransport = new PlatformAccountHttpTransport({
      environment: PRODUCTION,
      fetch: environmentFetch(PRODUCTION, production.webServer.port),
    })
    expect(PRODUCTION.origin).not.toBe(ENVIRONMENT.origin)
    expect(PRODUCTION.githubClientId).not.toBe(ENVIRONMENT.githubClientId)
    expect(PRODUCTION.callbackUrl).not.toBe(ENVIRONMENT.callbackUrl)
    expect(PRODUCTION.credentialReference).not.toBe(ENVIRONMENT.credentialReference)
    expect(PRODUCTION.databaseIdentity).not.toBe(ENVIRONMENT.databaseIdentity)
    expect(PRODUCTION.identityNamespace).not.toBe(ENVIRONMENT.identityNamespace)

    const authorization = await installation.authorizeCurrentInstallation()
    await expect(productionTransport.current(authorization)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
      message: 'access token belongs to another identity namespace',
    } satisfies Partial<AccountError>)
  })
})

function requireSecondary(secondary: PlatformAccount | undefined): PlatformAccount {
  expect(secondary).toBeDefined()
  if (secondary === undefined) throw new Error('assembled provider did not install a secondary PlatformAccount')
  return secondary
}

function environmentFetch(environment: SelectedPlatformEnvironment, port: number): typeof fetch {
  return async (input, init = {}) => {
    const source = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    headers.set('origin', environment.origin)
    return fetch(`http://127.0.0.1:${String(port)}${source.pathname}${source.search}`, { ...init, headers })
  }
}

async function completeCallback(
  networkFetch: typeof fetch,
  environment: SelectedPlatformEnvironment,
  callback: { code: string; state: string } | undefined,
): Promise<void> {
  if (callback === undefined) throw new Error('assembled provider did not receive authorization input')
  const response = await networkFetch(`${environment.callbackUrl}?${new URLSearchParams(callback)}`)
  expect(response.status).toBe(200)
}

function validationProvider(environment: SelectedPlatformEnvironment): unknown {
  return {
    name: 'assembled-platform-account-provider',
    apply(ctx: Context) {
      const backend = new MemoryAccountBackend(environment.databaseIdentity)
      const github: GitHubIdentityProvider = {
        environment,
        authorizationUrl: () => 'https://github.com/login/oauth/authorize',
        async exchange() {
          return { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
        },
      }
      new PlatformAccount(ctx, {
        backend,
        invalidation: new MemoryAccountInvalidationBus(),
        github,
        environment,
        config: { tokenSigningKey: Buffer.alloc(32, 7), pollingSigningKey: Buffer.alloc(32, 9) },
      })
    },
  }
}

async function loadComposition(
  provider: unknown,
  origin: string | undefined,
): Promise<{ context: Context; webServer: { port: number } }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-platform-account-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: 'assembled-platform-account-provider'",
    "- name: '@deepseek-ai/dsh-platform-account-http'",
    ...(origin === undefined ? [] : ['  config:', `    origin: '${origin}'`]),
    '',
  ].join('\n'))
  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['assembled-platform-account-provider', provider],
    ['@deepseek-ai/dsh-platform-account-http', PlatformAccountHttp],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const webServer = context.get('webServer') as unknown as { port: number }
  if (typeof webServer.port !== 'number') throw new Error('assembled composition exposed no WebServer port')
  return { context, webServer }
}
