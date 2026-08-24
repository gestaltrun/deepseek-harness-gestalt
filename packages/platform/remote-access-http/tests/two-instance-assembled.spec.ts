/** REAL Loader composition: two Platform Instances share test adapters and one TLS endpoint. */

import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { createServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parseRelayInstanceId,
  type PairingHandshakeProvider,
  type PersonalPairingId,
  type RelayCredentialGrant,
  type RelayRouteStore,
} from '@deepseek-ai/dsh-remote-access'
import { RemoteRelayProvider } from '@deepseek-ai/dsh-remote-access/relay-provider'
import {
  RemoteAccessHttpTransport,
  RemoteRelayEndpointController,
  type RelayEndpointSocket,
} from '@deepseek-ai/dsh-remote-access-client'
import { DesktopRelayEndpointLifecycle } from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'
import { NodeRelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client/node-relay-socket'
import { RedisRelayCoordinator, type RelayRedisClient } from '@deepseek-ai/dsh-remote-access-redis'
import {
  deriveRelayCredentialDigest,
  decodeRelayMessage,
  deriveRelayCredentialPublicKey,
  encodeRelayMessage,
  generateRelayCredential,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  parseRelayCredential,
  REMOTE_PROTOCOL_LIMITS,
  type RelayAttachmentId,
  type RelayCiphertextMessage,
  type RelayPairingSelector,
  type RelayRouteId,
  signRelayAttachmentChallenge,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  initializeSnowChannel,
  SnowDesktopAttachmentOwner,
  SnowDesktopEndpointPairingOwner,
  SnowMobileAttachmentOwner,
  SnowMobileHandshakeClient,
  type SnowCompanionProtocolChannel,
} from '@deepseek-ai/dsh-noise-channel'
import WebSocket from 'ws'
import * as RemoteAccessHttp from '../src/index.ts'
import * as RemoteAccessRelay from '../src/relay.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const ORIGIN = 'https://platform.dev.example.com'
const PROMPT = 'continue from Mobile across Loader instances'
const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development',
    origin: ORIGIN,
    callbackUrl: `${ORIGIN}/v1/account/oauth/github/callback`,
    githubClientId: 'assembled-development',
    credentialReference: 'credentials://development',
    databaseIdentity: 'assembled-database-development',
    identityNamespace: 'assembled-development',
  },
  production: {
    environment: 'production',
    origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'assembled-production',
    credentialReference: 'credentials://production',
    databaseIdentity: 'assembled-database-production',
    identityNamespace: 'assembled-production',
  },
}), 'development')
const RELAY_CONFIG = {
  capacityRetryAfterMs: 100,
  deliveryAckTimeoutMs: 500,
  directoryTtlMs: 2_000,
  heartbeatTimeoutMs: 1_000,
  maxBufferedCiphertextBytes: 131_070,
  maxConnections: 16,
  maxPendingDeliveries: 16,
} as const
const CLIENT = {
  attachTimeoutMs: 1_000,
  heartbeatIntervalMs: 50,
  reconnectDelayMs: 10,
  inboundMaxBytes: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
  inboundMaxMessages: 16,
} as const
const FORBIDDEN_REDIS_APIS = [
  'lpush', 'rpush', 'lpop', 'rpop', 'lrange', 'llen', 'ltrim',
  'xadd', 'xread', 'xreadgroup', 'xgroup', 'xack', 'xdel', 'xrange', 'xrevrange', 'xlen',
] as const

function rejectedReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason as unknown)
  }
  return errors
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(async (close) => { await close() }))
  const errors = rejectedReasons(results)
  if (errors.length > 0) throw new AggregateError(errors, 'two-instance assembled cleanup failed')
}, 30_000)

