import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createCompanionNegotiationChannel, createCompanionVersionOffer, encodeCompanionMessage,
  decodeRelayMessage, encodeRelayMessage, parseRelayAttachmentId, parseRelayPairingSelector,
  negotiateCompanionProtocol, parseRelayAttachChallengeId,
  generateRelayCredential,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  createDesktopRemoteRelay,
  DesktopSnowRelayChannelOwner,
  loadDesktopRemoteRelayConfig,
} from '../src/remote-relay.ts'
import { DesktopSnowPairingVault } from '../src/snow-pairing-vault.ts'
import { parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import {
  initializeSnowChannel, SnowCompanionProtocolChannel, SnowMobileAttachmentOwner, SnowMobileHandshakeClient,
} from '@deepseek-ai/dsh-noise-channel'
import { parsePairingChallengeId, parsePendingPairingId, parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { NodeRelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client/node-relay-socket'
import type { RelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client'
import type { DesktopCompanionLiveProjectionChange } from '../src/companion-live-projection.ts'
import { DesktopCompanionLiveProjectionSource } from '../src/companion-live-projection.ts'

const DEVELOPMENT = {
  environment: 'development',
  origin: 'https://platform.example',
  callbackUrl: 'http://127.0.0.1:9327/callback',
  githubClientId: 'client',
  credentialReference: 'credential',
  databaseIdentity: 'development',
  identityNamespace: 'development',
} as const

const SOURCE = {
  DSH_REMOTE_RELAY_WSS_URL: 'wss://platform.example/v1/remote-access/relay',
  DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS: '1000',
  DSH_REMOTE_RELAY_NEGOTIATION_TIMEOUT_MS: '5000',
  DSH_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS: '30000',
  DSH_REMOTE_RELAY_RECONNECT_DELAY_MS: '1000',
  DSH_REMOTE_RELAY_INBOUND_MAX_BYTES: String(REMOTE_PROTOCOL_LIMITS.relayMessageBytes),
  DSH_REMOTE_RELAY_INBOUND_MAX_MESSAGES: '16',
}

const AUTHENTICATED_DESKTOP_NAME = (): string => 'Authenticated Desktop'
const NEGOTIATION_TIMEOUT_MS = 1_000
const UNUSED_OPERATION_HANDLER = async (operation: { operationId: string }) => ({
  type: 'operation-failed' as const,
  operationId: operation.operationId,
  failure: { kind: 'business' as const, code: 'test-unused', message: 'unused' },
})

describe('Desktop Remote Relay composition', () => {
  it('expires a half-open Companion negotiation without publishing application authority', async () => {
    vi.useFakeTimers()
    try {
      const selector = parseRelayPairingSelector('pairing-negotiation-timeout')
      const desktopAttachmentId = parseRelayAttachmentId('desktop-negotiation-timeout')
      const mobileAttachmentId = parseRelayAttachmentId('mobile-negotiation-timeout')
      const channel = fakeSnowChannel()
      const negotiation = fakeNegotiation(channel.channel)
      const send = vi.fn(async () => {})
      const reconnect = vi.fn()
      expect(() => new DesktopSnowRelayChannelOwner(
        { accept: async () => await new Promise<never>(() => {}) },
        send, undefined, AUTHENTICATED_DESKTOP_NAME, 0,
      )).toThrow('positive safe integer')
      const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation,
        pairingSelector: selector, generation: 1,
      }) }, send, undefined, AUTHENTICATED_DESKTOP_NAME, 10, {
        connect: vi.fn(() => () => {}),
        project: vi.fn(),
        retainsConversation: () => false,
        reconnect,
      })
      owner.updatePeers({
        type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-negotiation-timeout'),
        attachmentId: desktopAttachmentId,
        peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
      }, selector)

      await owner.receive(
        Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector,
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(10)

      expect(send).toHaveBeenCalledOnce()
      expect(channel.seal).not.toHaveBeenCalled()
      expect(negotiation.cancel).toHaveBeenCalledOnce()
      expect(channel.dispose).toHaveBeenCalledOnce()
      expect(reconnect).toHaveBeenCalledWith(
        selector, expect.objectContaining({ message: 'Desktop Companion negotiation timed out' }),
      )
      await expect(owner.receive(
        Uint8Array.of(3), mobileAttachmentId, desktopAttachmentId, selector,
        new AbortController().signal,
      )).rejects.toThrow('no peer projection')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the negotiation deadline after the Mobile offer publishes the channel', async () => {
    vi.useFakeTimers()
    try {
      const selector = parseRelayPairingSelector('pairing-negotiation-complete')
      const desktopAttachmentId = parseRelayAttachmentId('desktop-negotiation-complete')
      const mobileAttachmentId = parseRelayAttachmentId('mobile-negotiation-complete')
      const channel = fakeSnowChannel()
      const negotiation = fakeNegotiation(channel.channel)
      const send = vi.fn(async () => {})
      const reconnect = vi.fn()
      const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation,
        pairingSelector: selector, generation: 1,
      }) }, send, undefined, AUTHENTICATED_DESKTOP_NAME, 10, {
        connect: vi.fn(() => () => {}),
        project: vi.fn(),
        retainsConversation: () => false,
        reconnect,
      })
      owner.updatePeers({
        type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-negotiation-complete'),
        attachmentId: desktopAttachmentId,
        peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
      }, selector)

      await owner.receive(
        Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector,
        new AbortController().signal,
      )
      await owner.receive(
        Uint8Array.of(3), mobileAttachmentId, desktopAttachmentId, selector,
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(10)

      expect(send).toHaveBeenCalledTimes(2)
      expect(channel.seal.mock.calls[0]?.[0]).toMatchObject({
        type: 'projection', projection: { type: 'foreground-sync' },
      })
      expect(negotiation.cancel).not.toHaveBeenCalled()
      expect(reconnect).not.toHaveBeenCalled()
      owner.invalidate(selector)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['replacement', 'revocation', 'connection-lost'] as const)(
    'cancels a pending IK accept before %s can install or send a stale channel',
    async (event) => {
      const accepted = deferred<Awaited<ReturnType<import('@deepseek-ai/dsh-noise-channel').SnowDesktopAttachmentOwner['accept']>>>()
      const channel = Object.create(SnowCompanionProtocolChannel.prototype) as SnowCompanionProtocolChannel
      const dispose = vi.fn()
      Object.defineProperty(channel, 'dispose', { value: dispose })
      const send = vi.fn(async () => {})
      const owner = new DesktopSnowRelayChannelOwner(
        { accept: async () => await accepted.promise }, send, undefined, AUTHENTICATED_DESKTOP_NAME,
        NEGOTIATION_TIMEOUT_MS,
      )
      const selector = parseRelayPairingSelector('pairing-race')
      const desktopAttachmentId = parseRelayAttachmentId('desktop-race')
      const mobileAttachmentId = parseRelayAttachmentId('mobile-race')
      const ready = {
        type: 'ready' as const, transportVersion: 1 as const, routeId: parseRelayRouteId('route-race'),
        attachmentId: desktopAttachmentId,
        peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
      }
      owner.updatePeers(ready, selector)
      const receiving = owner.receive(
        Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      await Promise.resolve()
      if (event === 'replacement') owner.updatePeers({
        ...ready, peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 2 }],
      }, selector)
      else if (event === 'revocation') owner.invalidate(selector)
      else owner.connectionLost(desktopAttachmentId)
      accepted.resolve({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel),
        pairingSelector: selector, generation: 1,
      })

      await expect(receiving).rejects.toThrow('cancelled')
      expect(send).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })
    },
  )

  it('rejects missing, stale, unprojected, and mismatched IK ownership', async () => {
    const selector = parseRelayPairingSelector('pairing-guards')
    const otherSelector = parseRelayPairingSelector('pairing-other')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-guards')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-guards')
    const routeId = parseRelayRouteId('route-guards')
    const signal = new AbortController().signal
    const channel = fakeSnowChannel()
    const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel.channel),
      pairingSelector: otherSelector, generation: 2,
    }) }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS)
    await expect(owner.receive(Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, signal))
      .rejects.toThrow('no peer projection')
    owner.updatePeers({
      type: 'ready', transportVersion: 1, routeId, attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }, selector)
    await expect(owner.receive(
      Uint8Array.of(1), mobileAttachmentId, parseRelayAttachmentId('desktop-stale'), selector, signal,
    )).rejects.toThrow('stale local attachment')
    await expect(owner.receive(
      Uint8Array.of(1), parseRelayAttachmentId('mobile-unprojected'), desktopAttachmentId, selector, signal,
    )).rejects.toThrow('unprojected')
    await expect(owner.receive(Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, signal))
      .rejects.toThrow('stale Snow IK transcript')
    expect(channel.dispose).toHaveBeenCalledOnce()
  })

  it('opens an installed channel and rejects it after a hostile peer projection change', async () => {
    const selector = parseRelayPairingSelector('pairing-installed')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-installed')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-installed')
    const channel = fakeSnowChannel()
    const send = vi.fn(async () => {})
    const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel.channel),
      pairingSelector: selector, generation: 1,
    }) }, send, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS)
    const ready = {
      type: 'ready' as const, transportVersion: 1 as const, routeId: parseRelayRouteId('route-installed'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }
    owner.updatePeers(ready, selector)
    await owner.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await owner.receive(
      Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect(channel.seal).toHaveBeenCalledOnce()
    await owner.receive(
      Uint8Array.of(3), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    expect(channel.open).toHaveBeenCalledWith(Uint8Array.of(3))

    ready.peers.splice(0)
    await expect(owner.receive(
      Uint8Array.of(4), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )).rejects.toThrow('stale Snow channel')
    owner.updatePeers({ ...ready, peers: [] }, parseRelayPairingSelector('pairing-unrelated'))
    owner.connectionLost(parseRelayAttachmentId('desktop-unrelated'))
    owner.invalidate(selector)
    expect(channel.dispose).toHaveBeenCalledOnce()
  })

  it('keeps the safe preceding application major off the major 4 live projection stream', async () => {
    const selector = parseRelayPairingSelector('pairing-preceding-major')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-preceding-major')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-preceding-major')
    const channel = fakeSnowChannel(3)
    const connect = vi.fn(() => () => {})
    const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2),
      negotiation: fakeNegotiation(channel.channel), pairingSelector: selector, generation: 1,
    }) }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS, {
      connect,
      project: async () => ({ sessionId: 'unused' as never, removed: true }),
      retainsConversation: () => false,
      reconnect: vi.fn(),
    })
    owner.updatePeers({
      type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-preceding-major'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }, selector)

    await owner.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await owner.receive(
      Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )

    expect(connect).not.toHaveBeenCalled()
    owner.invalidate(selector)
  })

  it('dispatches a decoded product operation and encrypts its correlated result on the current channel', async () => {
    const selector = parseRelayPairingSelector('pairing-product')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-product')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-product')
    const channel = fakeSnowChannel()
    const operation = {
      type: 'search-sessions' as const,
      operationId: 'search-product' as never,
      query: 'indexed needle',
    }
    channel.open.mockReturnValue({ type: 'operation', operation })
    const result = {
      type: 'session-search' as const,
      operationId: operation.operationId,
      items: [],
      hasMore: false,
    }
    const handleOperation = vi.fn(async () => result)
    const send = vi.fn(async () => {})
    const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel.channel),
      pairingSelector: selector, generation: 1,
    }) }, send, handleOperation, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS)
    owner.updatePeers({
      type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-product'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }, selector)
    await owner.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await owner.receive(
      Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    send.mockClear()
    channel.seal.mockClear()

    await owner.receive(
      Uint8Array.of(3), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )

    expect(handleOperation).toHaveBeenCalledWith(operation, selector, {
      generation: 1, desktopRevision: 1,
    })
    expect(channel.seal).toHaveBeenCalledWith({ type: 'result', result })
    expect(send).toHaveBeenCalledWith(selector, mobileAttachmentId, Uint8Array.of(9))
  })

  it('coalesces active Host changes behind one ordered Snow sender and advances projection revisions', async () => {
    const selector = parseRelayPairingSelector('pairing-live')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-live')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-live')
    const channel = fakeSnowChannel()
    let changed: ((change: DesktopCompanionLiveProjectionChange) => void) | undefined
    const firstProjection = deferred<Record<string, unknown>>()
    const project = vi.fn()
      .mockImplementationOnce(async () => await firstProjection.promise)
      .mockResolvedValue({
        sessionId: 'session-live', position: 0,
        summary: {
          sessionId: 'session-live', displayTitle: 'Live', running: true,
          blank: false, updatedAt: 2,
        },
        workspaces: [],
      })
    const reconnect = vi.fn()
    const disposeLive = vi.fn()
    const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel.channel),
      pairingSelector: selector, generation: 1,
    }) }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS, {
      connect: (_pairingSelector, listener) => { changed = listener; return disposeLive },
      project,
      retainsConversation: () => false,
      reconnect,
    })
    owner.updatePeers({
      type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-live'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }, selector)
    await owner.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await owner.receive(
      Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    channel.seal.mockClear()
    const change = {
      type: 'session', sessionId: 'session-live', includeConversation: false, observationEpoch: 0,
    } as DesktopCompanionLiveProjectionChange
    changed?.(change)
    changed?.(change)
    changed?.(change)
    await vi.waitFor(() => { expect(project).toHaveBeenCalledOnce() })
    firstProjection.resolve({
      sessionId: 'session-live', position: 0,
      summary: {
        sessionId: 'session-live', displayTitle: 'Live', running: true,
        blank: false, updatedAt: 1,
      },
      workspaces: [],
    })

    await vi.waitFor(() => { expect(channel.seal).toHaveBeenCalledTimes(2) })
    const sealed = channel.seal.mock.calls.map(call => call[0])
    expect(sealed[0]).toMatchObject({
      type: 'projection',
      projection: { type: 'session-live', desktopRevision: 2, summary: { updatedAt: 1 } },
    })
    expect(sealed[1]).toMatchObject({
      type: 'projection',
      projection: { type: 'session-live', desktopRevision: 3, summary: { updatedAt: 2 } },
    })
    expect(reconnect).not.toHaveBeenCalled()
    owner.invalidate(selector)
    expect(disposeLive).toHaveBeenCalledOnce()
  })

  it.each(['switch', 'close'] as const)(
    'drops a projected conversation when Mobile performs a deferred observation %s',
    async (event) => {
      const selector = parseRelayPairingSelector(`pairing-observation-${event}`)
      const pairingId = parsePersonalPairingId(selector)
      const desktopAttachmentId = parseRelayAttachmentId(`desktop-observation-${event}`)
      const mobileAttachmentId = parseRelayAttachmentId(`mobile-observation-${event}`)
      const channel = fakeSnowChannel()
      const source = new DesktopCompanionLiveProjectionSource()
      const firstProjection = deferred<Record<string, unknown>>()
      const project = vi.fn()
        .mockImplementationOnce(async () => await firstProjection.promise)
        .mockResolvedValue({
          sessionId: 'session-observed', position: 0,
          summary: liveSummary('session-observed', 2), workspaces: [],
        })
      const reconnect = vi.fn()
      const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel.channel),
        pairingSelector: selector, generation: 1,
      }) }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS, {
        connect: (_selector, listener, disconnect) => source.connect(pairingId, listener, disconnect),
        project,
        retainsConversation: change => source.retainsConversation(pairingId, change),
        reconnect,
      })
      owner.updatePeers({
        type: 'ready', transportVersion: 1, routeId: parseRelayRouteId(`route-observation-${event}`),
        attachmentId: desktopAttachmentId,
        peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
      }, selector)
      await owner.receive(
        Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      await owner.receive(
        Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      channel.seal.mockClear()
      source.observe(pairingId, 'session-observed' as never)
      await vi.waitFor(() => { expect(project).toHaveBeenCalledOnce() })
      source.observe(pairingId, event === 'switch' ? 'session-replacement' as never : undefined)
      firstProjection.resolve({
        sessionId: 'session-observed', position: 0,
        summary: liveSummary('session-observed', 1), workspaces: [],
        conversation: liveConversation('session-observed', [{
          kind: 'assistant', seq: 1, time: 1, blocks: [{ kind: 'text', text: 'must not leak' }],
        }]),
      })

      await vi.waitFor(() => { expect(channel.seal).toHaveBeenCalled() })
      const first = channel.seal.mock.calls[0]?.[0]
      expect(first).toMatchObject({
        type: 'projection',
        projection: { type: 'session-live', sessionId: 'session-observed' },
      })
      expect(first).not.toHaveProperty('projection.conversation')
      expect(reconnect).not.toHaveBeenCalled()
      owner.invalidate(selector)
      await owner.drain()
    },
  )

  it.each([
    ['one oversized latest entry', [
      { kind: 'assistant', seq: 7, time: 7, blocks: [{ kind: 'text', text: 'x'.repeat(55 * 1_024) }] },
    ]],
    ['a cumulative transcript tail', Array.from({ length: 12 }, (_, index) => ({
      kind: 'assistant', seq: index + 1, time: index + 1,
      blocks: [{ kind: 'text', text: `${String(index)}:${'y'.repeat(6 * 1_024)}` }],
    }))],
  ] as const)(
    'bounds %s before Snow sealing without reconnecting',
    async (_scenario, nodes) => {
      const selector = parseRelayPairingSelector('pairing-live-bytes')
      const desktopAttachmentId = parseRelayAttachmentId('desktop-live-bytes')
      const mobileAttachmentId = parseRelayAttachmentId('mobile-live-bytes')
      const channel = fakeSnowChannel()
      const protocol = negotiateCompanionProtocol(
        createCompanionNegotiationChannel(),
        createCompanionVersionOffer('mobile', [4]),
        createCompanionVersionOffer('desktop', [4]),
      )
      channel.seal.mockImplementation((message) => {
        encodeCompanionMessage(protocol, message)
        return Uint8Array.of(9)
      })
      channel.canEncode.mockImplementation((message) => {
        try {
          encodeCompanionMessage(protocol, message)
          return true
        } catch {
          return false
        }
      })
      let changed: ((change: DesktopCompanionLiveProjectionChange) => void) | undefined
      const reconnect = vi.fn()
      const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel.channel),
        pairingSelector: selector, generation: 1,
      }) }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS, {
        connect: (_selector, listener) => { changed = listener; return () => {} },
        project: async () => ({
          sessionId: 'session-live-bytes', position: 0,
          summary: liveSummary('session-live-bytes', 1), workspaces: [],
          conversation: liveConversation('session-live-bytes', nodes),
        }),
        retainsConversation: () => true,
        reconnect,
      })
      owner.updatePeers({
        type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-live-bytes'),
        attachmentId: desktopAttachmentId,
        peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
      }, selector)
      await owner.receive(
        Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      await owner.receive(
        Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      channel.seal.mockClear()
      changed?.({
        type: 'session', sessionId: 'session-live-bytes' as never,
        includeConversation: true, observationEpoch: 1,
      })
      await owner.drain()

      expect(reconnect).not.toHaveBeenCalled()
      expect(channel.dispose).not.toHaveBeenCalled()
      const sealed = channel.seal.mock.calls[0]?.[0]
      if (sealed?.type !== 'projection' || sealed.projection.type !== 'session-live'
        || !('conversation' in sealed.projection) || !isRecord(sealed.projection.conversation)) {
        throw new Error('expected bounded live conversation')
      }
      expect(encodeCompanionMessage(protocol, sealed).byteLength)
        .toBeLessThanOrEqual(REMOTE_PROTOCOL_LIMITS.transcriptPageBytes)
      const projectedNodes = sealed.projection.conversation.nodes
      expect(Array.isArray(projectedNodes)).toBe(true)
      expect(projectedNodes).not.toHaveLength(0)
      expect(sealed.projection.conversation.hasMore).toBe(true)
      expect((projectedNodes as Array<{ seq: number }>).at(-1)?.seq).toBe(nodes.at(-1)?.seq)
      expect(JSON.stringify(projectedNodes)).toContain(nodes.length === 1 ? '…' : '11:')
      owner.invalidate(selector)
    },
  )

  it('retires and reconnects a channel when distinct live Sessions exceed the bounded queue', async () => {
    const selector = parseRelayPairingSelector('pairing-live-overflow')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-live-overflow')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-live-overflow')
    const channel = fakeSnowChannel()
    let changed: ((change: DesktopCompanionLiveProjectionChange) => void) | undefined
    const firstProjection = deferred<Record<string, unknown>>()
    const reconnect = vi.fn()
    const disposeLive = vi.fn()
    const owner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(channel.channel),
      pairingSelector: selector, generation: 1,
    }) }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS, {
      connect: (_pairingSelector, listener) => { changed = listener; return disposeLive },
      project: async () => await firstProjection.promise,
      retainsConversation: () => false,
      reconnect,
    })
    owner.updatePeers({
      type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-live-overflow'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }, selector)
    await owner.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await owner.receive(
      Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )

    changed?.({
      type: 'session', sessionId: 'session-live-active', includeConversation: false, observationEpoch: 0,
    } as DesktopCompanionLiveProjectionChange)
    await Promise.resolve()
    for (let index = 0; index <= REMOTE_PROTOCOL_LIMITS.liveProjectionPendingSessions; index += 1) {
      changed?.({
        type: 'session', sessionId: `session-live-${String(index)}`,
        includeConversation: false, observationEpoch: 0,
      } as DesktopCompanionLiveProjectionChange)
    }

    expect(reconnect).toHaveBeenCalledWith(selector, expect.objectContaining({
      message: 'Companion live projection consumer exceeded its pending Session ceiling',
    }))
    expect(disposeLive).toHaveBeenCalledOnce()
    expect(channel.dispose).toHaveBeenCalledOnce()
    firstProjection.resolve({ sessionId: 'session-live-active', removed: true })
    await owner.drain()
    expect(channel.seal).toHaveBeenCalledTimes(1)
  })

  it('revalidates peer generation after accept and after the IK response send', async () => {
    const selector = parseRelayPairingSelector('pairing-revalidate')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-revalidate')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-revalidate')
    const peers = [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }]
    const ready = {
      type: 'ready' as const, transportVersion: 1 as const, routeId: parseRelayRouteId('route-revalidate'),
      attachmentId: desktopAttachmentId, peers,
    }
    const firstAccept = deferred<Awaited<ReturnType<import('@deepseek-ai/dsh-noise-channel').SnowDesktopAttachmentOwner['accept']>>>()
    const firstChannel = fakeSnowChannel()
    const first = new DesktopSnowRelayChannelOwner(
      { accept: async () => await firstAccept.promise }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME,
      NEGOTIATION_TIMEOUT_MS,
    )
    first.updatePeers(ready, selector)
    const staleAfterAccept = first.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await Promise.resolve()
    peers.splice(0)
    firstAccept.resolve({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(firstChannel.channel),
      pairingSelector: selector, generation: 1,
    })
    await expect(staleAfterAccept).rejects.toThrow('stale Snow IK transcript')
    expect(firstChannel.dispose).toHaveBeenCalledOnce()

    const secondChannel = fakeSnowChannel()
    const secondPeers = [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }]
    const second = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(secondChannel.channel),
      pairingSelector: selector, generation: 1,
    }) }, async () => { secondPeers.splice(0) }, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS)
    second.updatePeers({ ...ready, peers: secondPeers }, selector)
    await expect(second.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )).rejects.toThrow('stale Snow IK transcript')
    expect(secondChannel.dispose).toHaveBeenCalledOnce()

    const thirdChannel = fakeSnowChannel()
    const thirdPeers = [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }]
    let thirdSend = 0
    const third = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(thirdChannel.channel),
      pairingSelector: selector, generation: 1,
    }) }, async () => {
      thirdSend += 1
      if (thirdSend === 2) thirdPeers.splice(0)
    }, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS)
    third.updatePeers({ ...ready, peers: thirdPeers }, selector)
    await third.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await expect(third.receive(
      Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )).rejects.toThrow('stale Companion negotiation')
    expect(thirdChannel.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['IK response', 1],
    ['foreground synchronization', 2],
  ] as const)(
    'disposes an unpublished channel when the %s send fails and keeps revisions monotonic',
    async (_stage, failedSend) => {
      const selector = parseRelayPairingSelector(`pairing-send-${String(failedSend)}`)
      const desktopAttachmentId = parseRelayAttachmentId(`desktop-send-${String(failedSend)}`)
      const mobileAttachmentId = parseRelayAttachmentId(`mobile-send-${String(failedSend)}`)
      const failedChannel = fakeSnowChannel()
      const recoveredChannel = fakeSnowChannel()
      const accept = vi.fn()
        .mockResolvedValueOnce({
          targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(failedChannel.channel),
          pairingSelector: selector, generation: 1,
        })
        .mockResolvedValueOnce({
          targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(3), negotiation: fakeNegotiation(recoveredChannel.channel),
          pairingSelector: selector, generation: 1,
        })
      let sends = 0
      const send = vi.fn(async () => {
        sends += 1
        if (sends === failedSend) throw new Error('Relay send failed')
      })
      const owner = new DesktopSnowRelayChannelOwner(
        { accept }, send, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS,
      )
      owner.updatePeers({
        type: 'ready', transportVersion: 1, routeId: parseRelayRouteId(`route-send-${String(failedSend)}`),
        attachmentId: desktopAttachmentId,
        peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
      }, selector)

      const ik = owner.receive(
        Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      if (failedSend === 1) await expect(ik).rejects.toThrow('Relay send failed')
      else {
        await ik
        await expect(owner.receive(
          Uint8Array.of(2), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
        )).rejects.toThrow('Relay send failed')
      }
      expect(failedChannel.dispose).toHaveBeenCalledOnce()
      expect(failedChannel.open).not.toHaveBeenCalled()
      await owner.receive(
        Uint8Array.of(4), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      await owner.receive(
        Uint8Array.of(5), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      expect(accept).toHaveBeenCalledTimes(2)
      expect(recoveredChannel.seal).toHaveBeenCalledWith({
        type: 'projection', projection: {
          type: 'foreground-sync', desktopName: 'Authenticated Desktop', generation: 1,
          desktopRevision: failedSend === 2 ? 2 : 1,
        },
      })
      owner.invalidate(selector)
      expect(failedChannel.dispose).toHaveBeenCalledOnce()
      expect(recoveredChannel.dispose).toHaveBeenCalledOnce()
    },
  )

  it('contains a generation invalidation racing a failed IK response send', async () => {
    const selector = parseRelayPairingSelector('pairing-race-send')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-race-send')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-race-send')
    const failedChannel = fakeSnowChannel()
    const recoveredChannel = fakeSnowChannel()
    const accept = vi.fn()
      .mockResolvedValueOnce({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), negotiation: fakeNegotiation(failedChannel.channel),
        pairingSelector: selector, generation: 1,
      })
      .mockResolvedValueOnce({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(3), negotiation: fakeNegotiation(recoveredChannel.channel),
        pairingSelector: selector, generation: 2,
      })
    const send = vi.fn(async () => {
      owner.invalidate(selector)
      throw new Error('Relay send lost the attachment')
    })
    const owner = new DesktopSnowRelayChannelOwner(
      { accept }, send, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS,
    )
    const ready = {
      type: 'ready' as const, transportVersion: 1 as const, routeId: parseRelayRouteId('route-race-send'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }
    owner.updatePeers(ready, selector)

    await expect(owner.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )).rejects.toThrow('Relay send lost the attachment')
    expect(failedChannel.dispose).toHaveBeenCalledOnce()
    send.mockImplementation(async () => {})
    owner.updatePeers({
      ...ready, peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 2 }],
    }, selector)
    await owner.receive(
      Uint8Array.of(4), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await owner.receive(
      Uint8Array.of(5), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    expect(accept).toHaveBeenCalledTimes(2)
    expect(recoveredChannel.seal).toHaveBeenCalledWith({
      type: 'projection', projection: { type: 'foreground-sync', desktopName: 'Authenticated Desktop', generation: 2, desktopRevision: 1 },
    })
    owner.invalidate(selector)
    expect(failedChannel.dispose).toHaveBeenCalledOnce()
    expect(recoveredChannel.dispose).toHaveBeenCalledOnce()
  })

  it('cancels before accept starts and contains a rejected accept promise', async () => {
    const selector = parseRelayPairingSelector('pairing-aborted')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-aborted')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-aborted')
    const ready = {
      type: 'ready' as const, transportVersion: 1 as const, routeId: parseRelayRouteId('route-aborted'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }
    const pending = deferred<Awaited<ReturnType<import('@deepseek-ai/dsh-noise-channel').SnowDesktopAttachmentOwner['accept']>>>()
    const aborted = new AbortController()
    aborted.abort()
    const cancelled = new DesktopSnowRelayChannelOwner(
      { accept: async () => await pending.promise }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME,
      NEGOTIATION_TIMEOUT_MS,
    )
    cancelled.updatePeers(ready, selector)
    await expect(cancelled.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, aborted.signal,
    )).rejects.toThrow('cancelled')
    const rejected = new DesktopSnowRelayChannelOwner({ accept: async () => {
      throw new Error('Snow rejected')
    } }, async () => {}, undefined, AUTHENTICATED_DESKTOP_NAME, NEGOTIATION_TIMEOUT_MS)
    rejected.updatePeers(ready, selector)
    await expect(rejected.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )).rejects.toThrow('Snow rejected')
  })

  it('mounts Desktop IK ownership and sends authenticated foreground synchronization', async () => {
    initializeSnowChannel(readFileSync(new URL(
      '../../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url,
    )))
    const vault = new DesktopSnowPairingVault()
    const local = await vault.createInvitation(Date.now() + 60_000)
    const challengeId = parsePairingChallengeId('challenge-assembled-mount')
    const pendingPairingId = parsePendingPairingId('pending-assembled-mount')
    vault.retainChallenge(challengeId, local.owner)
    vault.bindPending(challengeId, pendingPairingId)
    const mobileHandshake = new SnowMobileHandshakeClient()
    const message1 = await mobileHandshake.beginEndpointInvitation(local.invitationPayload)
    const message2 = await local.owner.acceptMessage1(message1)
    await mobileHandshake.acceptDesktopHandshake(message2)
    await local.owner.finishMessage3(mobileHandshake.exportFinishMessage())
    const pairingId = parsePersonalPairingId('pairing-assembled-mount')
    await vault.prepareConfirmation(pendingPairingId)
    const delivery = await vault.prepareSealedAuthority(pendingPairingId, {
      pairing: {
        id: pairingId,
        devicePrincipal: {
          id: 'principal-assembled-mount' as never, accountId: 'account-assembled-mount' as never,
          installationId: 'mobile-assembled-mount' as never, authority: 'companion-surface',
        },
        device: { name: 'Alice phone', platform: 'ios' }, pairedAt: 1, lastAccessAt: 1, online: false,
      },
      routeId: parseRelayRouteId('route-assembled-mount'), relayRevision: 1,
    })
    const mobileGrant = await mobileHandshake.openRelayAuthority(delivery.sealedRelayAuthority)
    const desktopGrant = vault.desktopRelayGrant(pendingPairingId)
    await vault.commitConfirmation(pendingPairingId)

    const socket = new TestRelaySocket()
    const relay = createDesktopRemoteRelay({
      environment: { ...DEVELOPMENT, environment: 'production' }, source: SOURCE,
      snowPairingVault: vault, connect: async () => socket,
      desktopName: AUTHENTICATED_DESKTOP_NAME, handleOperation: UNUSED_OPERATION_HANDLER,
    })
    await relay.configure?.(desktopGrant)
    const starting = relay.start()
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(1) })
    const request = decodeRelayMessage(socket.sent[0] as Uint8Array)
    if (request.type !== 'attach-challenge') throw new Error('Desktop Relay did not request an attach challenge')
    socket.push(encodeRelayMessage({
      ...request, type: 'attach-challenge-response',
      challengeId: parseRelayAttachChallengeId('challenge-assembled-attach'),
      nonce: new Uint8Array(32).fill(7), expiresAt: Date.now() + 10_000,
    }))
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(2) })
    const attach = decodeRelayMessage(socket.sent[1] as Uint8Array)
    if (attach.type !== 'attach') throw new Error('Desktop Relay did not attach')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-assembled-mount')
    const generation = 9
    const ready = {
      type: 'ready' as const, transportVersion: 1 as const, routeId: mobileGrant.routeId,
      attachmentId: attach.attachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: mobileGrant.pairingSelector, generation }],
    }
    socket.push(encodeRelayMessage(ready))
    await starting
    const mobileOwner = new SnowMobileAttachmentOwner(
      mobileHandshake.exportReconnectState(), mobileGrant.pairingSelector,
    )
    const begun = await mobileOwner.begin({ ...ready, attachmentId: mobileAttachmentId, peers: [{
      attachmentId: attach.attachmentId, pairingSelector: mobileGrant.pairingSelector, generation,
    }] })
    socket.push(encodeRelayMessage({
      type: 'ciphertext', transportVersion: 1, routeId: mobileGrant.routeId,
      sourceAttachmentId: mobileAttachmentId, targetAttachmentId: attach.attachmentId,
      ciphertext: begun.payload,
    }))
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(3) })
    const ik2 = decodeRelayMessage(socket.sent[2] as Uint8Array)
    if (ik2.type !== 'ciphertext') throw new Error('Desktop Relay did not send IK2')
    const mobileNegotiation = mobileOwner.finish(ik2.ciphertext, attach.attachmentId)
    socket.push(encodeRelayMessage({
      type: 'ciphertext', transportVersion: 1, routeId: mobileGrant.routeId,
      sourceAttachmentId: mobileAttachmentId, targetAttachmentId: attach.attachmentId,
      ciphertext: mobileNegotiation.payload,
    }))
    const channel = mobileNegotiation.finish()
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(4) })
    const sync = decodeRelayMessage(socket.sent[3] as Uint8Array)
    if (sync.type !== 'ciphertext') throw new Error('Desktop Relay did not send synchronization')
    expect(channel.open(sync.ciphertext)).toEqual({
      type: 'projection', projection: { type: 'foreground-sync', desktopName: 'Authenticated Desktop', generation, desktopRevision: 1 },
    })
    await relay.synchronize?.([])
    await relay.stop('quit')
  })

  it('validates the complete development bundle before socket acquisition', () => {
    expect(loadDesktopRemoteRelayConfig(SOURCE)).toEqual({
      url: SOURCE.DSH_REMOTE_RELAY_WSS_URL,
      attachTimeoutMs: 1_000,
      negotiationTimeoutMs: 5_000,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1_000,
      inboundMaxBytes: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
      inboundMaxMessages: 16,
    })
    for (const [field, value] of [
      ['DSH_REMOTE_RELAY_WSS_URL', 'ws://platform.example/relay'],
      ['DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS', '0'],
      ['DSH_REMOTE_RELAY_NEGOTIATION_TIMEOUT_MS', '1.5'],
      ['DSH_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS', '1.5'],
      ['DSH_REMOTE_RELAY_RECONNECT_DELAY_MS', ''],
      ['DSH_REMOTE_RELAY_INBOUND_MAX_BYTES', String(REMOTE_PROTOCOL_LIMITS.relayMessageBytes - 1)],
      ['DSH_REMOTE_RELAY_INBOUND_MAX_MESSAGES', 'many'],
    ] as const) {
      expect(() => loadDesktopRemoteRelayConfig({ ...SOURCE, [field]: value })).toThrow()
    }
  })

  it('selects the endpoint-owned lifecycle only in production', async () => {
    const connect = vi.fn(async (signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    }))
    const production = createDesktopRemoteRelay({
      environment: { ...DEVELOPMENT, environment: 'production' },
      source: SOURCE,
      connect,
      snowPairingVault: new DesktopSnowPairingVault(),
      initializeWasm: () => {},
      desktopName: AUTHENTICATED_DESKTOP_NAME, handleOperation: UNUSED_OPERATION_HANDLER,
    })
    await production.configure?.({
      routeId: parseRelayRouteId('route-production'), endpoint: 'desktop',
      credential: await generateRelayCredential(), revision: 1,
      pairingSelector: parseRelayPairingSelector('pairing-production'),
    })
    const starting = production.start()
    await vi.waitFor(() => { expect(connect).toHaveBeenCalledOnce() })
    await production.stop('quit')
    await expect(starting).rejects.toThrow()
    const disabled = createDesktopRemoteRelay({
      environment: DEVELOPMENT, source: SOURCE, connect,
      snowPairingVault: new DesktopSnowPairingVault(),
      desktopName: AUTHENTICATED_DESKTOP_NAME, handleOperation: UNUSED_OPERATION_HANDLER,
    })
    await expect(disabled.start()).rejects.toThrow('independently reviewed')
    expect(connect).toHaveBeenCalledOnce()
  })

  it('uses the Node WSS adapter when the product composition supplies no socket override', async () => {
    const socket = new TestRelaySocket()
    const connect = vi.spyOn(NodeRelayEndpointSocket, 'connect').mockResolvedValue(socket)
    const relay = createDesktopRemoteRelay({
      environment: { ...DEVELOPMENT, environment: 'production' }, source: SOURCE,
      snowPairingVault: new DesktopSnowPairingVault(), initializeWasm: () => {},
      desktopName: AUTHENTICATED_DESKTOP_NAME, handleOperation: UNUSED_OPERATION_HANDLER,
    })
    await relay.configure?.({
      routeId: parseRelayRouteId('route-default-adapter'), endpoint: 'desktop',
      credential: await generateRelayCredential(), revision: 1,
      pairingSelector: parseRelayPairingSelector('pairing-default-adapter'),
    })
    const starting = relay.start()
    await vi.waitFor(() => { expect(connect).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(1) })
    const request = decodeRelayMessage(socket.sent[0] as Uint8Array)
    if (request.type !== 'attach-challenge') throw new Error('Desktop Relay did not request an attach challenge')
    socket.push(encodeRelayMessage({
      ...request, type: 'attach-challenge-response',
      challengeId: parseRelayAttachChallengeId('challenge-default-adapter'),
      nonce: new Uint8Array(32).fill(8), expiresAt: Date.now() + 10_000,
    }))
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(2) })
    const attach = decodeRelayMessage(socket.sent[1] as Uint8Array)
    if (attach.type !== 'attach') throw new Error('Desktop Relay did not attach')
    socket.push(encodeRelayMessage({
      type: 'ready', transportVersion: 1, routeId: attach.routeId,
      attachmentId: attach.attachmentId, peers: [],
    }))
    await starting
    expect(connect).toHaveBeenCalledWith(SOURCE.DSH_REMOTE_RELAY_WSS_URL, expect.any(AbortSignal), {
      maxBytes: REMOTE_PROTOCOL_LIMITS.relayMessageBytes, maxMessages: 16,
    })
    await relay.stop()
  })

  it('validates Relay configuration independently from disabled composition', () => {
    expect(() => loadDesktopRemoteRelayConfig({
      ...SOURCE,
      DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS: undefined,
    })).toThrow('DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS')
  })
})

