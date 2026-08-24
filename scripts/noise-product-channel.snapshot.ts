/** Keyless runnable snapshot for the assembled endpoint-owned Snow product channel. */

import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parseRelayInstanceId,
  type PairingHandshakeProvider,
  type RelayCoordinationEvent,
  type RelayCoordinator,
  type RelayDirectoryEntry,
  type RelayRouteStore,
} from '@deepseek-ai/dsh-remote-access'
import { RemoteRelayProvider } from '@deepseek-ai/dsh-remote-access/relay-provider'
import { createDeferred } from '../packages/platform/remote-access/src/deferred.ts'
import { parseAccountProofJti, parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  beginSnowCompanionProtocol,
  SnowDesktopEndpointPairingOwner,
  SnowMobileHandshakeClient,
  acceptSnowDesktopReconnect,
  beginSnowMobileReconnect,
  initializeSnowChannel,
} from '@deepseek-ai/dsh-noise-channel'
import {
  deriveRelayCredentialDigest,
  deriveRelayCredentialPublicKey,
  generateRelayCredential,
  parseRelayAttachChallengeId,
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  type RelayPairingSelector,
  type RelayReadyMessage,
  type RelayRouteId,
  type RelayCredential,
  type RelayAttachmentId,
  signRelayAttachmentChallenge,
} from '@deepseek-ai/dsh-remote-protocol'

const expected = new URL('./snapshots/noise-product-channel/report.expected.json', import.meta.url)

async function attachmentProof(
  credential: RelayCredential,
  routeId: RelayRouteId,
  attachmentId: RelayAttachmentId,
  endpoint: 'mobile' | 'desktop',
) {
  return await signRelayAttachmentChallenge(credential, {
    type: 'attach-challenge-response', transportVersion: 1, routeId, attachmentId, endpoint,
    credentialPublicKey: await deriveRelayCredentialPublicKey(credential),
    challengeId: parseRelayAttachChallengeId(`challenge-${attachmentId}`),
    nonce: new Uint8Array(32).fill(5), expiresAt: Number.MAX_SAFE_INTEGER,
  })
}