describe('two Loader-booted Platform Instances', () => {
  it('routes one encrypted pair across a non-sticky TLS endpoint and recovers after instance loss', {
    timeout: 90_000,
  }, async () => {
    const bus = new AssembledRedisBus()
    const shared = {
      authority: new MemoryPersonalPairingAuthorityStore(),
      routeStore: new AssembledRouteStore(),
      coordinator: new RedisRelayCoordinator({
        command: bus.client(), subscriber: bus.client(), keyPrefix: 'dsh:assembled:relay',
      }),
    }
    const instanceA = await withPhase('load platform-a', loadInstance('platform-a', shared, 11))
    const instanceB = await withPhase('load platform-b', loadInstance('platform-b', shared, 29))
    const acquired: string[] = []
    const endpoint = await withPhase('listen TLS endpoint', startNonStickyTlsEndpoint([instanceA, instanceB], acquired))
    const desktopAuth = authentication('desktop', 'desktop-assembled')
    const firstMobileAuth = authentication('mobile', 'mobile-assembled-one')
    const secondMobileAuth = authentication('mobile', 'mobile-assembled-two')
    const observedPlatformBodies: string[] = []
    const desktopTransport = new RemoteAccessHttpTransport({
      environment: ENVIRONMENT,
      fetch: rewriteFetch(ORIGIN, instanceA.port, observedPlatformBodies),
    })
    const firstMobileTransport = new RemoteAccessHttpTransport({
      environment: ENVIRONMENT,
      fetch: rewriteFetch(ORIGIN, instanceB.port, observedPlatformBodies),
    })
    const secondMobileTransport = new RemoteAccessHttpTransport({
      environment: ENVIRONMENT,
      fetch: rewriteFetch(ORIGIN, instanceA.port, observedPlatformBodies),
    })

    const enabled = await withPhase('enable Mobile Access', desktopTransport.setMobileAccess({
      authentication: desktopAuth, enabled: true,
    }))
    expect(enabled.enabled).toBe(true)
    expect(enabled.relay).toBeUndefined()
    initializeSnowChannel(await readFile(new URL('../../noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url)))
    const firstPairing = await pairEndpointThroughHttp({
      suffix: 'one', desktopTransport, mobileTransport: firstMobileTransport,
      desktopAuth, mobileAuth: firstMobileAuth,
    })
    const secondPairing = await pairEndpointThroughHttp({
      suffix: 'two', desktopTransport, mobileTransport: secondMobileTransport,
      desktopAuth, mobileAuth: secondMobileAuth,
    })
    const routeId = firstPairing.desktopGrant.routeId
    expect(secondPairing.desktopGrant.routeId).toBe(routeId)
    expect(new Set([
      firstPairing.desktopGrant.credential, firstPairing.mobileGrant.credential,
      secondPairing.desktopGrant.credential, secondPairing.mobileGrant.credential,
    ]).size).toBe(4)
    expect(firstPairing.desktopGrant.pairingSelector).not.toBe(secondPairing.desktopGrant.pairingSelector)
    const platformObservation = observedPlatformBodies.join('\n')
    const platformStateObservation = await shared.authority.runPairingTransaction(state => Promise.resolve(JSON.stringify({
      endpointMailbox: state.endpointMailbox,
      endpointPublications: [...state.endpointPublications],
      endpointPublicationRevocations: [...state.endpointPublicationRevocations],
      pairings: [...state.pairings],
    })))
    for (const pkcs8Sentinel of [
      firstPairing.desktopGrant.credential, firstPairing.mobileGrant.credential,
      secondPairing.desktopGrant.credential, secondPairing.mobileGrant.credential,
    ]) {
      expect(platformObservation).not.toContain(pkcs8Sentinel)
      expect(platformStateObservation).not.toContain(pkcs8Sentinel)
    }

    const rejected = await withPhase('reject route-id-only attach', attachWithCredential(
      endpoint.url,
      routeId,
      parseRelayAttachmentId('intruder-assembled'),
      'desktop',
      await generateRelayCredential(),
    ))
    expect(rejected).toMatchObject({ type: 'error', code: 'RELAY_ATTACHMENT_REJECTED' })
    const direct = await withPhase('direct WebServer attach', attachWithCredential(
      `ws://127.0.0.1:${String(instanceA.port)}/v1/remote-access/relay`,
      routeId,
      parseRelayAttachmentId('direct-assembled'),
      'desktop',
      await generateRelayCredential(),
    ))
    expect(direct).toMatchObject({ type: 'error', code: 'RELAY_ATTACHMENT_REJECTED' })
    acquired.length = 0
    endpoint.resetAcquisition()

    const firstMobileAttachmentId = parseRelayAttachmentId('mobile-assembled-one')
    const secondMobileAttachmentId = parseRelayAttachmentId('mobile-assembled-two')
    let desktopAttachmentId = parseRelayAttachmentId('desktop-assembled-0')
    let desktopGeneration = 0
    const failover = deferred<'resync'>()
    const firstSynchronized = deferred<undefined>()
    const secondSynchronized = deferred<undefined>()
    const firstAccepted = deferred<'accepted'>()
    const secondAccepted = deferred<'accepted'>()
    const firstOffline = deferred<string>()
    const clientErrors: string[] = []
    const synchronizationCounts = new Map<RelayPairingSelector, number>()
    const desktopPeerGenerations = new Map<RelayPairingSelector, number>()
    const desktopProjections = new Map<RelayPairingSelector, Parameters<SnowMobileAttachmentOwner['begin']>[0]>()
    const desktopChannels = new Map<RelayPairingSelector, SnowCompanionProtocolChannel>()
    const desktopNegotiations = new Map<RelayPairingSelector, Awaited<ReturnType<SnowDesktopAttachmentOwner['accept']>>>()
    const connectEndpoint = async (signal: AbortSignal) => await NodeRelayEndpointSocket.connect(
      endpoint.url,
      signal,
      { maxBytes: CLIENT.inboundMaxBytes, maxMessages: CLIENT.inboundMaxMessages },
      { rejectUnauthorized: false },
    )
    const pairingBySelector = new Map([
      [firstPairing.desktopGrant.pairingSelector, firstPairing],
      [secondPairing.desktopGrant.pairingSelector, secondPairing],
    ])
    const desktopOwner = new SnowDesktopAttachmentOwner(selector =>
      pairingBySelector.get(selector)?.desktopPairing.exportReconnectState())
    const desktop = new DesktopRelayEndpointLifecycle({
      attachmentId: () => {
        desktopGeneration += 1
        desktopAttachmentId = parseRelayAttachmentId(`desktop-assembled-${String(desktopGeneration)}`)
        return desktopAttachmentId
      },
      connect: connectEndpoint,
      attachTimeoutMs: CLIENT.attachTimeoutMs,
      heartbeatIntervalMs: CLIENT.heartbeatIntervalMs,
      reconnectDelayMs: CLIENT.reconnectDelayMs,
      resynchronize: async () => {},
      onPeerAttachments: (update, pairingSelector) => {
        const peer = update.peers.find(candidate => candidate.pairingSelector === pairingSelector)
        const previousGeneration = desktopPeerGenerations.get(pairingSelector)
        if (peer !== undefined && previousGeneration !== undefined && previousGeneration !== peer.generation) {
          desktopNegotiations.get(pairingSelector)?.negotiation.cancel()
          desktopNegotiations.delete(pairingSelector)
          desktopChannels.get(pairingSelector)?.dispose()
          desktopChannels.delete(pairingSelector)
        }
        if (peer !== undefined) desktopPeerGenerations.set(pairingSelector, peer.generation)
        desktopProjections.set(pairingSelector, update)
      },
      onCiphertext: async (ciphertext, sourceAttachmentId, localAttachmentId, pairingSelector) => {
        let channel = desktopChannels.get(pairingSelector)
        if (channel === undefined) {
          const pendingNegotiation = desktopNegotiations.get(pairingSelector)
          if (pendingNegotiation !== undefined) {
            if (pendingNegotiation.targetAttachmentId !== sourceAttachmentId) {
              throw new Error('Desktop Companion offer did not match its authenticated Mobile attachment')
            }
            channel = pendingNegotiation.negotiation.finish(ciphertext)
            desktopNegotiations.delete(pairingSelector)
            desktopChannels.set(pairingSelector, channel)
            await desktop.sendCiphertext(pairingSelector, sourceAttachmentId, channel.seal({
              type: 'projection',
              projection: { type: 'foreground-sync', desktopName: 'Assembled Desktop', generation: pendingNegotiation.generation, desktopRevision: 1 },
            }))
            const count = (synchronizationCounts.get(pairingSelector) ?? 0) + 1
            synchronizationCounts.set(pairingSelector, count)
            if (count > 1) failover.resolve('resync')
            return
          }
          const projection = desktopProjections.get(pairingSelector)
          if (projection === undefined) throw new Error('Desktop Snow IK has no Relay peer projection')
          const accepted = await desktopOwner.accept(
            ciphertext, sourceAttachmentId, projection.routeId, localAttachmentId,
          )
          const peer = projection.peers.find(candidate => candidate.attachmentId === sourceAttachmentId)
          if (peer?.generation !== accepted.generation || peer.pairingSelector !== pairingSelector) {
            throw new Error('Desktop Snow IK did not match the live pairing projection')
          }
          desktopNegotiations.set(pairingSelector, accepted)
          await desktop.sendCiphertext(pairingSelector, accepted.targetAttachmentId, accepted.payload)
          return
        }
        const message = channel.open(ciphertext)
        if (message.type !== 'operation') return
        await desktop.sendCiphertext(pairingSelector, sourceAttachmentId, channel.seal({
          type: 'result',
          result: {
            type: 'confirmed', operationId: message.operation.operationId,
            committedAt: 1_787_027_200_000, outcome: 'accepted',
          },
        }))
      },
      onConnectionLost: (attachmentId) => {
        for (const [pairingSelector, projection] of desktopProjections) {
          if (projection.attachmentId !== attachmentId) continue
          desktopNegotiations.get(pairingSelector)?.negotiation.cancel()
          desktopNegotiations.delete(pairingSelector)
          desktopChannels.get(pairingSelector)?.dispose()
          desktopChannels.delete(pairingSelector)
          desktopProjections.delete(pairingSelector)
          desktopPeerGenerations.delete(pairingSelector)
        }
      },
      onTransportError: (error) => { clientErrors.push(`desktop:${error.code}:${error.message}`) },
    })
    const firstMobile = createSnowMobileAttachment({
      pairing: firstPairing, attachmentId: firstMobileAttachmentId, connect: connectEndpoint,
      synchronized: firstSynchronized, accepted: firstAccepted, offline: firstOffline, errors: clientErrors,
    })
    const secondMobile = createSnowMobileAttachment({
      pairing: secondPairing, attachmentId: secondMobileAttachmentId, connect: connectEndpoint,
      synchronized: secondSynchronized, accepted: secondAccepted, errors: clientErrors,
    })
    cleanups.push(async () => { await firstMobile.controller.stop() })
    cleanups.push(async () => { await secondMobile.controller.stop() })
    cleanups.push(async () => { await desktop.stop('quit') })

    await withPhase('first Mobile start', firstMobile.controller.start())
    await withPhase('first Mobile directory', waitForDirectory(shared.coordinator, routeId, firstMobileAttachmentId))
    await desktop.configure(firstPairing.desktopGrant)
    await withPhase('desktop start', desktop.start())
    await withPhase('first pairing synchronization', firstSynchronized.promise, () => clientErrors.join(','))

    await withPhase('second Mobile start', secondMobile.controller.start())
    await withPhase('second Mobile directory', waitForDirectory(shared.coordinator, routeId, secondMobileAttachmentId))
    await desktop.synchronize([firstPairing.desktopGrant, secondPairing.desktopGrant])
    await withPhase('second pairing synchronization', secondSynchronized.promise, () => clientErrors.join(','))
    expect(new URL(endpoint.url).protocol).toBe('wss:')
    expect(new URL(endpoint.url).pathname).toBe('/v1/remote-access/relay')
    expect(new Set(acquired)).toEqual(new Set(['platform-a', 'platform-b']))
    expect(new Set([
      firstMobileAttachmentId, secondMobileAttachmentId,
      ...[...desktopProjections.values()].map(update => update.attachmentId),
    ]).size).toBe(4)

    await firstMobile.send({
      type: 'operation',
      operation: {
        type: 'submit-prompt', operationId: parseCompanionOperationId('operation-assembled-one'),
        sessionId: parseCompanionSessionId('session-assembled'),
        text: PROMPT,
      },
    })
    expect(await withPhase('encrypted round trip', firstAccepted.promise)).toBe('accepted')
    const forwarded = publishedCiphertextFrames(bus.published)
    expect(forwarded.length).toBeGreaterThan(0)
    for (const frame of forwarded) {
      expect(frame.type).toBe('ciphertext')
      expect(new TextDecoder().decode(frame.ciphertext)).not.toContain(PROMPT)
    }
    bus.assertNoRetainedCiphertextFrames()

    await instanceB.dispose()
    await withPhase('desktop authoritative resync', failover.promise)
    const replacement = await withPhase(
      'replacement directory',
      waitForDirectory(shared.coordinator, routeId, desktopAttachmentId),
    )
    expect(desktopGeneration).toBeGreaterThan(1)
    expect(replacement.instanceId).toBe('platform-a')

    const secondEpoch = secondMobile.epoch()
    await desktopTransport.revokePersonalPairing({
      authentication: desktopAuth, pairingId: firstPairing.pairingId,
    })
    await desktop.synchronize([secondPairing.desktopGrant])
    expect(await withPhase('first pairing revocation', firstOffline.promise))
      .toMatch(/RELAY_ATTACHMENT_REJECTED|RELAY_ROUTE_REVOKED|REMOTE_OFFLINE/u)
    await firstMobile.controller.stop()
    await waitUntil(() => secondMobile.ready() && secondMobile.epoch() > secondEpoch)
    await secondMobile.send({
      type: 'operation',
      operation: {
        type: 'submit-prompt', operationId: parseCompanionOperationId('operation-assembled-two'),
        sessionId: parseCompanionSessionId('session-assembled'), text: 'second phone remains independent',
      },
    })
    expect(await withPhase('second pairing after independent revocation', secondAccepted.promise)).toBe('accepted')
    bus.assertNoRetainedCiphertextFrames()

    await desktopTransport.setMobileAccess({ authentication: desktopAuth, enabled: false })
    await waitUntil(async () => await shared.coordinator.locate(routeId, secondMobileAttachmentId) === undefined)
    expect(await shared.coordinator.locate(routeId, secondMobileAttachmentId)).toBeUndefined()
  })
})

interface SharedAdapters {
  authority: MemoryPersonalPairingAuthorityStore
  routeStore: RelayRouteStore
  coordinator: RedisRelayCoordinator
}

interface InstanceHandle {
  id: string
  context: Context
  port: number
  available: boolean
  dispose(): Promise<void>
}

type PairingScopedGrant = RelayCredentialGrant & { pairingSelector: RelayPairingSelector }

interface AssembledEndpointPairing {
  pairingId: PersonalPairingId
  desktopPairing: SnowDesktopEndpointPairingOwner
  mobilePairing: SnowMobileHandshakeClient
  desktopGrant: PairingScopedGrant
  mobileGrant: PairingScopedGrant
}

async function pairEndpointThroughHttp(input: {
  suffix: string
  desktopTransport: RemoteAccessHttpTransport
  mobileTransport: RemoteAccessHttpTransport
  desktopAuth: ReturnType<typeof authentication>
  mobileAuth: ReturnType<typeof authentication>
}): Promise<AssembledEndpointPairing> {
  const expiresAt = Date.now() + 60_000
  const challenge = await input.desktopTransport.createEndpointChallenge({
    authentication: input.desktopAuth,
    rendezvousId: parsePairingRendezvousId(`rendezvous-${input.suffix}`),
    expiresAt,
  })
  expect(new URL(challenge.routingLink).searchParams.has('payload')).toBe(false)
  const desktopPairing = new SnowDesktopEndpointPairingOwner()
  const invitation = await desktopPairing.createInvitation(expiresAt)
  const mobilePairing = new SnowMobileHandshakeClient()
  const message1 = await mobilePairing.beginEndpointInvitation(invitation.invitationPayload)
  const completionId = parsePairingCompletionId(`completion-${input.suffix}`)
  const pending = await input.mobileTransport.submitEndpointMessage1({
    authentication: input.mobileAuth,
    challengeId: challenge.challengeId,
    completionId,
    message1,
  })
  const message2 = await desktopPairing.acceptMessage1(message1)
  await input.desktopTransport.submitEndpointMessage2({
    authentication: input.desktopAuth,
    pendingPairingId: pending.pendingPairingId,
    message2,
  })
  await mobilePairing.acceptDesktopHandshake(message2)
  const message3 = mobilePairing.exportFinishMessage()
  await input.mobileTransport.submitEndpointMessage3({
    authentication: input.mobileAuth, completionId, message3,
  })
  await desktopPairing.finishMessage3(message3)
  const desktopCredential = await generateRelayCredential()
  const mobileCredential = await generateRelayCredential()
  const confirmation = await input.desktopTransport.confirmEndpointPairing({
    authentication: input.desktopAuth,
    pendingPairingId: pending.pendingPairingId,
    desktopCredentialDigest: await deriveRelayCredentialDigest(desktopCredential),
    mobileCredentialDigest: await deriveRelayCredentialDigest(mobileCredential),
  })
  const pairingSelector = parseRelayPairingSelector(confirmation.pairing.id)
  const desktopGrant: PairingScopedGrant = {
    routeId: confirmation.routeId, endpoint: 'desktop', credential: desktopCredential,
    revision: confirmation.relayRevision, pairingSelector,
  }
  const sealedRelayAuthority = await desktopPairing.sealMobileRelayAuthority({
    routeId: confirmation.routeId, endpoint: 'mobile', credential: mobileCredential,
    revision: confirmation.relayRevision, pairingSelector,
  }, new Uint8Array(32).fill(31))
  await input.desktopTransport.deliverEndpointRelayAuthority({
    authentication: input.desktopAuth,
    pendingPairingId: pending.pendingPairingId,
    sealedRelayAuthority,
  })
  const status = await input.mobileTransport.getEndpointPairingStatus({
    authentication: input.mobileAuth, completionId,
  })
  if (status.stage !== 'confirmed') throw new Error('Mobile endpoint mailbox did not receive sealed Relay authority')
  const mobileGrant = await mobilePairing.openRelayAuthority(status.sealedRelayAuthority)
  if (mobileGrant.pairingSelector === undefined) throw new Error('Mobile Relay authority omitted its pairing selector')
  return {
    pairingId: confirmation.pairing.id,
    desktopPairing,
    mobilePairing,
    desktopGrant,
    mobileGrant: { ...mobileGrant, pairingSelector: mobileGrant.pairingSelector },
  }
}

function createSnowMobileAttachment(input: {
  pairing: AssembledEndpointPairing
  attachmentId: RelayAttachmentId
  connect: (signal: AbortSignal) => Promise<RelayEndpointSocket>
  synchronized: ReturnType<typeof deferred<undefined>>
  accepted: ReturnType<typeof deferred<'accepted'>>
  offline?: ReturnType<typeof deferred<string>>
  errors: string[]
}) {
  const owner = new SnowMobileAttachmentOwner(
    input.pairing.mobilePairing.exportReconnectState(), input.pairing.mobileGrant.pairingSelector,
  )
  let channel: SnowCompanionProtocolChannel | undefined
  let targetAttachmentId: RelayAttachmentId | undefined
  let peerGeneration: number | undefined
  let epoch = 0
  const controller = new RemoteRelayEndpointController({
    endpoint: 'mobile',
    route: () => Promise.resolve(input.pairing.mobileGrant),
    attachmentId: () => input.attachmentId,
    connect: input.connect,
    attachTimeoutMs: CLIENT.attachTimeoutMs,
    heartbeatIntervalMs: CLIENT.heartbeatIntervalMs,
    reconnectDelayMs: CLIENT.reconnectDelayMs,
    onPeerAttachments: async (update) => {
      const peer = update.peers.find(candidate =>
        candidate.pairingSelector === input.pairing.mobileGrant.pairingSelector)
      if (peer === undefined || peerGeneration === peer.generation) return
      channel?.dispose()
      channel = undefined
      peerGeneration = peer.generation
      const begun = await owner.begin(update)
      targetAttachmentId = begun.targetAttachmentId
      await controller.sendCiphertext(begun.targetAttachmentId, begun.payload)
    },
    onCiphertext: async (ciphertext, sourceAttachmentId) => {
      if (channel === undefined) {
        const negotiation = owner.finish(ciphertext, sourceAttachmentId)
        try {
          await controller.sendCiphertext(negotiation.targetAttachmentId, negotiation.payload)
          channel = negotiation.finish()
        } catch (error) {
          negotiation.cancel()
          throw error
        }
        return
      }
      const message = channel.open(ciphertext)
      if (message.type === 'projection' && message.projection.type === 'foreground-sync') {
        epoch += 1
        input.synchronized.resolve(undefined)
      }
      if (message.type === 'result' && message.result.type === 'confirmed') {
        input.accepted.resolve(message.result.outcome)
      }
    },
    onTransportError: (error) => {
      input.errors.push(`mobile:${input.attachmentId}:${error.code}:${error.message}`)
      input.offline?.resolve(error.code)
    },
    onConnectionLost: () => {
      owner.cancel()
      channel?.dispose()
      channel = undefined
      targetAttachmentId = undefined
      peerGeneration = undefined
    },
  })
  return {
    controller,
    epoch: () => epoch,
    ready: () => channel !== undefined && targetAttachmentId !== undefined,
    async send(message: Parameters<SnowCompanionProtocolChannel['seal']>[0]): Promise<void> {
      if (channel === undefined || targetAttachmentId === undefined) throw new Error('Mobile Snow channel is unavailable')
      await controller.sendCiphertext(targetAttachmentId, channel.seal(message))
    },
  }
}

async function loadInstance(id: string, shared: SharedAdapters, entropy: number): Promise<InstanceHandle> {
  const root = await mkdtemp(join(tmpdir(), `dsh-two-instance-${id}-`))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: 'assembled-platform-instance'",
    "- name: '@deepseek-ai/dsh-remote-access-http'",
    '  config:',
    `    origin: '${ORIGIN}'`,
    "- name: '@deepseek-ai/dsh-remote-access-http/relay'",
    '  config:',
    "    path: '/v1/remote-access/relay'",
    '    attachTimeoutMs: 1000',
    '    maxPendingChallenges: 16',
    '',
  ].join('\n'))
  const context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['assembled-platform-instance', instanceProvider(id, shared, entropy)],
    ['@deepseek-ai/dsh-remote-access-http', RemoteAccessHttp],
    ['@deepseek-ai/dsh-remote-access-http/relay', RemoteAccessRelay],
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
  const webServer = context.get('webServer')
  if (webServer === undefined || typeof webServer.port !== 'number') {
    throw new Error(`${id} exposed no WebServer port`)
  }
  let disposed = false
  const handle: InstanceHandle = {
    id,
    context,
    port: webServer.port,
    available: true,
    async dispose() {
      if (disposed) return
      disposed = true
      handle.available = false
      const results = await Promise.allSettled([
        context.fiber.dispose(),
        rm(root, { recursive: true, force: true }),
      ])
      const errors = rejectedReasons(results)
      if (errors.length > 0) throw new AggregateError(errors, `${id} assembled instance dispose failed`)
    },
  }
  cleanups.push(async () => { await handle.dispose() })
  return handle
}

function instanceProvider(id: string, shared: SharedAdapters, entropy: number): unknown {
  return {
    name: 'assembled-platform-instance',
    apply(ctx: Context) {
      const relay = new RemoteRelayProvider(ctx, {
        instanceId: parseRelayInstanceId(id),
        routeStore: shared.routeStore,
        coordinator: shared.coordinator,
        config: RELAY_CONFIG,
        randomBytes: (size) => {
          const bytes = randomBytes(size)
          bytes[0] = entropy
          return bytes
        },
      })
      new PersonalPairingProvider(ctx, {
        account: {
          currentInstallation: async ({ accessToken }) => {
            const [kind, installation] = accessToken.split(':') as ['desktop' | 'mobile', string]
            return {
              account: {
                id: parsePlatformAccountId('account-assembled'),
                githubId: 1,
                githubLogin: 'assembled',
                avatarUrl: 'https://avatars.example/assembled',
              },
              installation: kind === 'mobile'
                ? {
                  id: parseInstallationId(installation),
                  kind,
                  presentation: { name: `${installation} installation`, platform: 'ios' },
                }
                : { id: parseInstallationId(installation), kind: 'desktop' as const, presentation: { name: 'Test Desktop', platform: 'linux' as const } },
            }
          },
        },
        handshake: endpointOnlyHandshake(),
        relay,
        authority: shared.authority,
        randomBytes: size => new Uint8Array(size).fill(41),
        randomId: kind => `${kind}-${id}-${crypto.randomUUID()}`,
        pairingLinkOrigin: 'https://platform.example/pair',
      })
    },
  }
}

function endpointOnlyHandshake(): PairingHandshakeProvider {
  const unavailable = () => Promise.reject(new Error('Assembled product path forbids Platform pairing cryptography'))
  return {
    createChallenge: unavailable,
    completeChallenge: unavailable,
    activatePairing: unavailable,
    destroyChallenge: () => {},
    destroyPendingPairing: () => {},
    destroyPairing: () => {},
  }
}

async function startNonStickyTlsEndpoint(
  instances: InstanceHandle[],
  acquired: string[],
): Promise<{ url: string; resetAcquisition(): void }> {
  const [key, cert] = await Promise.all([
    readFile(`${FIXTURES}localhost-key.pem`),
    readFile(`${FIXTURES}localhost-cert.pem`),
  ])
  const server = createServer({ key, cert }, (_request, response) => { response.writeHead(404); response.end() })
  const backends = new Set<Socket>()
  const frontends = new Set<Duplex>()
  let next = 0
  server.on('upgrade', (request, socket, head) => {
    const live = instances.filter(instance => instance.available)
    const instance = live[next++ % live.length]
    if (instance === undefined) { socket.destroy(); return }
    acquired.push(instance.id)
    frontends.add(socket)
    socket.once('close', () => { frontends.delete(socket) })
    proxyHttpUpgrade(request, socket, head, instance.port, backends)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('assembled TLS endpoint did not bind a TCP port')
  }
  cleanups.push(async () => {
    for (const frontend of frontends) frontend.destroy()
    for (const backend of backends) backend.destroy()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { resolve() }, 1_000)
      server.close((error) => {
        clearTimeout(timer)
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })
  return {
    url: `wss://127.0.0.1:${String(address.port)}/v1/remote-access/relay`,
    resetAcquisition() { next = 0 },
  }
}

function proxyHttpUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  port: number,
  backends: Set<Socket>,
): void {
  const backend = connect({ host: '127.0.0.1', port })
  backends.add(backend)
  backend.once('close', () => { backends.delete(backend) })
  backend.once('connect', () => {
    let block = `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1\r\n`
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) block += `${name}: ${item}\r\n`
    }
    backend.write(`${block}\r\n`)
    if (head.byteLength > 0) backend.write(head)
    backend.pipe(socket)
    socket.pipe(backend)
  })
  backend.on('error', () => { socket.destroy() })
  socket.on('error', () => { backend.destroy() })
}