class TestRelaySocket implements RelayEndpointSocket {
  readonly sent: Uint8Array[] = []
  private readonly queued: Uint8Array[] = []
  private readonly waiting: Array<(value: IteratorResult<Uint8Array>) => void> = []
  private closed = false

  async send(value: Uint8Array): Promise<void> { this.sent.push(value.slice()) }
  push(value: Uint8Array): void {
    const resolve = this.waiting.shift()
    if (resolve === undefined) this.queued.push(value)
    else resolve({ done: false, value })
  }
  messages(): AsyncIterable<Uint8Array> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => {
      const value = this.queued.shift()
      if (value !== undefined) return { done: false as const, value }
      if (this.closed) return { done: true as const, value: undefined }
      return await new Promise<IteratorResult<Uint8Array>>((resolve) => { this.waiting.push(resolve) })
    } }) }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const resolve of this.waiting.splice(0)) resolve({ done: true, value: undefined })
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function fakeSnowChannel(applicationMajor: 3 | 4 = 4) {
  const channel = Object.create(SnowCompanionProtocolChannel.prototype) as SnowCompanionProtocolChannel
  const open = vi.fn<(ciphertext: Uint8Array) => ReturnType<SnowCompanionProtocolChannel['open']>>(
    () => ({ type: 'result', result: { type: 'status', operationId: 'fake' as never, absent: true } }),
  )
  const seal = vi.fn<(
    message: Parameters<SnowCompanionProtocolChannel['seal']>[0],
  ) => Uint8Array>(() => Uint8Array.of(9))
  const canEncode = vi.fn<(
    message: Parameters<SnowCompanionProtocolChannel['canEncode']>[0],
  ) => boolean>(() => true)
  const dispose = vi.fn()
  Object.defineProperties(channel, {
    applicationMajor: { value: applicationMajor },
    open: { value: open },
    seal: { value: seal },
    canEncode: { value: canEncode },
    dispose: { value: dispose },
  })
  return { channel, open, seal, canEncode, dispose }
}

function fakeNegotiation(channel: SnowCompanionProtocolChannel) {
  let open = true
  return {
    finish: vi.fn(() => {
      if (!open) throw new Error('fake negotiation is settled')
      open = false
      return channel
    }),
    cancel: vi.fn(() => {
      if (!open) return
      open = false
      channel.dispose()
    }),
  }
}

function liveSummary(sessionId: string, updatedAt: number) {
  return { sessionId, displayTitle: sessionId, running: true, blank: false, updatedAt }
}

function liveConversation(sessionId: string, nodes: readonly unknown[]) {
  return {
    sessionId, nodes, turnTimings: [], turnEnds: [], partial: null,
    runningCalls: [], pending: [], queue: [], running: true, subagent: null,
    composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