describe('Snow product channel runnable snapshot', () => {
  it('executes endpoint mailbox pairing, sealed authority, real Relay attach, IK, and authenticated sync', async () => {
    initializeSnowChannel(readFileSync(new URL('../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url)))
    const fixtureIdentity = crypto.randomUUID()
    const desktopInstallation = `desktop-${fixtureIdentity}`
    const mobileInstallation = `mobile-${fixtureIdentity}`
    const mobileName = `Mobile ${fixtureIdentity}`
    const mobilePlatform = (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 2 === 0 ? 'ios' : 'android'
    const ctx = new Context()
    const routeStore = new SnapshotRouteStore()
    const coordinator = new SnapshotCoordinator()
    const relay = new RemoteRelayProvider(ctx, {
      instanceId: parseRelayInstanceId(`platform-${crypto.randomUUID()}`),
      routeStore,
      coordinator,
      config: {
        capacityRetryAfterMs: 100, deliveryAckTimeoutMs: 1_000, directoryTtlMs: 60_000,
        heartbeatTimeoutMs: 60_000, maxBufferedCiphertextBytes: 65_535,
        maxConnections: 8, maxPendingDeliveries: 8,
      },
      randomBytes: size => new Uint8Array(size).fill(17),
    })
    const pairing = new PersonalPairingProvider(ctx, {
      account: {
        currentInstallation: ({ accessToken }) => {
          const [kind, installation] = accessToken.split(':') as ['desktop' | 'mobile', string]
          return Promise.resolve({
            account: {
              id: parsePlatformAccountId('account-snapshot'), githubId: 1, githubLogin: 'snapshot',
              avatarUrl: 'https://avatars.example/snapshot',
            },
            installation: kind === 'mobile'
              ? {
                id: parseInstallationId(installation), kind,
                presentation: { name: mobileName, platform: mobilePlatform },
              }
              : { id: parseInstallationId(installation), kind: 'desktop' as const, presentation: { name: 'Test Desktop', platform: 'linux' as const } },
          })
        },
      },
      handshake: endpointOnlyHandshake(),
      relay,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomBytes: size => new Uint8Array(size).fill(29),
      randomId: kind => `${kind}-${crypto.randomUUID()}`,
      pairingLinkOrigin: 'https://platform.example/pair',
    })
    const desktopAuthentication = authentication('desktop', desktopInstallation)
    const mobileAuthentication = authentication('mobile', mobileInstallation)
    await pairing.setMobileAccess({ desktop: desktopAuthentication, enabled: true })

    const expiresAt = Date.now() + 60_000
    const route = await pairing.createEndpointChallenge({
      desktop: desktopAuthentication,
      rendezvousId: parsePairingRendezvousId(`rendezvous-${crypto.randomUUID()}`),
      clientIp: '192.0.2.1',
      expiresAt,
    })
    const desktop = new SnowDesktopEndpointPairingOwner()
    const invitation = await desktop.createInvitation(expiresAt)
    const mobile = new SnowMobileHandshakeClient()
    const message1 = await mobile.beginEndpointInvitation(invitation.invitationPayload)
    const completionId = parsePairingCompletionId(`completion-${crypto.randomUUID()}`)
    const pending = await pairing.submitEndpointMessage1({
      mobile: mobileAuthentication,
      challengeId: route.challengeId,
      completionId,
      message1,
    })
    const message2 = await desktop.acceptMessage1(message1)
    await pairing.submitEndpointMessage2({
      desktop: desktopAuthentication, pendingPairingId: pending.pendingPairingId, message2,
    })
    await mobile.acceptDesktopHandshake(message2)
    const message3 = mobile.exportFinishMessage()
    await pairing.submitEndpointMessage3({ mobile: mobileAuthentication, completionId, message3 })
    const authenticationHash = await desktop.finishMessage3(message3)

    const desktopCredential = await generateRelayCredential()
    const mobileCredential = await generateRelayCredential()
    const confirmation = await pairing.confirmEndpointPairing({
      desktop: desktopAuthentication,
      pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: await deriveRelayCredentialDigest(desktopCredential),
      mobileCredentialDigest: await deriveRelayCredentialDigest(mobileCredential),
    })
    const desktopGrant = {
      routeId: confirmation.routeId,
      endpoint: 'desktop' as const,
      credential: desktopCredential,
      revision: confirmation.relayRevision,
      pairingSelector: parseRelayPairingSelector(confirmation.pairing.id),
    }
    const mobileGrant = {
      routeId: confirmation.routeId,
      endpoint: 'mobile' as const,
      credential: mobileCredential,
      revision: confirmation.relayRevision,
      pairingSelector: parseRelayPairingSelector(confirmation.pairing.id),
    }
    const attachmentKey = new Uint8Array(32).fill(37)
    const sealed = await desktop.sealMobileRelayAuthority(mobileGrant, attachmentKey)
    await pairing.deliverEndpointRelayAuthority({
      desktop: desktopAuthentication,
      pendingPairingId: pending.pendingPairingId,
      sealedRelayAuthority: sealed,
    })
    const mobileStatus = await pairing.getEndpointPairingStatus({ mobile: mobileAuthentication, completionId })
    if (mobileStatus.stage !== 'confirmed') throw new Error('Snapshot Mobile authority was not confirmed')
    const openedGrant = await mobile.openRelayAuthority(mobileStatus.sealedRelayAuthority)
    const openedAttachmentKey = mobile.exportAttachmentKey()

    const mobileAttachmentId = parseRelayAttachmentId(`mobile-${crypto.randomUUID()}`)
    const desktopAttachmentId = parseRelayAttachmentId(`desktop-${crypto.randomUUID()}`)
    let livePeerUpdate = false
    const mobileAttachment = await relay.attach({
      message: await attachmentProof(openedGrant.credential, openedGrant.routeId, mobileAttachmentId, 'mobile'),
      deliver: (message) => { livePeerUpdate = message.type === 'peer-update'; return Promise.resolve() },
    })
    const desktopReady = createDeferred<RelayReadyMessage>()
    const desktopAttachment = await relay.attach({
      message: await attachmentProof(desktopGrant.credential, desktopGrant.routeId, desktopAttachmentId, 'desktop'),
      deliver: () => Promise.resolve(),
      announce: (message) => { desktopReady.resolve(message); return Promise.resolve() },
    })
    const ready = await desktopReady.promise
    if (ready.peers.length !== 1) {
      throw new Error('Snapshot Relay did not project the authenticated Mobile peer')
    }
    const generation = ready.peers[0]?.generation
    if (generation === undefined) throw new Error('Snapshot Relay generation is unavailable')
    const binding = {
      routeId: openedGrant.routeId,
      pairingSelector: openedGrant.pairingSelector as RelayPairingSelector,
      desktopAttachmentId,
      mobileAttachmentId,
      generation,
    }
    const first = await beginSnowMobileReconnect(mobile.exportReconnectState(), binding)
    const responder = await acceptSnowDesktopReconnect(desktop.exportReconnectState(), binding, first.message1)
    const mobileNegotiation = beginSnowCompanionProtocol(first.finish(responder.message2), 'mobile')
    const desktopNegotiation = beginSnowCompanionProtocol(responder.channel, 'desktop')
    const mobileChannel = mobileNegotiation.finish(desktopNegotiation.payload)
    const desktopChannel = desktopNegotiation.finish(mobileNegotiation.payload)
    const synchronization = {
      type: 'projection' as const,
      projection: { type: 'foreground-sync' as const, desktopName: 'Snapshot Desktop', generation, desktopRevision: 1 },
    }
    const decoded = mobileChannel.open(desktopChannel.seal(synchronization))
    const second = await beginSnowMobileReconnect(mobile.exportReconnectState(), { ...binding, generation: generation + 1 })
    let staleTranscriptRejected = false
    try {
      await acceptSnowDesktopReconnect(desktop.exportReconnectState(), { ...binding, generation: generation + 1 }, first.message1)
    } catch {
      staleTranscriptRejected = true
    }
    second.cancel()
    await desktopAttachment.close()
    await mobileAttachment.close()
    await pairing.dispose()
    await relay.dispose()

    const report = JSON.stringify({
      schemaVersion: 3,
      endpointMailboxXkpsk3: 'pass',
      platformInvitationHasNoPsk: !new URL(route.routingLink).searchParams.has('payload'),
      sealedRelayAuthority: !new TextDecoder().decode(sealed).includes(mobileCredential),
      platformWireHasNoAttachmentKey: [
        invitation.invitationPayload, message1, message2, message3, sealed,
      ].every(value => !contains(value, attachmentKey)),
      endpointAttachmentKey: equal(openedAttachmentKey, attachmentKey)
        && !equal(attachmentKey, authenticationHash),
      canonicalDigestRelayAttach: true,
      livePeerUpdate,
      ikFreshEphemerals: !equal(first.message1.slice(0, 32), second.message1.slice(0, 32)),
      authenticatedForegroundSync: decoded.type === 'projection'
        && decoded.projection.type === 'foreground-sync'
        && decoded.projection.generation === generation,
      staleTranscriptRejected,
    }, null, 2) + '\n'
    await expect(report).toMatchFileSnapshot(expected.pathname)
  })
})

function authentication(kind: 'desktop' | 'mobile', installation: string) {
  return {
    accessToken: `${kind}:${installation}`,
    proof: { jti: parseAccountProofJti(`${kind}-${installation}`), issuedAt: 1, signature: 'snapshot' },
  }
}


function endpointOnlyHandshake(): PairingHandshakeProvider {
  const unavailable = () => Promise.reject(new Error('Snapshot forbids Platform pairing cryptography'))
  return {
    createChallenge: unavailable,
    completeChallenge: unavailable,
    activatePairing: unavailable,
    destroyChallenge: () => {}, destroyPendingPairing: () => {}, destroyPairing: () => {},
  }
}

class SnapshotRouteStore implements RelayRouteStore {
  private readonly routes = new Map<string, {
    revision: number
    revoked: boolean
    authorities: Map<string, { endpoint: 'mobile' | 'desktop'; pairingSelector?: RelayPairingSelector }>
  }>()

  rotate(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number> {
    const revision = (this.routes.get(routeId)?.revision ?? 0) + 1
    this.routes.set(routeId, {
      revision, revoked: false,
      authorities: new Map([[hex(digest), { endpoint }]]),
    })
    return Promise.resolve(revision)
  }

  issue(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    digest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number | undefined> {
    const route = this.routes.get(routeId)
    if (route === undefined || route.revoked) return Promise.resolve(undefined)
    route.authorities.set(hex(digest), { endpoint, ...(pairingSelector === undefined ? {} : { pairingSelector }) })
    return Promise.resolve(route.revision)
  }

  registerPairing(
    routeId: RelayRouteId,
    pairingSelector: RelayPairingSelector,
    desktopDigest: Uint8Array,
    mobileDigest: Uint8Array,
  ): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = current === undefined || current.revoked ? (current?.revision ?? 0) + 1 : current.revision
    const authorities = current === undefined || current.revoked
      ? new Map<string, { endpoint: 'mobile' | 'desktop'; pairingSelector?: RelayPairingSelector }>()
      : new Map(current.authorities)
    authorities.set(hex(desktopDigest), { endpoint: 'desktop', pairingSelector })
    authorities.set(hex(mobileDigest), { endpoint: 'mobile', pairingSelector })
    this.routes.set(routeId, { revision, revoked: false, authorities })
    return Promise.resolve(revision)
  }

  authorize(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array) {
    const route = this.routes.get(routeId)
    const authority = route?.authorities.get(hex(digest))
    return Promise.resolve(route !== undefined && !route.revoked && authority?.endpoint === endpoint
      ? { revision: route.revision, ...(authority.pairingSelector === undefined
        ? {}
        : { pairingSelector: authority.pairingSelector }) }
      : undefined)
  }

  revokeCredential(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number> {
    const route = this.routes.get(routeId)
    if (route === undefined) return Promise.resolve(1)
    if (route.authorities.get(hex(digest))?.endpoint === endpoint) route.authorities.delete(hex(digest))
    route.revision += 1
    return Promise.resolve(route.revision)
  }

  revoke(routeId: RelayRouteId): Promise<number> {
    const route = this.routes.get(routeId)
    const revision = (route?.revision ?? 0) + 1
    this.routes.set(routeId, { revision, revoked: true, authorities: new Map() })
    return Promise.resolve(revision)
  }
}

class SnapshotCoordinator implements RelayCoordinator {
  private readonly entries = new Map<string, RelayDirectoryEntry>()
  private readonly listeners = new Map<string, (event: RelayCoordinationEvent) => Promise<void>>()

  listen(instanceId: string, listener: (event: RelayCoordinationEvent) => Promise<void>) {
    this.listeners.set(instanceId, listener)
    return Promise.resolve(() => { this.listeners.delete(instanceId); return Promise.resolve() })
  }

  register(entry: RelayDirectoryEntry): Promise<void> { this.entries.set(this.key(entry), { ...entry }); return Promise.resolve() }
  refresh(entry: RelayDirectoryEntry): Promise<boolean> {
    if (this.entries.get(this.key(entry))?.connectionToken !== entry.connectionToken) return Promise.resolve(false)
    this.entries.set(this.key(entry), { ...entry })
    return Promise.resolve(true)
  }
  unregister(entry: RelayDirectoryEntry): Promise<void> {
    if (this.entries.get(this.key(entry))?.connectionToken === entry.connectionToken) this.entries.delete(this.key(entry))
    return Promise.resolve()
  }
  locate(routeId: RelayRouteId, attachmentId: string): Promise<RelayDirectoryEntry | undefined> {
    return Promise.resolve(this.entries.get(`${routeId}:${attachmentId}`))
  }
  list(routeId: RelayRouteId): Promise<readonly RelayDirectoryEntry[]> {
    return Promise.resolve([...this.entries.values()].filter(entry => entry.routeId === routeId))
  }
  async publish(instanceId: string, event: Exclude<RelayCoordinationEvent, { type: 'invalidate' }>): Promise<boolean> {
    const listener = this.listeners.get(instanceId)
    if (listener === undefined) return false
    await listener(event)
    return true
  }
  async invalidate(event: Extract<RelayCoordinationEvent, { type: 'invalidate' }>): Promise<void> {
    await Promise.all([...this.listeners.values()].map(listener => listener(event)))
  }
  private key(entry: RelayDirectoryEntry): string { return `${entry.routeId}:${entry.attachmentId}` }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) return true
  }
  return false
}

function hex(value: Uint8Array): string { return Buffer.from(value).toString('hex') }