async function attachWithCredential(
  url: string,
  routeId: RelayRouteId,
  attachmentId: RelayAttachmentId,
  endpoint: 'mobile' | 'desktop',
  credential: ReturnType<typeof parseRelayCredential>,
): Promise<ReturnType<typeof decodeRelayMessage>> {
  const socket = new WebSocket(url, url.startsWith('wss:') ? { rejectUnauthorized: false } : undefined)
  await once(socket, 'open')
  const challengeMessage = once(socket, 'message') as Promise<[WebSocket.RawData]>
  socket.send(encodeRelayMessage({
    type: 'attach-challenge', transportVersion: 1, routeId, attachmentId, endpoint,
    credentialPublicKey: await deriveRelayCredentialPublicKey(credential),
  }))
  const [challengeData] = await challengeMessage
  const challenge = decodeRelayMessage(bytes(challengeData))
  if (challenge.type !== 'attach-challenge-response') throw new Error('Relay did not issue an attach challenge')
  const received = once(socket, 'message') as Promise<[WebSocket.RawData]>
  socket.send(encodeRelayMessage(await signRelayAttachmentChallenge(credential, challenge)))
  const [data] = await received
  socket.close()
  return decodeRelayMessage(bytes(data))
}

function authentication(kind: 'desktop' | 'mobile', id: string) {
  return {
    accessToken: `${kind}:${id}`,
    proof: { jti: parseAccountProofJti(`${kind}-${id}`), issuedAt: 1, signature: 'assembled' },
  }
}

