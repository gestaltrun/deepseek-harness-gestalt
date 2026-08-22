/** Desktop Host Account lifecycle over a REAL Loader and TCP Platform composition. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { selectPlatformEnvironment, validatePlatformEnvironmentPair } from '@deepseek-ai/dsh-platform-account'
import { PlatformAccountHttpTransport } from '@deepseek-ai/dsh-platform-account-client'
import {
  ACCESS_TOKEN_TTL_MS,
  MemoryAccountBackend as FixtureAccountBackend,
  MemoryAccountInvalidationBus as FixtureAccountInvalidationBus,
  PlatformAccount,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import * as PlatformAccountHttp from '@deepseek-ai/dsh-platform-account-http/src/index.ts'
import WebServer from '@deepseek-ai/dsh-host-webserver/src/index.ts'
import { DesktopAccountController, EncryptedDesktopAccountStore } from '../src/platform-account.ts'

const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://platform.dev.example.com',
    callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'desktop-fixture-development', credentialReference: 'credentials://development',
    databaseIdentity: 'desktop-fixture-database-development', identityNamespace: 'desktop-fixture-development',
  },
  production: {
    environment: 'production', origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'desktop-fixture-production', credentialReference: 'credentials://production',
    databaseIdentity: 'desktop-fixture-database-production', identityNamespace: 'desktop-fixture-production',
  },
}), 'development')

/** UTF-8 passthrough standing in for Electron safeStorage in composition tests. */
const passthroughProtection = {
  encrypt: (value: string) => new TextEncoder().encode(value),
  decrypt: (value: Uint8Array) => new TextDecoder().decode(value),
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Desktop Platform Account over an HTTP fixture', () => {
  it('signs in through the system browser, restores after restart, refreshes, and invalidates its session on sign-out', { timeout: 60_000 }, async () => {
    let now = Date.parse('2026-08-19T09:00:00.000Z')
    let callback: { code: string; state: string } | undefined
    const github: GitHubIdentityProvider = {
      environment: ENVIRONMENT,
      authorizationUrl(input) {
        callback = { code: 'desktop-fixture-code', state: input.state }
        const url = new URL('https://github.com/login/oauth/authorize')
        url.searchParams.set('client_id', ENVIRONMENT.githubClientId)
        url.searchParams.set('redirect_uri', input.callbackUrl)
        url.searchParams.set('state', input.state)
        url.searchParams.set('code_challenge', input.codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        return url.href
      },
      async exchange() {
        return { providerSubject: 13994321, login: 'fixture-account', avatarUrl: 'https://avatars.example/fixture-account' }
      },
    }
    const provider = {
      name: 'desktop-fixture-platform-account-provider',
      apply(ctx: Context) {
        new PlatformAccount(ctx, {
          backend: new FixtureAccountBackend(ENVIRONMENT.databaseIdentity),
          invalidation: new FixtureAccountInvalidationBus(),
          github,
          environment: ENVIRONMENT,
          clock: { now: () => now },
          config: { tokenSigningKey: Buffer.alloc(32, 7), pollingSigningKey: Buffer.alloc(32, 9) },
        })
      },
    }
    const loaded = await bootPlatform(provider)
    const networkFetch = platformFetch(loaded.port)
    const transport = new PlatformAccountHttpTransport({ environment: ENVIRONMENT, fetch: networkFetch })
    const polls: Array<() => void> = []
    const opened = vi.fn()
    const controller = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport,
      store: new EncryptedDesktopAccountStore(join(loaded.root, 'platform-account.bin'), passthroughProtection),
      systemBrowser: { open: opened },
      schedule: (task) => {
        polls.push(task)
        return { unref: () => {} } as ReturnType<typeof setTimeout>
      },
      now: () => now,
    })

    await controller.start()
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', privacyAccepted: false })
    await expect(controller.beginLogin()).rejects.toThrow('privacy notice must be accepted before authorization')
    await controller.acceptPrivacy()
    await controller.beginLogin()
    expect(controller.getSnapshot()).toMatchObject({ status: 'polling' })
    const openedUrl = new URL(opened.mock.calls[0]?.[0] as string)
    expect(openedUrl.origin + openedUrl.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(openedUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(openedUrl.searchParams.has('scope')).toBe(false)
    expect(openedUrl.searchParams.get('redirect_uri')).toBe(ENVIRONMENT.callbackUrl)
    expect(openedUrl.searchParams.has('access_token')).toBe(false)
    expect(openedUrl.searchParams.has('refresh_token')).toBe(false)
    expect(openedUrl.searchParams.has('token')).toBe(false)
    expect(openedUrl.hash).toBe('')
    if (callback === undefined) throw new Error('composition provider did not receive authorization input')
    const authorization = await networkFetch(`${ENVIRONMENT.callbackUrl}?${new URLSearchParams(callback)}`)
    expect(authorization.status).toBe(200)
    polls.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('signed-in') }, { timeout: 10_000 })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'signed-in',
      account: { githubLogin: 'fixture-account', githubId: 13994321 },
    })
    const firstAuthorization = await controller.authorizeCurrentInstallation()
    expect(firstAuthorization.accessToken).not.toBe('')
    await controller.dispose()

    const restart = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport,
      store: new EncryptedDesktopAccountStore(join(loaded.root, 'platform-account.bin'), passthroughProtection),
      systemBrowser: { open: () => {} },
      schedule: (task) => {
        polls.push(task)
        return { unref: () => {} } as ReturnType<typeof setTimeout>
      },
      now: () => now,
    })
    await restart.start()
    expect(restart.getSnapshot()).toMatchObject({ status: 'signed-in', account: { githubLogin: 'fixture-account' } })

    now += ACCESS_TOKEN_TTL_MS + 1
    const rotated = await restart.authorizeCurrentInstallation()
    expect(rotated.accessToken).not.toBe(firstAuthorization.accessToken)
    expect(rotated.accessToken).not.toBe('')

    await restart.signOut()
    expect(restart.getSnapshot()).toMatchObject({ status: 'idle' })
    await expect(transport.current(rotated)).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    await restart.dispose()

    const afterSignOut = new DesktopAccountController({
      environment: ENVIRONMENT,
      transport,
      store: new EncryptedDesktopAccountStore(join(loaded.root, 'platform-account.bin'), passthroughProtection),
      systemBrowser: { open: () => {} },
      schedule: (task) => {
        polls.push(task)
        return { unref: () => {} } as ReturnType<typeof setTimeout>
      },
      now: () => now,
    })
    await afterSignOut.start()
    expect(afterSignOut.getSnapshot()).toMatchObject({ status: 'idle' })
    await afterSignOut.dispose()
  })
})

function platformFetch(port: number): typeof fetch {
  return async (input, init = {}) => {
    const source = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    headers.set('origin', ENVIRONMENT.origin)
    return fetch(`http://127.0.0.1:${String(port)}${source.pathname}${source.search}`, { ...init, headers })
  }
}

async function bootPlatform(provider: unknown): Promise<{ root: string; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-desktop-platform-account-fixture-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: 'desktop-fixture-platform-account-provider'",
    "- name: '@deepseek-ai/dsh-platform-account-http'",
    `  config:\n    origin: '${ENVIRONMENT.origin}'`,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['desktop-fixture-platform-account-provider', provider],
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
  if (typeof webServer.port !== 'number') throw new Error('desktop composition exposed no WebServer port')
  return { root, port: webServer.port }
}
