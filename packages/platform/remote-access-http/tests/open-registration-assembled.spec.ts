/** REAL HTTP composition for open-registration pairing and blob quotas. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAccountProofJti, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  MemoryPersonalPairingAuthorityStore,
  MemoryPlatformCapacityGate,
  OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  OPEN_REGISTRATION_QUOTAS,
  PAIRING_CHALLENGE_QUOTA_WINDOW_MS,
  PAIRING_REPLAY_RETENTION_MS,
  PersonalPairingProvider,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  type PairingAccountAuthentication,
  type PairingHandshakeProvider,
} from '@deepseek-ai/dsh-remote-access'
import { apply } from '../src/index.ts'

interface RegisteredRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const NOW = Date.parse('2026-08-19T10:00:00.000Z')
const closeServers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closeServers.splice(0).map(close => close())) })

describe('assembled open-registration Remote Access quotas', () => {
  it('enforces hourly account and IP Pairing Challenge ceilings over HTTP', {
    timeout: 60_000,
  }, async () => {
    const now = { value: NOW }
    const server = await start(uniqueProvider(now))
    for (const account of ['account-a', 'account-b', 'account-c']) {
      const desktop = authentication(account, `desktop-${account}`)
      await request(server.origin, desktop, { operation: 'set-mobile-access', enabled: true })
      for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour; index += 1) {
        const created = await request(server.origin, desktop, {
          operation: 'create-challenge',
          rendezvousId: `${account}-${String(index)}`,
        })
        expect(created.status).toBe(200)
        const body = await created.json() as { challengeId: string }
        await request(server.origin, desktop, { operation: 'cancel-challenge', challengeId: body.challengeId })
      }
    }
    const extra = authentication('account-d', 'desktop-account-d')
    await request(server.origin, extra, { operation: 'set-mobile-access', enabled: true })
    // HTTP pairing uses the TCP peer; a spoofed forwarding header must not open a second IP bucket.
    const over = await request(server.origin, extra, {
      operation: 'create-challenge',
      rendezvousId: 'ip-over',
    }, { 'x-forwarded-for': '203.0.113.10' })
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toEqual(expect.any(String))
    await expect(over.json()).resolves.toMatchObject({ error: { code: 'QUOTA' } })
  })

  it('accepts fifty Personal Pairings and rejects the fifty-first over HTTP', {
    timeout: 60_000,
  }, async () => {
    const now = { value: NOW }
    const server = await start(uniqueProvider(now))
    const desktop = authentication('account-one', 'desktop-installation')
    await request(server.origin, desktop, { operation: 'set-mobile-access', enabled: true })
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.personalPairings; index += 1) {
      if (index > 0 && index % 4 === 0) now.value += PAIRING_REPLAY_RETENTION_MS + 1
      if (index > 0 && index % OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour === 0) {
        now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS + 1
      }
      await confirmPairing(server.origin, desktop, `pair-${String(index)}`)
    }
    now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS + 1
    const extra = await createAndComplete(server.origin, desktop, 'pair-over')
    const rejected = await request(server.origin, desktop, {
      operation: 'confirm-pairing',
      pendingPairingId: extra.pendingPairingId,
    })
    expect(rejected.status).toBe(429)
    expect(rejected.headers.get('retry-after')).toBe(String(OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS))
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'QUOTA', retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS },
    })
  })

  it('enforces blob ceilings and sheds new pairing at capacity over HTTP', {
    timeout: 60_000,
  }, async () => {
    const now = { value: NOW }
    const gate = new MemoryPlatformCapacityGate(1, 4_500)
    const provider = uniqueProvider(now, gate)
    const server = await start(provider)
    const desktop = authentication('account-one', 'desktop-installation')
    await request(server.origin, desktop, { operation: 'set-mobile-access', enabled: true })
    const pairing = await confirmPairing(server.origin, desktop, 'keep-capacity')

    const held: string[] = []
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.concurrentBlobs; index += 1) {
      const admitted = await request(server.origin, desktop, { operation: 'admit-blob', bytes: 1 })
      expect(admitted.status).toBe(200)
      held.push((await admitted.json() as { reservationId: string }).reservationId)
    }
    const concurrentOver = await request(server.origin, desktop, { operation: 'admit-blob', bytes: 1 })
    expect(concurrentOver.status).toBe(429)
    await request(server.origin, desktop, { operation: 'release-blob', reservationId: held[0] })
    expect((await request(server.origin, desktop, {
      operation: 'admit-blob',
      bytes: OPEN_REGISTRATION_QUOTAS.blobBytes,
    })).status).toBe(200)
    const oversize = await request(server.origin, desktop, {
      operation: 'admit-blob',
      bytes: OPEN_REGISTRATION_QUOTAS.blobBytes + 1,
    })
    expect(oversize.status).toBe(429)

    expect(gate.tryAcquire()).toBe(true)
    const shed = await request(server.origin, desktop, {
      operation: 'create-challenge',
      rendezvousId: 'shed',
    })
    expect(shed.status).toBe(429)
    expect(shed.headers.get('retry-after')).toBe('5')
    await expect(shed.json()).resolves.toMatchObject({ error: { code: 'PLATFORM_CAPACITY', retryAfter: 5 } })
    expect((await request(server.origin, desktop, { operation: 'admit-blob', bytes: 1 })).status).toBe(429)
    const listed = await request(server.origin, desktop, { operation: 'list-pairings' })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject([{ id: pairing.id }])
  })
})

function uniqueProvider(now: { value: number }, capacity?: MemoryPlatformCapacityGate) {
  let id = 0
  return new PersonalPairingProvider(new Context(), {
    account: {
      currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => {
        const [accountId, kind, installationId] = accessToken.split(':') as [string, 'desktop' | 'mobile', string]
        return {
          account: {
            id: accountId as never,
            githubId: 1,
            githubLogin: accountId,
            avatarUrl: 'https://avatars.example/account',
          },
          installation: kind === 'mobile'
            ? {
              id: parseInstallationId(installationId),
              kind,
              presentation: { name: `${installationId} installation`, platform: 'ios' as const },
            }
            : { id: parseInstallationId(installationId), kind: 'desktop' as const, presentation: { name: 'Test Desktop', platform: 'linux' as const } },
        }
      }),
    },
    handshake: handshakeProvider(),
    authority: new MemoryPersonalPairingAuthorityStore(),
    clock: { now: () => now.value },
    randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index + 1),
    randomId: kind => `${kind}-${String(++id)}`,
    pairingLinkOrigin: 'https://platform.example.com/pair',
    ...(capacity === undefined ? {} : { capacity }),
  })
}

function handshakeProvider(): PairingHandshakeProvider {
  return {
    createChallenge: vi.fn(async () => ({ desktopFingerprint: 'desktop-fingerprint', state: Uint8Array.of(1) })),
    completeChallenge: vi.fn(async () => ({
      handshakeHash: new Uint8Array(32),
      desktopHandshake: Uint8Array.of(2),
      pendingPairingKey: Uint8Array.of(3),
    })),
    activatePairing: vi.fn(async () => ({
      keyReference: `key-${crypto.randomUUID()}` as never,
      activePairingKey: Uint8Array.of(6),
    })),
    destroyChallenge: vi.fn(),
    destroyPendingPairing: vi.fn(),
    destroyPairing: vi.fn(),
  }
}

function authentication(accountId: string, installationId: string): PairingAccountAuthentication {
  const kind = installationId.includes('mobile') ? 'mobile' : 'desktop'
  return {
    accessToken: `${accountId}:${kind}:${installationId}`,
    proof: { jti: parseAccountProofJti(crypto.randomUUID()), issuedAt: 1, signature: 'signature' },
  }
}

function proofHeaders(owner: PairingAccountAuthentication, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${owner.accessToken}`,
    'x-gestalt-proof-jti': owner.proof.jti,
    'x-gestalt-proof-issued-at': String(owner.proof.issuedAt),
    'x-gestalt-proof-signature': owner.proof.signature,
    ...extra,
  }
}

function request(
  origin: string,
  owner: PairingAccountAuthentication,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(`${origin}/v1/remote-access/personal-pairing`, {
    method: 'POST',
    headers: proofHeaders(owner, extraHeaders),
    body: JSON.stringify(body),
  })
}

async function createAndComplete(
  origin: string,
  desktop: PairingAccountAuthentication,
  id: string,
) {
  const created = await request(origin, desktop, {
    operation: 'create-challenge',
    rendezvousId: parsePairingRendezvousId(id),
  })
  expect(created.status).toBe(200)
  const challenge = await created.json() as { oneTimeLink: string }
  const mobile = authentication('account-one', `mobile-${id}`)
  const completed = await request(origin, mobile, {
    operation: 'complete-challenge',
    completionId: parsePairingCompletionId(id),
    oneTimeLink: challenge.oneTimeLink,
    device: { name: `Phone ${id}`, platform: 'ios' },
    mobileHandshake: Buffer.from([9]).toString('base64url'),
  })
  expect(completed.status).toBe(200)
  return await completed.json() as { pendingPairingId: string }
}

async function confirmPairing(
  origin: string,
  desktop: PairingAccountAuthentication,
  id: string,
) {
  const pending = await createAndComplete(origin, desktop, id)
  const confirmed = await request(origin, desktop, {
    operation: 'confirm-pairing',
    pendingPairingId: pending.pendingPairingId,
  })
  expect(confirmed.status).toBe(200)
  return await confirmed.json() as { id: string }
}

async function start(remoteAccess: PersonalPairingProvider): Promise<{ origin: string }> {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = {
    remoteAccess,
    webServer: {
      register(route: RegisteredRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(register: () => () => void) { register() },
  } as unknown as Context
  apply(ctx, { origins: ['https://mobile.example'] })
  const http = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (route === undefined) { res.writeHead(404).end(); return }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Remote Access test server did not bind')
  closeServers.push(async () => { await new Promise<void>((resolve, reject) => {
    http.close((error) => { if (error === undefined) resolve(); else reject(error) })
  }) })
  return { origin: `http://127.0.0.1:${String(address.port)}` }
}