function rewriteFetch(origin: string, port: number, observedBodies: string[]): typeof fetch {
  return async (input, init = {}) => {
    const source = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init.headers)
    headers.set('origin', origin)
    if (typeof init.body === 'string') observedBodies.push(init.body)
    return fetch(`http://127.0.0.1:${String(port)}${source.pathname}${source.search}`, { ...init, headers })
  }
}

function publishedCiphertextFrames(published: readonly string[]): RelayCiphertextMessage[] {
  const frames: RelayCiphertextMessage[] = []
  for (const value of published) {
    const record = JSON.parse(value) as Record<string, unknown>
    if (record.type !== 'ciphertext') continue
    if (typeof record.frame !== 'string') throw new Error('Relay publish event omitted its ciphertext frame')
    const message = decodeRelayMessage(Uint8Array.from(Buffer.from(record.frame, 'base64url')))
    if (message.type !== 'ciphertext') throw new Error('Relay publish frame was not ciphertext')
    frames.push(message)
  }
  return frames
}

async function waitForDirectory(
  coordinator: RedisRelayCoordinator,
  routeId: RelayRouteId,
  attachmentId: RelayAttachmentId,
) {
  let found: Awaited<ReturnType<RedisRelayCoordinator['locate']>>
  await waitUntil(async () => {
    found = await coordinator.locate(routeId, attachmentId)
    return found !== undefined
  })
  if (found === undefined) throw new Error('Relay directory entry disappeared')
  return found
}

