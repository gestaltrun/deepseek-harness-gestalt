/** REAL Loader and TCP composition for open-registration Account quotas. */

import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  ACCOUNT_CONCURRENT_CONNECTION_LIMIT,
  ACCOUNT_DESKTOP_INSTALLATION_LIMIT,
  ACCOUNT_MOBILE_INSTALLATION_LIMIT,
  OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  parseAccountProofJti,
  selectPlatformEnvironment,
  type AccountSessionId,
  validatePlatformEnvironmentPair,
  type AccountProof,
  type InstallationKind,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  accountProofPayload,
  hashAccountToken,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as PlatformAccountHttp from '../src/index.ts'

const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://platform.dev.example.com',
    callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'quota-development', credentialReference: 'credentials://development',
    databaseIdentity: 'quota-database-development', identityNamespace: 'quota-development',
  },
  production: {
    environment: 'production', origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'quota-production', credentialReference: 'credentials://production',
    databaseIdentity: 'quota-database-production', identityNamespace: 'quota-production',
  },
}), 'development')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('assembled open-registration Account quotas', () => {
  it('enforces installation and connection ceilings and sheds login at capacity over real HTTP', {
    timeout: 60_000,
  }, async () => {
    const now = { value: Date.parse('2026-08-19T10:00:00.000Z') }
    const capacity = { shedding: false, retryAfterSeconds: 45 }
    const backend = new MemoryAccountBackend(ENVIRONMENT.databaseIdentity)
    const invalidation = new MemoryAccountInvalidationBus()
    let account: PlatformAccount | undefined
    const github: GitHubIdentityProvider = {
      environment: ENVIRONMENT,
      authorizationUrl(input) {
        const url = new URL('https://github.com/login/oauth/authorize')
        url.searchParams.set('client_id', ENVIRONMENT.githubClientId)
        url.searchParams.set('redirect_uri', input.callbackUrl)
        url.searchParams.set('state', input.state)
        url.searchParams.set('code_challenge', input.codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        return url.href
      },
      async exchange() {
        return { providerSubject: 4242, login: 'quota-user', avatarUrl: 'https://avatars.example/quota' }
      },
    }
    const loaded = await loadComposition({
      name: 'assembled-quota-account',
      apply(ctx: Context) {
        account = new PlatformAccount(ctx, {
          backend, invalidation, github, environment: ENVIRONMENT, capacity,
          config: { tokenSigningKey: Buffer.alloc(32, 7), pollingSigningKey: Buffer.alloc(32, 9) },
          clock: { now: () => now.value },
        })
      },
    })
    const port = loaded.webServer.port
    const fetchPlatform = createFetch(port)

    await signIn(fetchPlatform, 'desktop-0', 'desktop')
    for (let index = 1; index < ACCOUNT_DESKTOP_INSTALLATION_LIMIT; index += 1) {
      await signIn(fetchPlatform, `desktop-${String(index)}`, 'desktop')
    }
    const overDesktop = await beginAndAuthorize(fetchPlatform, 'desktop-over', 'desktop')
    const desktopRejected = await fetchPlatform('/v1/account/login-poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: overDesktop.attempt.id,
        pollingToken: overDesktop.attempt.pollingToken,
        proof: overDesktop.key.proof(
          'login-poll',
          `${overDesktop.attempt.id}:${hashAccountToken(overDesktop.attempt.pollingToken)}`,
        ),
      }),
    })
    expect(desktopRejected.status).toBe(429)
    expect(desktopRejected.headers.get('retry-after')).toBe(String(OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS))
    await expect(desktopRejected.json()).resolves.toMatchObject({
      error: { code: 'QUOTA', retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS },
    })
    const replacedDesktop = await signIn(fetchPlatform, 'desktop-0', 'desktop')

    for (let index = 0; index < ACCOUNT_MOBILE_INSTALLATION_LIMIT; index += 1) {
      await signIn(fetchPlatform, `mobile-${String(index)}`, 'mobile')
    }
    const overMobile = await beginAndAuthorize(fetchPlatform, 'mobile-over', 'mobile')
    const mobileRejected = await fetchPlatform('/v1/account/login-poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: overMobile.attempt.id,
        pollingToken: overMobile.attempt.pollingToken,
        proof: overMobile.key.proof(
          'login-poll',
          `${overMobile.attempt.id}:${hashAccountToken(overMobile.attempt.pollingToken)}`,
        ),
      }),
    })
    expect(mobileRejected.status).toBe(429)

    let identity = { providerSubject: 4242, login: 'quota-user', avatarUrl: 'https://avatars.example/quota' }
    github.exchange = async () => identity
    identity = { providerSubject: 99, login: 'other', avatarUrl: 'https://avatars.example/other' }
    const second = await signIn(fetchPlatform, 'other-desktop', 'desktop')
    expect(second.sessionId).toEqual(expect.any(String))

    if (account === undefined) throw new Error('assembled Account provider was not mounted')
    const established = vi.fn()
    await account.trackConnection(replacedDesktop.sessionId, established)
    for (let index = 1; index < ACCOUNT_CONCURRENT_CONNECTION_LIMIT; index += 1) {
      await account.trackConnection(replacedDesktop.sessionId, vi.fn())
    }
    await expect(account.trackConnection(replacedDesktop.sessionId, vi.fn())).rejects.toMatchObject({
      code: 'QUOTA', retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })
    expect(established).not.toHaveBeenCalled()

    capacity.shedding = true
    const shed = await fetchPlatform('/v1/account/login-attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: 'capacity-desktop',
        installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
        publicKey: installationKey().publicKey,
      }),
    })
    expect(shed.status).toBe(429)
    expect(shed.headers.get('retry-after')).toBe('45')
    await expect(shed.json()).resolves.toMatchObject({ error: { code: 'PLATFORM_CAPACITY', retryAfter: 45 } })
    expect(established).not.toHaveBeenCalled()
  })
})

function installationKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: pair.publicKey.export({ format: 'jwk' }),
    proof(operation: string, binding: string, issuedAt = Date.parse('2026-08-19T10:00:00.000Z')): AccountProof {
      const jti = parseAccountProofJti(crypto.randomUUID())
      return {
        jti,
        issuedAt,
        signature: sign('sha256', accountProofPayload({ operation, binding, issuedAt, jti }), {
          key: pair.privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      }
    },
  }
}

function createFetch(port: number): typeof fetch {
  return async (input, init = {}) => {
    const source = new URL(
      typeof input === 'string'
        ? (input.startsWith('/') ? `${ENVIRONMENT.origin}${input}` : input)
        : input instanceof URL ? input.href : input.url,
    )
    const headers = new Headers(init.headers)
    headers.set('origin', ENVIRONMENT.origin)
    return fetch(`http://127.0.0.1:${String(port)}${source.pathname}${source.search}`, { ...init, headers })
  }
}

async function beginAndAuthorize(
  fetchPlatform: typeof fetch,
  installationId: string,
  installationKind: InstallationKind,
) {
  const key = installationKey()
  const started = await fetchPlatform('/v1/account/login-attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installationId,
      installationKind,
      ...(installationKind === 'mobile'
        ? { presentation: { name: `Phone ${installationId}`, platform: 'android' } }
        : { presentation: { name: `Desktop ${installationId}`, platform: 'linux' } }),
      publicKey: key.publicKey,
    }),
  })
  expect(started.status).toBe(201)
  const attempt = await started.json() as { id: string; state: string; pollingToken: string }
  const callback = await fetchPlatform(
    `${ENVIRONMENT.callbackUrl}?${new URLSearchParams({ code: 'assembled-code', state: attempt.state })}`,
  )
  expect(callback.status).toBe(200)
  return { key, attempt }
}

async function signIn(
  fetchPlatform: typeof fetch,
  installationId: string,
  installationKind: InstallationKind,
) {
  const opened = await beginAndAuthorize(fetchPlatform, installationId, installationKind)
  const polled = await fetchPlatform('/v1/account/login-poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      attemptId: opened.attempt.id,
      pollingToken: opened.attempt.pollingToken,
      proof: opened.key.proof(
        'login-poll',
        `${opened.attempt.id}:${hashAccountToken(opened.attempt.pollingToken)}`,
      ),
    }),
  })
  expect(polled.status).toBe(200)
  const body = await polled.json() as { status: string; sessionId: string }
  expect(body.status).toBe('complete')
  return { ...opened, sessionId: body.sessionId as AccountSessionId }
}

async function loadComposition(provider: unknown): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-quota-account-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: 'assembled-quota-account'",
    "- name: '@deepseek-ai/dsh-platform-account-http'",
    '  config:',
    '    origins:',
    `      - '${ENVIRONMENT.origin}'`,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['assembled-quota-account', provider],
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
  return context
}
