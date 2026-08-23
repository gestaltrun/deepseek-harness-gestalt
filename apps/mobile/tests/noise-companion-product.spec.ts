// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime } from '../src/companion-lifecycle.ts'
import {
  MobileSnowCompanionConnection,
  MobileSnowCompanionProductChannel,
} from '../src/noise-companion-product.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('Mobile Snow Companion product channel', () => {
  it('seals search and encrypted attachment operations on the current generation with Installation proof', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(7, 8))
    const channel = { seal } as never
    connection.connect({
      channel,
      targetAttachmentId: parseRelayAttachmentId('desktop-current'),
      pairingSelector: parseRelayPairingSelector('pairing-current'),
      generation: 1,
    })
    const sendCiphertext = vi.fn(async () => {})
    const authorizeCurrentInstallation = vi.fn(async () => ({
      accessToken: 'current-access',
      proof: { jti: 'proof-current' as never, issuedAt: 1234, signature: 'signature-current' },
    }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer current-access')
      expect(headers.get('x-gestalt-pairing-selector')).toBe('pairing-current')
      expect(headers.get('x-gestalt-proof-jti')).toBe('proof-current')
      return new Response(JSON.stringify({
        capability: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        byteLength: 31,
        expiresAt: Date.now() + 60_000,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const product = new MobileSnowCompanionProductChannel({
      runtime,
      connection,
      installation: { authorizeCurrentInstallation },
      attachmentKeys: { attachmentKeyMaterial: () => new Uint8Array(32).fill(3) },
      platformOrigin: 'https://platform.example',
      sendCiphertext,
    })

    const searchId = product.search('indexed needle')
    await vi.waitFor(() => { expect(sendCiphertext).toHaveBeenCalledOnce() })
    expect(seal).toHaveBeenCalledWith({
      type: 'operation',
      operation: { type: 'search-sessions', operationId: searchId, query: 'indexed needle' },
    })
    const attachment = product.attach('session-current', new File([Uint8Array.of(1, 2, 3)], 'real.bin'))
    await attachment.completion
    expect(authorizeCurrentInstallation).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(seal.mock.lastCall?.[0]).toMatchObject({
      type: 'operation',
      operation: {
        type: 'offer-attachment',
        operationId: attachment.operationId,
        sessionId: 'session-current',
        fileName: 'real.bin',
        mediaType: 'application/octet-stream',
      },
    })
    expect(sendCiphertext).toHaveBeenCalledTimes(2)
  })

  it('rejects a send that completes after channel replacement', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const active = {
      channel: { seal: () => Uint8Array.of(1) } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-old'),
      pairingSelector: parseRelayPairingSelector('pairing-old'),
      generation: 1,
    }
    connection.connect(active)
    const failure = vi.fn()
    const product = new MobileSnowCompanionProductChannel({
      runtime,
      connection,
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example',
      sendCiphertext: async () => { connection.disconnect() },
      reportFailure: failure,
    })
    product.search('replacement race')
    await vi.waitFor(() => { expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Companion Snow channel was replaced',
    })) })
  })
})

function synchronizedRuntime(): CompanionForegroundRuntime {
  const runtime = new CompanionForegroundRuntime()
  runtime.configure({
    endpoint: 'mobile',
    routeId: parseRelayRouteId('route-current'),
    credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    revision: 1,
  })
  runtime.markConnectionOpen()
  const resync = runtime.bindValidatedDesktopResync()
  if (resync === undefined || !resync.acceptValidatedDesktopResync({
    type: 'desktop-resync', version: 1, authenticated: true,
  })) throw new Error('test runtime did not synchronize')
  return runtime
}