function withPhase<T>(phase: string, operation: Promise<T>, diagnostics: () => string = () => ''): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const detail = diagnostics()
      reject(new Error(`two-instance assembled phase timed out: ${phase}${detail === '' ? '' : ` (${detail})`}`))
    }, 10_000)
  })
  return Promise.race([operation, timeout]).finally(() => { clearTimeout(timer) })
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('two-instance assembled wait timed out')
    await new Promise<void>((resolve) => { setTimeout(resolve, 15) })
  }
}

function bytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

class AssembledRouteStore implements RelayRouteStore {
  private readonly rows = new Map<string, {
    revision: number
    revoked: boolean
    owners: Map<string, { endpoint: 'mobile' | 'desktop'; pairingSelector?: RelayPairingSelector }>
  }>()

  async rotate(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number> {
    const current = this.rows.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const owners = new Map(current?.owners ?? [])
    for (const [encoded, owner] of owners) if (owner.endpoint === endpoint) owners.delete(encoded)
    owners.set(Buffer.from(digest).toString('hex'), { endpoint })
    this.rows.set(routeId, { revision, revoked: false, owners })
    return revision
  }

  async issue(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    digest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number | undefined> {
    const current = this.rows.get(routeId)
    if (current === undefined || current.revoked) return undefined
    current.owners.set(Buffer.from(digest).toString('hex'), {
      endpoint, ...(pairingSelector === undefined ? {} : { pairingSelector }),
    })
    return current.revision
  }

  async registerPairing(
    routeId: RelayRouteId,
    pairingSelector: RelayPairingSelector,
    desktopDigest: Uint8Array,
    mobileDigest: Uint8Array,
  ): Promise<number> {
    const current = this.rows.get(routeId)
    const revision = current === undefined || current.revoked ? (current?.revision ?? 0) + 1 : current.revision
    const owners = current === undefined || current.revoked
      ? new Map<string, { endpoint: 'mobile' | 'desktop'; pairingSelector?: RelayPairingSelector }>()
      : new Map(current.owners)
    owners.set(Buffer.from(desktopDigest).toString('hex'), { endpoint: 'desktop', pairingSelector })
    owners.set(Buffer.from(mobileDigest).toString('hex'), { endpoint: 'mobile', pairingSelector })
    this.rows.set(routeId, { revision, revoked: false, owners })
    return revision
  }

  async authorize(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array) {
    const current = this.rows.get(routeId)
    const authority = current?.owners.get(Buffer.from(digest).toString('hex'))
    return current !== undefined && !current.revoked && authority?.endpoint === endpoint
      ? { revision: current.revision, ...(authority.pairingSelector === undefined
        ? {}
        : { pairingSelector: authority.pairingSelector }) }
      : undefined
  }

  async revokeCredential(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number> {
    const current = this.rows.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const owners = new Map(current?.owners ?? [])
    const encoded = Buffer.from(digest).toString('hex')
    if (owners.get(encoded)?.endpoint === endpoint) owners.delete(encoded)
    this.rows.set(routeId, { revision, revoked: current?.revoked ?? true, owners })
    return revision
  }

  async revoke(routeId: RelayRouteId): Promise<number> {
    const revision = (this.rows.get(routeId)?.revision ?? 0) + 1
    this.rows.set(routeId, { revision, revoked: true, owners: new Map() })
    return revision
  }
}

class AssembledRedisBus {
  readonly published: string[] = []
  private readonly values = new Map<string, { value: string; expiresAt?: number }>()
  private readonly sets = new Map<string, Set<string>>()
  private readonly subscriptions = new Map<string, Set<(message: string) => void>>()

  client(): RelayRedisClient {
    const client: RelayRedisClient = {
      get: async key => this.read(key),
      sMembers: async key => [...(this.sets.get(key) ?? [])],
      set: async (key, value, options) => {
        this.write(key, value, options.PX)
        return 'OK'
      },
      eval: async (script, options) => {
        const key = options.keys[0]
        if (key === undefined) return 0
        if (script.includes("redis.call('SET', KEYS[1], ARGV[1]")) {
          this.write(key, options.arguments[0] as string, Number(options.arguments[1]))
          const routeKey = options.keys[1] as string
          const members = this.sets.get(routeKey) ?? new Set()
          members.add(options.arguments[2] as string)
          this.sets.set(routeKey, members)
          return 1
        }
        const value = this.read(key)
        if (value === null) return 0
        const record = JSON.parse(value) as { connectionToken?: string }
        if (record.connectionToken !== options.arguments[0]) return 0
        if (script.includes("redis.call('SREM'")) {
          this.values.delete(key)
          this.sets.get(options.keys[1] as string)?.delete(options.arguments[1] as string)
        } else {
          const replacement = options.arguments[1] as string
          const ttl = options.arguments[2]
          this.write(key, replacement, ttl === undefined ? undefined : Number(ttl))
          const routeKey = options.keys[1] as string
          const members = this.sets.get(routeKey) ?? new Set()
          members.add(options.arguments[3] as string)
          this.sets.set(routeKey, members)
        }
        return 1
      },
      publish: async (channel, message) => {
        this.published.push(message)
        const listeners = [...(this.subscriptions.get(channel) ?? [])]
        for (const listener of listeners) listener(message)
        return listeners.length
      },
      subscribe: async (channel, listener) => {
        const listeners = this.subscriptions.get(channel) ?? new Set()
        listeners.add(listener)
        this.subscriptions.set(channel, listeners)
      },
      unsubscribe: async (channel, listener) => { this.subscriptions.get(channel)?.delete(listener) },
      withAbortSignal: () => client,
    }
    for (const name of FORBIDDEN_REDIS_APIS) {
      Object.defineProperty(client, name, {
        value: () => {
          throw new Error(`Relay Redis mock forbids ${name}`)
        },
      })
    }
    return client
  }

  assertNoRetainedCiphertextFrames(): void {
    for (const record of this.values.values()) {
      if (record.expiresAt !== undefined && Date.now() >= record.expiresAt) continue
      assertNotCiphertextStoreValue(record.value)
    }
  }

  private read(key: string): string | null {
    const record = this.values.get(key)
    if (record === undefined) return null
    if (record.expiresAt !== undefined && Date.now() >= record.expiresAt) {
      this.values.delete(key)
      return null
    }
    return record.value
  }

  private write(key: string, value: string, ttlMs?: number): void {
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) {
      throw new TypeError('Relay Redis mock PX must be a positive integer')
    }
    this.values.set(key, {
      value,
      ...(ttlMs === undefined ? {} : { expiresAt: Date.now() + ttlMs }),
    })
  }
}

function assertNotCiphertextStoreValue(value: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new Error('Relay Redis mock retained a non-JSON value')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Relay Redis mock retained a non-object value')
  const record = parsed as Record<string, unknown>
  if (record.type === 'ciphertext' || typeof record.frame === 'string') {
    throw new Error('Relay Redis mock retained a ciphertext frame')
  }
}
