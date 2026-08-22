import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeRelayMessage, encodeRelayMessage, parseRelayAttachmentId, parseRelayPairingSelector,
  parseRelayAttachChallengeId,
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
  DSH_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS: '30000',
  DSH_REMOTE_RELAY_RECONNECT_DELAY_MS: '1000',
  DSH_REMOTE_RELAY_INBOUND_MAX_BYTES: String(REMOTE_PROTOCOL_LIMITS.relayMessageBytes),
  DSH_REMOTE_RELAY_INBOUND_MAX_MESSAGES: '16',
}

describe('Desktop Remote Relay composition', () => {
  it.each(['replacement', 'revocation', 'connection-lost'] as const)(
    'cancels a pending IK accept before %s can install or send a stale channel',
    async (event) => {
      const accepted = deferred<Awaited<ReturnType<import('@deepseek-ai/dsh-noise-channel').SnowDesktopAttachmentOwner['accept']>>>()
      const channel = Object.create(SnowCompanionProtocolChannel.prototype) as SnowCompanionProtocolChannel
      const dispose = vi.fn()
      Object.defineProperty(channel, 'dispose', { value: dispose })
      const send = vi.fn(async () => {})
      const owner = new DesktopSnowRelayChannelOwner({ accept: async () => await accepted.promise }, send)
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
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel,
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
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel: channel.channel,
      pairingSelector: otherSelector, generation: 2,
    }) }, async () => {})
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
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel: channel.channel,
      pairingSelector: selector, generation: 1,
    }) }, send)
    const ready = {
      type: 'ready' as const, transportVersion: 1 as const, routeId: parseRelayRouteId('route-installed'),
      attachmentId: desktopAttachmentId,
      peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
    }
    owner.updatePeers(ready, selector)
    await owner.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
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
    const first = new DesktopSnowRelayChannelOwner({ accept: async () => await firstAccept.promise }, async () => {})
    first.updatePeers(ready, selector)
    const staleAfterAccept = first.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )
    await Promise.resolve()
    peers.splice(0)
    firstAccept.resolve({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel: firstChannel.channel,
      pairingSelector: selector, generation: 1,
    })
    await expect(staleAfterAccept).rejects.toThrow('stale Snow IK transcript')
    expect(firstChannel.dispose).toHaveBeenCalledOnce()

    const secondChannel = fakeSnowChannel()
    const secondPeers = [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }]
    const second = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel: secondChannel.channel,
      pairingSelector: selector, generation: 1,
    }) }, async () => { secondPeers.splice(0) })
    second.updatePeers({ ...ready, peers: secondPeers }, selector)
    await expect(second.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )).rejects.toThrow('stale Snow IK transcript')
    expect(secondChannel.dispose).toHaveBeenCalledOnce()

    const thirdChannel = fakeSnowChannel()
    const thirdPeers = [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }]
    let thirdSend = 0
    const third = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel: thirdChannel.channel,
      pairingSelector: selector, generation: 1,
    }) }, async () => {
      thirdSend += 1
      if (thirdSend === 2) thirdPeers.splice(0)
    })
    third.updatePeers({ ...ready, peers: thirdPeers }, selector)
    await expect(third.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
    )).rejects.toThrow('stale Snow IK transcript')
    expect(thirdChannel.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['IK response', 1],
    ['foreground synchronization', 2],
  ] as const)(
    'disposes an unpublished channel when the %s send fails and retries without advancing revision',
    async (_stage, failedSend) => {
      const selector = parseRelayPairingSelector(`pairing-send-${String(failedSend)}`)
      const desktopAttachmentId = parseRelayAttachmentId(`desktop-send-${String(failedSend)}`)
      const mobileAttachmentId = parseRelayAttachmentId(`mobile-send-${String(failedSend)}`)
      const failedChannel = fakeSnowChannel()
      const recoveredChannel = fakeSnowChannel()
      const accept = vi.fn()
        .mockResolvedValueOnce({
          targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel: failedChannel.channel,
          pairingSelector: selector, generation: 1,
        })
        .mockResolvedValueOnce({
          targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(3), channel: recoveredChannel.channel,
          pairingSelector: selector, generation: 1,
        })
      let sends = 0
      const send = vi.fn(async () => {
        sends += 1
        if (sends === failedSend) throw new Error('Relay send failed')
      })
      const owner = new DesktopSnowRelayChannelOwner({ accept }, send)
      owner.updatePeers({
        type: 'ready', transportVersion: 1, routeId: parseRelayRouteId(`route-send-${String(failedSend)}`),
        attachmentId: desktopAttachmentId,
        peers: [{ attachmentId: mobileAttachmentId, pairingSelector: selector, generation: 1 }],
      }, selector)

      await expect(owner.receive(
        Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )).rejects.toThrow('Relay send failed')
      expect(failedChannel.dispose).toHaveBeenCalledOnce()
      expect(failedChannel.open).not.toHaveBeenCalled()
      await owner.receive(
        Uint8Array.of(4), mobileAttachmentId, desktopAttachmentId, selector, new AbortController().signal,
      )
      expect(accept).toHaveBeenCalledTimes(2)
      expect(recoveredChannel.seal).toHaveBeenCalledWith({
        type: 'projection', projection: { type: 'foreground-sync', generation: 1, desktopRevision: 1 },
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
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(2), channel: failedChannel.channel,
        pairingSelector: selector, generation: 1,
      })
      .mockResolvedValueOnce({
        targetAttachmentId: mobileAttachmentId, payload: Uint8Array.of(3), channel: recoveredChannel.channel,
        pairingSelector: selector, generation: 2,
      })
    const send = vi.fn(async () => {
      owner.invalidate(selector)
      throw new Error('Relay send lost the attachment')
    })
    const owner = new DesktopSnowRelayChannelOwner({ accept }, send)
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
    expect(accept).toHaveBeenCalledTimes(2)
    expect(recoveredChannel.seal).toHaveBeenCalledWith({
      type: 'projection', projection: { type: 'foreground-sync', generation: 2, desktopRevision: 1 },
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
    const cancelled = new DesktopSnowRelayChannelOwner({ accept: async () => await pending.promise }, async () => {})
    cancelled.updatePeers(ready, selector)
    await expect(cancelled.receive(
      Uint8Array.of(1), mobileAttachmentId, desktopAttachmentId, selector, aborted.signal,
    )).rejects.toThrow('cancelled')
    const rejected = new DesktopSnowRelayChannelOwner({ accept: async () => {
      throw new Error('Snow rejected')
    } }, async () => {})
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
    await vi.waitFor(() => { expect(socket.sent).toHaveLength(4) })
    const responses = socket.sent.slice(2).map(decodeRelayMessage)
    const ik2 = responses[0]
    const sync = responses[1]
    if (ik2?.type !== 'ciphertext' || sync?.type !== 'ciphertext') {
      throw new Error('Desktop Relay did not send IK2 and synchronization')
    }
    const channel = mobileOwner.finish(ik2.ciphertext, attach.attachmentId)
    expect(channel.open(sync.ciphertext)).toEqual({
      type: 'projection', projection: { type: 'foreground-sync', generation, desktopRevision: 1 },
    })
    await relay.synchronize?.([])
    await relay.stop('quit')
  })

  it('validates the complete development bundle before socket acquisition', () => {
    expect(loadDesktopRemoteRelayConfig(SOURCE)).toEqual({
      url: SOURCE.DSH_REMOTE_RELAY_WSS_URL,
      attachTimeoutMs: 1_000,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1_000,
      inboundMaxBytes: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
      inboundMaxMessages: 16,
    })
    for (const [field, value] of [
      ['DSH_REMOTE_RELAY_WSS_URL', 'ws://platform.example/relay'],
      ['DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS', '0'],
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

function fakeSnowChannel(): {
  channel: SnowCompanionProtocolChannel
  open: ReturnType<typeof vi.fn>
  seal: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
} {
  const channel = Object.create(SnowCompanionProtocolChannel.prototype) as SnowCompanionProtocolChannel
  const open = vi.fn(() => ({ type: 'result' }))
  const seal = vi.fn(() => Uint8Array.of(9))
  const dispose = vi.fn()
  Object.defineProperties(channel, {
    open: { value: open },
    seal: { value: seal },
    dispose: { value: dispose },
  })
  return { channel, open, seal, dispose }
}
