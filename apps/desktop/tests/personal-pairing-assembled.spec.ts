/** REAL Loader composition: Desktop and Mobile controllers pair through keyless HTTP. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  parseAccountProofJti,
  parseInstallationId,
  parsePlatformAccountId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
} from '@deepseek-ai/dsh-platform-account'
import {
  DevelopmentKeylessPairingHandshakeProvider,
  PAIRING_CHALLENGE_TTL_MS,
  PersonalPairingProvider,
  RemoteAccessError,
  deriveKeylessMobileHandshake,
  deriveKeylessPairingKey,
  parsePairingCompletionId,
  parsePairingInvitationLink,
  type PairingAccountAuthentication,
} from '@deepseek-ai/dsh-remote-access'
import { RemoteAccessHttpTransport } from '@deepseek-ai/dsh-remote-access-client'
import { DesktopPairingKeyVault } from '../src/pairing-keys.ts'
import { DesktopPairingController } from '../src/personal-pairing.ts'
import { PairingCompanionKeyVault } from '../../mobile/src/companion-keys.ts'
import { KeylessMobileHandshakeFixture } from '../../mobile/tests/fixtures/development-keyless-pairing.fixture.ts'
import { MobilePairingController } from '../../mobile/src/personal-pairing.ts'
import * as RemoteAccessHttp from '../../../packages/platform/remote-access-http/src/index.ts'

const ORIGIN = 'https://platform.dev.example.com'
const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development',
    origin: ORIGIN,
    callbackUrl: `${ORIGIN}/v1/account/oauth/github/callback`,
    githubClientId: 'assembled-pairing-development',
    credentialReference: 'credentials://assembled-pairing-development',
    databaseIdentity: 'assembled-pairing-development',
    identityNamespace: 'assembled-pairing-development',
  },
  production: {
    environment: 'production',
    origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'assembled-pairing-production',
    credentialReference: 'credentials://assembled-pairing-production',
    databaseIdentity: 'assembled-pairing-production',
    identityNamespace: 'assembled-pairing-production',
  },
}), 'development')

const clock = { now: Date.parse('2026-08-19T10:00:00.000Z') }
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const loaded of contexts) await loaded.fiber.dispose()
  contexts.length = 0
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.length = 0
  clock.now = Date.parse('2026-08-19T10:00:00.000Z')
})

describe('Personal Pairing assembled controllers', () => {
  it('pairs the same account through Loader HTTP and keeps Mobile Access in the controller path', {
    timeout: 60_000,
  }, async () => {
    const loaded = await loadComposition()
    const transport = new RemoteAccessHttpTransport({
      environment: ENVIRONMENT,
      fetch: rewriteFetch(loaded.port),
    })
    const desktopKeys = new DesktopPairingKeyVault()
    const mobileKeys = new PairingCompanionKeyVault()
    const desktop = new DesktopPairingController({
      account: accountActions('desktop'),
      transport,
      pairingKeys: desktopKeys,
      now: () => clock.now,
      pollIntervalMs: 20,
    })
    const mobile = new MobilePairingController({
      installation: accountActions('mobile'),
      transport,
      handshake: new KeylessMobileHandshakeFixture(),
      scanner: { scan: async () => { throw new Error('assembled path uses the full one-time link') } },
      pairingKeys: mobileKeys,
      device: { name: 'Alice phone', platform: 'ios' },
      now: () => clock.now,
      pollIntervalMs: 20,
    })

    await desktop.start()
    expect(desktop.getSnapshot()).toMatchObject({ status: 'ready', enabled: false, pairings: [] })

    await desktop.setEnabled(true)
    await desktop.createChallenge()
    const foreignChallenge = desktop.getSnapshot().challenge
    if (foreignChallenge === undefined) throw new Error('Desktop Settings did not project a Pairing Challenge')
    expect(foreignChallenge.oneTimeLink).toBe(foreignChallenge.qrPayload)
    expect(foreignChallenge.oneTimeLink.startsWith('https://')).toBe(true)
    expect(foreignChallenge.expiresAt).toBe(clock.now + PAIRING_CHALLENGE_TTL_MS)

    const foreign = new MobilePairingController({
      installation: accountActions('mobile', 'account-two'),
      transport,
      handshake: new KeylessMobileHandshakeFixture(),
      scanner: { scan: async () => foreignChallenge.oneTimeLink },
      device: { name: 'Other phone', platform: 'android' },
      now: () => clock.now,
      pollIntervalMs: 20,
    })
    await expect(foreign.completeLink(foreignChallenge.oneTimeLink)).rejects.toMatchObject({
      code: 'PAIRING_ACCOUNT_MISMATCH',
    } satisfies Partial<RemoteAccessError>)
    expect((await transport.listPersonalPairings(authentication('desktop')))).toEqual([])

    await desktop.createChallenge()
    const challenge = desktop.getSnapshot().challenge
    if (challenge === undefined) throw new Error('same-account challenge was not created')
    await mobile.completeLink(challenge.oneTimeLink)
    await waitFor(() => desktop.getSnapshot().pending !== undefined)
    const desktopPending = desktop.getSnapshot().pending
    const mobilePending = mobile.getSnapshot()
    if (desktopPending === undefined || mobilePending.status !== 'pending') {
      throw new Error('assembled pairing did not reach matching authentication words')
    }
    expect(mobilePending.authenticationWords).toEqual(desktopPending.authenticationWords)
    expect(desktop.getSnapshot().pairings).toEqual([])

    await desktop.confirm(desktopPending.id)
    await waitFor(() => mobile.getSnapshot().status === 'paired')
    const paired = desktop.getSnapshot().pairings[0]
    if (paired === undefined) throw new Error('Desktop confirmation did not activate a Personal Pairing')
    expect(paired.platform).toBe('ios')
    const invitation = parsePairingInvitationLink(challenge.oneTimeLink)
    const expectedKey = await deriveKeylessPairingKey(invitation.invitationSecret)
    invitation.invitationSecret.fill(0)
    expect(desktopKeys.pairingKeyMaterial(paired.id)).toEqual(expectedKey)
    expect(mobileKeys.pairingKeyMaterial(paired.id)).toEqual(expectedKey)
    expect((await transport.listPersonalPairings(authentication('desktop'))).map(record =>
      record.devicePrincipal.authority)).toEqual(['companion-surface'])

    await desktop.createChallenge()
    const reused = desktop.getSnapshot().challenge
    if (reused === undefined) throw new Error('single-use challenge was not created')
    const firstMobile = new KeylessMobileHandshakeFixture()
    const firstAttempt = await firstMobile.begin(reused.oneTimeLink)
    const firstCompletion = await transport.completeChallenge({
      authentication: authentication('mobile'),
      completionId: firstAttempt.completionId,
      oneTimeLink: reused.oneTimeLink,
      device: { name: 'Alice phone', platform: 'ios' },
      mobileHandshake: firstAttempt.mobileHandshake,
    })
    await expect(transport.completeChallenge({
      authentication: authentication('mobile'),
      completionId: firstAttempt.completionId,
      oneTimeLink: reused.oneTimeLink,
      device: { name: 'Alice phone', platform: 'ios' },
      mobileHandshake: firstAttempt.mobileHandshake,
    })).resolves.toMatchObject({ pendingPairingId: firstCompletion.pendingPairingId })
    const secondAttempt = await new KeylessMobileHandshakeFixture().begin(reused.oneTimeLink)
    await expect(transport.completeChallenge({
      authentication: authentication('mobile'),
      completionId: secondAttempt.completionId,
      oneTimeLink: reused.oneTimeLink,
      device: { name: 'Alice phone', platform: 'ios' },
      mobileHandshake: secondAttempt.mobileHandshake,
    })).rejects.toMatchObject({ code: 'PAIRING_CHALLENGE_INVALID' } satisfies Partial<RemoteAccessError>)

    await desktop.createChallenge()
    const expiring = desktop.getSnapshot().challenge
    if (expiring === undefined) throw new Error('expiry challenge was not created')
    clock.now = expiring.expiresAt - 1
    const liveMobile = new MobilePairingController({
      installation: accountActions('mobile'),
      transport,
      handshake: new KeylessMobileHandshakeFixture(),
      scanner: { scan: async () => expiring.oneTimeLink },
      device: { name: 'Bound phone', platform: 'ios' },
      now: () => clock.now,
      pollIntervalMs: 20,
    })
    await liveMobile.completeLink(expiring.oneTimeLink)
    expect(liveMobile.getSnapshot().status).toBe('pending')

    await desktop.createChallenge()
    const expired = desktop.getSnapshot().challenge
    if (expired === undefined) throw new Error('deadline challenge was not created')
    clock.now = expired.expiresAt
    const expiredInvitation = parsePairingInvitationLink(expired.oneTimeLink)
    const expiredHandshake = await deriveKeylessMobileHandshake(expiredInvitation.invitationSecret)
    expiredInvitation.invitationSecret.fill(0)
    await expect(transport.completeChallenge({
      authentication: authentication('mobile'),
      completionId: parsePairingCompletionId('completion-expired'),
      oneTimeLink: expired.oneTimeLink,
      device: { name: 'Late phone', platform: 'android' },
      mobileHandshake: expiredHandshake,
    })).rejects.toMatchObject({ code: 'PAIRING_CHALLENGE_EXPIRED' } satisfies Partial<RemoteAccessError>)
    const expiredMobile = new MobilePairingController({
      installation: accountActions('mobile'),
      transport,
      handshake: new KeylessMobileHandshakeFixture(),
      scanner: { scan: async () => expired.oneTimeLink },
      device: { name: 'Late phone', platform: 'ios' },
      now: () => clock.now,
      pollIntervalMs: 20,
    })
    await expect(expiredMobile.completeLink(expired.oneTimeLink)).rejects.toThrow('expired')

    await desktop.deactivate()
    await mobile.deactivate()
    await liveMobile.deactivate()
    await expiredMobile.deactivate()
    await foreign.deactivate()
  })
})

function accountActions(kind: 'desktop' | 'mobile', accountId = 'account-one') {
  const account = {
    id: parsePlatformAccountId(accountId),
    githubId: 1,
    githubLogin: accountId,
    avatarUrl: `https://avatars.example/${accountId}`,
  }
  return {
    authorizeCurrentInstallation: async () => authentication(kind, accountId),
    getSnapshot: () => ({
      status: 'signed-in' as const,
      privacyAccepted: true,
      account,
    }),
  }
}

function authentication(kind: 'desktop' | 'mobile', accountId = 'account-one'): PairingAccountAuthentication {
  return {
    accessToken: `${accountId}:${kind}:${kind}-installation`,
    proof: {
      jti: parseAccountProofJti(`${kind}-${accountId}-proof`),
      issuedAt: clock.now,
      signature: 'assembled-proof',
    },
  }
}

function rewriteFetch(port: number): typeof fetch {
  return async (input, init = {}) => {
    const source = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    headers.set('origin', ORIGIN)
    return fetch(`http://127.0.0.1:${String(port)}${source.pathname}${source.search}`, { ...init, headers })
  }
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('assembled pairing poll did not settle')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function loadComposition(): Promise<{ port: number }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-personal-pairing-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: 'assembled-personal-pairing-provider'",
    "- name: '@deepseek-ai/dsh-remote-access-http'",
    '  config:',
    `    origin: '${ORIGIN}'`,
    '',
  ].join('\n'))
  const context = new Context()
  contexts.push(context)
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  let id = 0
  const provider = {
    name: 'assembled-personal-pairing-provider',
    apply(ctx: Context) {
      new PersonalPairingProvider(ctx, {
        account: {
          async currentInstallation({ accessToken }) {
            const [accountId, kind, installationId] = accessToken.split(':')
            if ((kind !== 'desktop' && kind !== 'mobile') || accountId === undefined || installationId === undefined) {
              throw new TypeError('assembled Account token is invalid')
            }
            return {
              account: {
                id: parsePlatformAccountId(accountId),
                githubId: 1,
                githubLogin: accountId,
                avatarUrl: `https://avatars.example/${accountId}`,
              },
              installation: { id: parseInstallationId(`${kind}-installation`), kind },
            }
          },
        },
        handshake: new DevelopmentKeylessPairingHandshakeProvider(),
        clock: { now: () => clock.now },
        randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index + 1),
        randomId: kind => `${kind}-${String(++id)}`,
        pairingLinkOrigin: `${ORIGIN}/pair`,
      })
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['assembled-personal-pairing-provider', provider],
    ['@deepseek-ai/dsh-remote-access-http', RemoteAccessHttp],
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
  return { port: webServer.port }
}
