// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseCompanionInteractionId,
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
  it('sends refresh, history, cancel, and settles an Approval with a correlated receipt', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-v3'),
      pairingSelector: parseRelayPairingSelector('pairing-v3'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example',
      sendCiphertext: async () => {},
    })
    product.refreshSurface()
    product.loadOlder('session-v3')
    product.cancel('session-v3')
    const receipt = product.settle({
      kind: 'approval', sessionId: 'session-v3', interactionId: parseCompanionInteractionId('interaction-v3'),
      result: { ok: true, value: { sessionId: 'session-v3', approvalId: 'approval-v3', outcome: 'allowed-once' } },
    })
    const settleMessage = seal.mock.calls.at(-1)?.[0] as { operation: { operationId: string } }
    product.acceptResult({
      type: 'interaction-receipt', operationId: settleMessage.operation.operationId as never, accepted: true,
    })
    await expect(receipt).resolves.toEqual({ accepted: true })
    expect(seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type)).toEqual([
      'refresh-surface', 'load-history', 'cancel-session', 'settle-interaction', 'load-history', 'refresh-surface',
    ])
  })

  it('refreshes the authoritative history and surface after a confirmed prompt or cancel', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-refresh'),
      pairingSelector: parseRelayPairingSelector('pairing-refresh'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
    })
    product.submit('session-refresh', 'next prompt')
    const submit = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation
    product.acceptResult({
      type: 'confirmed', operationId: submit.operationId as never, committedAt: 1, outcome: 'accepted',
    })
    await vi.waitFor(() => {
      expect(seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type))
        .toEqual(['submit-prompt', 'load-history', 'refresh-surface'])
    })

    product.cancel('session-refresh')
    const cancel = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation
    product.acceptResult({
      type: 'confirmed', operationId: cancel.operationId as never, committedAt: 2, outcome: 'accepted',
    })
    await vi.waitFor(() => {
      expect(seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type).slice(-3))
        .toEqual(['cancel-session', 'load-history', 'refresh-surface'])
    })
  })

  it('assembles and verifies exact historical image bytes', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-image'),
      pairingSelector: parseRelayPairingSelector('pairing-image'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
    })
    const loaded = product.loadImage('session-image', {
      attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    })
    const operationId = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation.operationId
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.of(0, 1, 2))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('')
    product.acceptResult({
      type: 'image-chunk', operationId: operationId as never, sessionId: 'session-image' as never,
      attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', index: 0, count: 1, sha256, data: 'AAEC',
    })
    await expect(loaded).resolves.toBe('data:image/png;base64,AAEC')
  })

  it('rejects a correlated image request when Desktop returns an operation failure', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-image-failure'),
      pairingSelector: parseRelayPairingSelector('pairing-image-failure'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
    })
    const loaded = product.loadImage('session-image', {
      attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    })
    const operationId = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation.operationId
    product.acceptResult({
      type: 'operation-failed', operationId: operationId as never,
      failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response exceeded its byte limit' },
    })
    await expect(loaded).rejects.toThrow('Desktop Host response exceeded its byte limit')
  })

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
