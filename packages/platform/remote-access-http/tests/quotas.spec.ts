/** Real HTTP Personal Pairing quota and capacity envelopes. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAccountProofJti, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  MemoryPersonalPairingAuthorityStore,
  OPEN_REGISTRATION_QUOTAS,
  PersonalPairingProvider,
  parsePairingRendezvousId,
  type PairingAccountAuthentication,
} from '@deepseek-ai/dsh-remote-access'
import { apply } from '../src/index.ts'

interface RegisteredRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const closeServers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closeServers.splice(0).map(close => close())) })

describe('Remote Access HTTP open-registration quotas', () => {
  it('rejects the eleventh hourly challenge with a stable 429 envelope', async () => {
    const provider = pairingProvider()
    const server = await start(provider)
    const desktop = authentication('account-one:desktop:desktop-one')
    await post(server.origin, desktop, { operation: 'set-mobile-access', enabled: true })
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour; index += 1) {
      const created = await post(server.origin, desktop, {
        operation: 'create-challenge',
        rendezvousId: parsePairingRendezvousId(`hourly-${String(index)}`),
      })
      expect(created.status).toBe(200)
      const body = await created.json() as { challengeId: string }
      expect((await post(server.origin, desktop, {
        operation: 'cancel-challenge', challengeId: body.challengeId,
      })).status).toBe(200)
    }
    const over = await post(server.origin, desktop, {
      operation: 'create-challenge',
      rendezvousId: parsePairingRendezvousId('hourly-over'),
    })
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toEqual(expect.any(String))
    await expect(over.json()).resolves.toMatchObject({ error: { code: 'QUOTA' } })
  })

  it('admits five concurrent blobs and rejects the sixth over HTTP', async () => {
    const provider = pairingProvider()
    const server = await start(provider)
    const owner = authentication('account-one:desktop:desktop-one')
    await post(server.origin, owner, { operation: 'set-mobile-access', enabled: true })
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.concurrentBlobs; index += 1) {
      const admitted = await post(server.origin, owner, { operation: 'admit-blob', bytes: 1 })
      expect(admitted.status).toBe(200)
    }
    const over = await post(server.origin, owner, { operation: 'admit-blob', bytes: 1 })
    expect(over.status).toBe(429)
    await expect(over.json()).resolves.toMatchObject({ error: { code: 'QUOTA' } })
  })
})

function pairingProvider(): PersonalPairingProvider {
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
          installation: { id: parseInstallationId(installationId), kind },
        }
      }),
    },
    handshake: {
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
    },
    authority: new MemoryPersonalPairingAuthorityStore(),
    randomBytes: size => new Uint8Array(size).fill(1),
    randomId: kind => `${kind}-${String(++id)}`,
    pairingLinkOrigin: 'https://platform.example/pair',
  })
}

function authentication(accessToken: string): PairingAccountAuthentication {
  return {
    accessToken,
    proof: { jti: parseAccountProofJti(crypto.randomUUID()), issuedAt: 1, signature: 'signature' },
  }
}

function proofHeaders(authentication: PairingAccountAuthentication): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${authentication.accessToken}`,
    'x-gestalt-proof-jti': authentication.proof.jti,
    'x-gestalt-proof-issued-at': String(authentication.proof.issuedAt),
    'x-gestalt-proof-signature': authentication.proof.signature,
  }
}

async function post(
  origin: string,
  authentication: PairingAccountAuthentication,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}/v1/remote-access/personal-pairing`, {
    method: 'POST',
    headers: proofHeaders(authentication),
    body: JSON.stringify(body),
  })
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
  apply(ctx, { origin: 'https://mobile.example' })
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
