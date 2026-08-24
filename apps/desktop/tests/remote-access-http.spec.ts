import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { parseAccountProofJti, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  type PairingAccountAuthentication,
} from '@deepseek-ai/dsh-remote-access'
import { RemoteAccessHttpTransport, type RelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client'
import { DesktopRelayEndpointLifecycle } from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'
import { apply } from '@deepseek-ai/dsh-remote-access-http'
import {
  decodeRelayMessage,
  encodeRelayMessage,
  parseRelayAttachmentId,
  type RelayMessage,
} from '@deepseek-ai/dsh-remote-protocol'
import { DesktopPairingController } from '../src/personal-pairing.ts'

interface RegisteredRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

describe('Desktop Settings Remote Access composition', () => {
  it('drives authenticated HTTP Settings without Platform-issued Desktop authority', async () => {
    const ctx = new Context()
    const revokeRoute = vi.fn()
    const remoteAccess = new PersonalPairingProvider(ctx, {
      account: {
        currentInstallation: vi.fn(async () => ({
          account: {
            id: 'account-one' as never, githubId: 1, githubLogin: 'account-one',
            avatarUrl: 'https://avatars.example/account',
          },
          installation: { id: parseInstallationId('desktop-one'), kind: 'desktop' as const },
        })),
      },
      handshake: handshakeFixture(),
      relay: {
        revokeRoute,
        registerPairingCredentialDigests: vi.fn(async () => 1),
        revokeCredentialDigest: vi.fn(async () => {}),
      },
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomBytes: size => new Uint8Array(size),
      randomId: kind => `${kind}-settings-route`,
      pairingLinkOrigin: 'https://platform.example/pair',
    })
    const server = await startServer(remoteAccess)
    try {
      const transport = new RemoteAccessHttpTransport({
        environment: { environment: 'development', origin: server.origin } as never,
      })
      const relay = { configure: vi.fn(), start: vi.fn(), stop: vi.fn(), getState: () => ({ connected: false }) }
      const controller = new DesktopPairingController({
        account: {
          authorizeCurrentInstallation: vi.fn(async () => authentication('account-one:desktop:desktop-one')),
          getSnapshot: vi.fn(() => ({
            status: 'signed-in' as const,
            privacyAccepted: true,
            account: {
              id: 'account-one' as never, githubId: 1, githubLogin: 'account-one',
              avatarUrl: 'https://avatars.example/account',
            },
          })),
        },
        transport,
        relay,
        pollIntervalMs: 60_000,
      })

      await controller.start()
      await controller.setEnabled(true)
      expect(relay.configure).not.toHaveBeenCalled()
      expect(relay.start).toHaveBeenCalled()
      expect(relay.getState()).toEqual({ connected: false })
      expect(controller.getSnapshot()).toMatchObject({ status: 'ready', enabled: true })
      await controller.setEnabled(false)
      expect(revokeRoute).toHaveBeenCalledOnce()
      expect(relay.stop).toHaveBeenCalledWith('mobile-access-disabled')
      expect(controller.getSnapshot()).toEqual({ status: 'ready', enabled: false, pairings: [] })
      await controller.dispose()
    } finally {
      await settleCleanup([server.close(), remoteAccess.dispose()])
    }
  })

  it('keeps a real Desktop endpoint offline until Settings installs route authority', async () => {
    const lifecycle = new DesktopRelayEndpointLifecycle({
      attachmentId: () => parseRelayAttachmentId(`desktop-${randomUUID()}`),
      connect: async () => new SettingsRelaySocket(),
      attachTimeoutMs: 1_000,
      heartbeatIntervalMs: 60_000,
      reconnectDelayMs: 60_000,
      resynchronize: async () => {},
    })
    const starting = lifecycle.start()
    await Promise.resolve()
    const stopping = lifecycle.stop()
    await expect(starting).resolves.toBeUndefined()
    await stopping
  })
})

function authentication(accessToken: string): PairingAccountAuthentication {
  return {
    accessToken,
    proof: { jti: parseAccountProofJti(crypto.randomUUID()), issuedAt: 1, signature: 'signature' },
  }
}

function handshakeFixture() {
  return {
    createChallenge: vi.fn(async () => ({ desktopFingerprint: 'desktop-fingerprint', state: Uint8Array.of(1) })),
    completeChallenge: vi.fn(async () => ({
      handshakeHash: new Uint8Array(32),
      desktopHandshake: Uint8Array.of(2),
      pendingPairingKey: Uint8Array.of(3),
    })),
    activatePairing: vi.fn(async () => ({ keyReference: 'key-one' as never, activePairingKey: Uint8Array.of(6) })),
    destroyChallenge: vi.fn(),
    destroyPendingPairing: vi.fn(),
    destroyPairing: vi.fn(),
  }
}

class SettingsRelaySocket implements RelayEndpointSocket {
  readonly sent: RelayMessage[] = []
  closed = false
  private readonly received: Uint8Array[] = []
  private waiting: ((value: IteratorResult<Uint8Array>) => void) | undefined

  async send(value: Uint8Array): Promise<void> {
    const message = decodeRelayMessage(value)
    this.sent.push(message)
    if (message.type === 'attach') {
      this.push(encodeRelayMessage({
        type: 'ready', transportVersion: 1, attachmentId: message.attachmentId,
      }))
    }
  }

  messages(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const value = this.received.shift()
          if (value !== undefined) return { done: false as const, value }
          if (this.closed) return { done: true as const, value: undefined }
          return await new Promise<IteratorResult<Uint8Array>>((resolve) => { this.waiting = resolve })
        },
      }),
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.waiting?.({ done: true, value: undefined })
    this.waiting = undefined
  }

  private push(value: Uint8Array): void {
    const waiting = this.waiting
    if (waiting === undefined) this.received.push(value)
    else {
      this.waiting = undefined
      waiting({ done: false, value })
    }
  }
}

async function startServer(remoteAccess: PersonalPairingProvider): Promise<{
  origin: string
  close(): Promise<void>
}> {
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
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await Promise.allSettled([new Promise<void>((resolve) => {
      http.close(() => { resolve() })
    })])
    throw error
  }
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Remote Access test server did not bind')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => { await new Promise<void>((resolve, reject) => {
      http.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }) },
  }
}

async function settleCleanup(cleanups: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(cleanups)
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Desktop Settings fixture cleanup failed')
}
