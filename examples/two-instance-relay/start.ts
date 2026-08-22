import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  parseRelayInstanceId,
  type PairingHandshakeProvider,
  type RelayCoordinator,
  type RelayDirectoryEntry,
  type RelayRouteStore,
  type RemoteRelayConfig,
} from '@deepseek-ai/dsh-remote-access'
import { parseAccountProofJti, parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { RemoteRelayProvider } from '@deepseek-ai/dsh-remote-access/relay-provider'
import {
  RemoteRelayEndpointController,
} from '@deepseek-ai/dsh-remote-access-client'
import {
  DesktopRelayEndpointLifecycle,
} from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'
import { NodeRelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client/node-relay-socket'
import { RelayWebSocketConsumer } from '@deepseek-ai/dsh-remote-access-http/relay'
import { RedisRelayCoordinator, type RelayRedisClient } from '@deepseek-ai/dsh-remote-access-redis'
import {
  deriveRelayCredentialDigest,
  generateRelayCredential,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  REMOTE_PROTOCOL_LIMITS,
  type RelayAttachmentId,
  type RelayPairingSelector,
  type RelayPeerUpdateMessage,
  type RelayReadyMessage,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import z from '@deepseek-ai/schemastery'
import {
  initializeSnowChannel,
  SnowDesktopAttachmentOwner,
  SnowDesktopEndpointPairingOwner,
  SnowMobileAttachmentOwner,
  SnowMobileHandshakeClient,
  type SnowCompanionProtocolChannel,
} from '@deepseek-ai/dsh-noise-channel'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** Explicit deployment-like tunables for the Snow two-instance composition. */
export interface Config extends RemoteRelayConfig {
  attachTimeoutMs: number
  heartbeatIntervalMs: number
  inboundMaxBytes: number
  inboundMaxMessages: number
  maxPendingChallenges: number
  reconnectDelayMs: number
}

/** Validated scenario configuration; production supplies the same choices from deployment config. */
export const Config: z<Config> = z.object({
  attachTimeoutMs: z.natural().min(1).required(),
  capacityRetryAfterMs: z.natural().min(1).required(),
  deliveryAckTimeoutMs: z.natural().min(1).required(),
  directoryTtlMs: z.natural().min(1).required(),
  heartbeatIntervalMs: z.natural().min(1).required(),
  heartbeatTimeoutMs: z.natural().min(1).required(),
  inboundMaxBytes: z.natural().min(1).required(),
  inboundMaxMessages: z.natural().min(1).required(),
  maxPendingChallenges: z.natural().min(1).required(),
  maxBufferedCiphertextBytes: z.natural().min(1).required(),
  maxConnections: z.natural().min(1).required(),
  maxPendingDeliveries: z.natural().min(1).required(),
  reconnectDelayMs: z.natural().min(1).required(),
})

/** Cordis name for the Snow two-instance Relay acceptance composition. */
export const name = 'two-instance-relay-snow-scenario'

/** Run one encrypted round trip, instance replacement, and Desktop lifecycle shutdowns. */
export async function apply(_ctx: Context, config: Config): Promise<void> {
  validateBundledConfig(config)
  await withResources(async (resources) => {
    const bus = new InMemoryRedisBus()
    const routeStore = new ScenarioRouteStore()
    const pairingAuthority = new MemoryPersonalPairingAuthorityStore()
    const backendA = resources.add(await startBackend('platform-a', routeStore, bus, pairingAuthority, config, 11))
    const backendB = resources.add(await startBackend('platform-b', routeStore, bus, pairingAuthority, config, 29))
    const acquired: string[] = []
    const loadBalancer = resources.add(await startLoadBalancer([backendA, backendB], acquired))
    const connectEndpoint = async (signal: AbortSignal) => await NodeRelayEndpointSocket.connect(
      loadBalancer.url,
      signal,
      { maxBytes: config.inboundMaxBytes, maxMessages: config.inboundMaxMessages },
      { rejectUnauthorized: false },
    )
    initializeSnowChannel(await readFile(new URL('../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url)))
    let pairingId = 0
    const createPairingProvider = (relay: RemoteRelayProvider) => new PersonalPairingProvider(new Context(), {
      account: {
        currentInstallation: async ({ accessToken }) => {
          const [kind, id] = accessToken.split(':') as ['desktop' | 'mobile', string]
          return {
            account: {
              id: parsePlatformAccountId('account-snow'), githubId: 1, githubLogin: 'snow',
              avatarUrl: 'https://avatars.example/snow',
            },
            installation: kind === 'mobile'
              ? { id: parseInstallationId(id), kind, presentation: { name: `${id} installation`, platform: 'ios' } }
              : { id: parseInstallationId(id), kind },
          }
        },
      },
      handshake: endpointOnlyHandshake(),
      relay,
      authority: pairingAuthority,
      randomBytes: size => new Uint8Array(size).fill(41),
      randomId: kind => kind === 'relay-route' ? 'route-snow' : `${kind}-snow-${String(++pairingId)}`,
      pairingLinkOrigin: 'https://platform.example/pair',
    })
    const pairingA = createPairingProvider(backendA.provider)
    const pairingB = createPairingProvider(backendB.provider)
    resources.add({ close: async () => { await pairingA.dispose() } })
    resources.add({ close: async () => { await pairingB.dispose() } })
    const authentication = (kind: 'desktop' | 'mobile', id: string) => ({
      accessToken: `${kind}:${id}`,
      proof: { jti: parseAccountProofJti(`${kind}-${id}`), issuedAt: 1, signature: 'snow-scenario' },
    })
    const desktopAuthentication = authentication('desktop', 'desktop-snow')
    const mobileAuthentication = authentication('mobile', 'mobile-snow')
    await pairingA.setMobileAccess({ desktop: desktopAuthentication, enabled: true })
    const expiresAt = Date.now() + 60_000
    const challenge = await pairingA.createEndpointChallenge({
      desktop: desktopAuthentication,
      rendezvousId: 'rendezvous-snow' as never,
      clientIp: '127.0.0.1',
      expiresAt,
    })
    const desktopPairing = new SnowDesktopEndpointPairingOwner()
    const invitation = await desktopPairing.createInvitation(expiresAt)
    const mobilePairing = new SnowMobileHandshakeClient()
    const message1 = await mobilePairing.beginEndpointInvitation(invitation.invitationPayload)
    const completionId = 'completion-snow' as never
    const pending = await pairingA.submitEndpointMessage1({
      mobile: mobileAuthentication,
      challengeId: challenge.challengeId,
      completionId,
      message1,
    })
    const message2 = await desktopPairing.acceptMessage1(message1)
    await pairingA.submitEndpointMessage2({
      desktop: desktopAuthentication, pendingPairingId: pending.pendingPairingId, message2,
    })
    await mobilePairing.acceptDesktopHandshake(message2)
    const message3 = mobilePairing.exportFinishMessage()
    await pairingA.submitEndpointMessage3({ mobile: mobileAuthentication, completionId, message3 })
    await desktopPairing.finishMessage3(message3)
    const desktopCredential = await generateRelayCredential()
    const mobileCredential = await generateRelayCredential()
    const confirmation = await pairingA.confirmEndpointPairing({
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
    const sealedAuthority = await desktopPairing.sealMobileRelayAuthority({
      routeId: confirmation.routeId,
      endpoint: 'mobile',
      credential: mobileCredential,
      revision: confirmation.relayRevision,
      pairingSelector: parseRelayPairingSelector(confirmation.pairing.id),
    })
    await pairingA.deliverEndpointRelayAuthority({
      desktop: desktopAuthentication,
      pendingPairingId: pending.pendingPairingId,
      sealedRelayAuthority: sealedAuthority,
    })
    const mobileStatus = await pairingB.getEndpointPairingStatus({ mobile: mobileAuthentication, completionId })
    if (mobileStatus.stage !== 'confirmed') {
      throw new Error('Mobile product flow did not receive paired Relay authority')
    }
    const mobileGrant = await mobilePairing.openRelayAuthority(mobileStatus.sealedRelayAuthority)
    const routeId = desktopGrant.routeId
    await pairingA.dispose()
    const replacementAccess = await pairingB.getMobileAccessState(desktopAuthentication)
    const mobileAttachmentId = parseRelayAttachmentId(`mobile-${randomUUID()}`)
    let desktopAttachmentId = parseRelayAttachmentId(`desktop-${randomUUID()}`)
    let desktopProjection: RelayReadyMessage | RelayPeerUpdateMessage | undefined
    let desktopChannel: SnowCompanionProtocolChannel | undefined
    let mobileChannel: SnowCompanionProtocolChannel | undefined
    const synchronized = deferred<void>()
    const result = deferred<'accepted' | 'attachment-rejected'>()
    const mobileOwner = new SnowMobileAttachmentOwner(
      mobilePairing.exportReconnectState(),
      mobileGrant.pairingSelector as RelayPairingSelector,
    )
    const desktopOwner = new SnowDesktopAttachmentOwner(selector => selector === mobileGrant.pairingSelector
      ? desktopPairing.exportReconnectState()
      : undefined)
    const desktopLifecycle = new DesktopRelayEndpointLifecycle({
      attachmentId: () => {
        desktopAttachmentId = parseRelayAttachmentId(`desktop-${randomUUID()}`)
        return desktopAttachmentId
      },
      connect: connectEndpoint,
      attachTimeoutMs: config.attachTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectDelayMs: config.reconnectDelayMs,
      resynchronize: async () => {},
      onPeerAttachments: (update) => { desktopProjection = update },
      onCiphertext: async (ciphertext, sourceAttachmentId) => {
        if (desktopChannel === undefined) {
          const projection = desktopProjection
          if (projection === undefined) throw new Error('Desktop Snow IK has no Relay peer projection')
          const accepted = await desktopOwner.accept(
            ciphertext, sourceAttachmentId, projection.routeId, projection.attachmentId,
          )
          const peer = projection.peers.find(candidate => candidate.attachmentId === sourceAttachmentId)
          if (peer?.generation !== accepted.generation || peer.pairingSelector !== accepted.pairingSelector) {
            throw new Error('Desktop Snow IK did not match the live Relay projection')
          }
          desktopChannel = accepted.channel
          await desktopLifecycle.sendCiphertext(accepted.pairingSelector, accepted.targetAttachmentId, accepted.payload)
          await desktopLifecycle.sendCiphertext(accepted.pairingSelector, accepted.targetAttachmentId, accepted.channel.seal({
            type: 'projection',
            projection: { type: 'foreground-sync', generation: accepted.generation, desktopRevision: 1 },
          }))
          return
        }
        const message = desktopChannel.open(ciphertext)
        if (message.type !== 'operation') return
        const response = message.operation.type === 'query-operation-status'
          ? { type: 'status' as const, operationId: message.operation.operationId, absent: true as const }
          : {
            type: 'confirmed' as const, operationId: message.operation.operationId,
            committedAt: 1_787_027_200_000, outcome: 'accepted' as const,
          }
        await desktopLifecycle.sendCiphertext(desktopGrant.pairingSelector, sourceAttachmentId,
          desktopChannel.seal({ type: 'result', result: response }))
      },
      onConnectionLost: () => { desktopChannel?.dispose(); desktopChannel = undefined; desktopProjection = undefined },
    })
    const mobile = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: () => Promise.resolve(mobileGrant),
      attachmentId: () => mobileAttachmentId,
      connect: connectEndpoint,
      attachTimeoutMs: config.attachTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectDelayMs: config.reconnectDelayMs,
      onPeerAttachments: async (update) => {
        if (update.peers.length !== 1) return
        const begun = await mobileOwner.begin(update)
        await mobile.sendCiphertext(begun.targetAttachmentId, begun.payload)
      },
      onCiphertext: async (ciphertext, sourceAttachmentId) => {
        if (mobileChannel === undefined) {
          mobileChannel = mobileOwner.finish(ciphertext, sourceAttachmentId)
          return
        }
        const message = mobileChannel.open(ciphertext)
        if (message.type === 'result' && message.result.type === 'confirmed') result.resolve(message.result.outcome)
        if (message.type === 'projection' && message.projection.type === 'foreground-sync') {
          synchronized.resolve()
        }
      },
      onConnectionLost: () => { mobileOwner.cancel(); mobileChannel?.dispose(); mobileChannel = undefined },
    })
    resources.add({ close: async () => { await mobile.stop() } })
    resources.add({ close: async () => { await desktopLifecycle.stop('quit') } })

    await mobile.start()
    await waitForDirectory(backendA.coordinator, routeId, mobileAttachmentId)
    await desktopLifecycle.configure(desktopGrant)
    await desktopLifecycle.start()
    await waitForDirectory(backendA.coordinator, routeId, desktopAttachmentId)
    await synchronized.promise
    const endpoint = new URL(loadBalancer.url)
    const endpointCount = new Set([loadBalancer.url]).size
    console.log(`PLATFORM endpointProtocol=${endpoint.protocol} endpointPath=${endpoint.pathname} endpointCount=${String(endpointCount)} nonSticky=${String(acquired[0] !== acquired[1])} mobile=${acquired[0]} desktop=${acquired[1]} productAuthority=${String(replacementAccess.enabled)} distinctCredentials=${String(desktopGrant.credential !== mobileGrant.credential)}`)
    console.log(`PAIRING endpointMailbox=true platformPsk=${String(new URL(challenge.routingLink).searchParams.has('payload'))} sealedAuthority=${String(!new TextDecoder().decode(sealedAuthority).includes(mobileGrant.credential))} ik=true`)

    const prompt = 'continue from Mobile across instances'
    if (mobileChannel === undefined) throw new Error('Mobile Snow channel did not authenticate')
    await mobile.sendCiphertext(desktopAttachmentId, mobileChannel.seal({
      type: 'operation',
      operation: {
        type: 'submit-prompt', operationId: parseCompanionOperationId('operation-snow'),
        sessionId: parseCompanionSessionId('session-snow'), text: prompt,
      },
    }))
    const outcome = await result.promise
    const relayBusinessValue = bus.published.some(value => value.includes(prompt))
    const encrypted = !relayBusinessValue
    console.log(`ROUND_TRIP encrypted=${String(encrypted)} relayBusinessValue=${String(relayBusinessValue)} outcome=${outcome}`)
    const onlinePairing = (await pairingB.listPersonalPairings(desktopAuthentication))[0]
    if (onlinePairing === undefined) throw new Error('Desktop Settings did not project the active Mobile pairing')
    console.log(`PAIRING_ACTIVITY online=${String(onlinePairing.online)} lastAccessCurrent=${String(onlinePairing.lastAccessAt >= onlinePairing.pairedAt)}`)

    await withPhaseTimeout('Desktop lifecycle stop', desktopLifecycle.stop('quit'))
    await waitUntil(async () => await backendA.coordinator.locate(routeId, desktopAttachmentId) === undefined)
    console.log(`LIFECYCLE observed=quit offline=${String(await backendA.coordinator.locate(routeId, desktopAttachmentId) === undefined)} retainedCiphertextValues=${String(bus.retainedCiphertextValueCount())}`)
    const beforeDisconnect = (await pairingB.listPersonalPairings(desktopAuthentication))[0]
    if (beforeDisconnect === undefined) throw new Error('Desktop Settings lost Mobile activity before disconnect')
    await mobile.stop()
    await waitUntil(async () => await backendA.coordinator.locate(routeId, mobileAttachmentId) === undefined)
    const offlinePairing = (await pairingB.listPersonalPairings(desktopAuthentication))[0]
    if (offlinePairing === undefined) throw new Error('Desktop Settings lost the disconnected Mobile pairing')
    console.log(`PAIRING_DISCONNECT online=${String(offlinePairing.online)} lastAccessPreserved=${String(offlinePairing.lastAccessAt === beforeDisconnect.lastAccessAt)}`)
    const pairingReplacement = createPairingProvider(backendA.provider)
    resources.add({ close: async () => { await pairingReplacement.dispose() } })
    await pairingReplacement.setMobileAccess({ desktop: desktopAuthentication, enabled: false })
    await waitUntil(async () => await backendA.coordinator.locate(routeId, mobileAttachmentId) === undefined)
    const routeOffline = await backendA.coordinator.locate(routeId, mobileAttachmentId) === undefined
    console.log(`AUTHORITY disableInstance=platform-replacement routeOffline=${String(routeOffline)}`)
  })
}

interface Backend {
  id: string
  provider: RemoteRelayProvider
  coordinator: RedisRelayCoordinator
  consumer: RelayWebSocketConsumer
  available(): boolean
  close(): Promise<void>
}

async function startBackend(
  id: string,
  routeStore: RelayRouteStore,
  bus: InMemoryRedisBus,
  pairingActivity: MemoryPersonalPairingAuthorityStore,
  config: Config,
  randomByte: number,
): Promise<Backend> {
  const ctx = new Context()
  const coordinator = new RedisRelayCoordinator({
    command: bus.client(), subscriber: bus.client(), keyPrefix: 'dsh:development:relay',
  })
  let entropyAllocation = 0
  const provider = new RemoteRelayProvider(ctx, {
    instanceId: parseRelayInstanceId(id), routeStore, coordinator, pairingActivity,
    config: {
      capacityRetryAfterMs: config.capacityRetryAfterMs,
      deliveryAckTimeoutMs: config.deliveryAckTimeoutMs,
      directoryTtlMs: config.directoryTtlMs,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
      maxBufferedCiphertextBytes: config.maxBufferedCiphertextBytes,
      maxConnections: config.maxConnections,
      maxPendingDeliveries: config.maxPendingDeliveries,
    },
    randomBytes: (size) => {
      entropyAllocation += 1
      return new Uint8Array(size).fill((randomByte + entropyAllocation) % 256)
    },
  })
  const consumer = new RelayWebSocketConsumer(ctx, config.attachTimeoutMs, config.maxPendingChallenges)
  let open = true
  return {
    id, provider, coordinator, consumer,
    available: () => open,
    close: async () => {
      if (!open) return
      open = false
      const results = await Promise.allSettled([consumer.close(), provider.dispose()])
      throwRejected(results, `Relay backend ${id} failed to close`)
    },
  }
}

async function startLoadBalancer(backends: Backend[], acquired: string[]): Promise<{ url: string; close(): Promise<void> }> {
  const [key, cert] = await Promise.all([
    readFile(`${FIXTURES}localhost-key.pem`),
    readFile(`${FIXTURES}localhost-cert.pem`),
  ])
  const server = createServer({ key, cert }, (_request, response) => { response.writeHead(404); response.end() })
  let acquisition = 0
  server.on('upgrade', (request, socket, head) => {
    const live = backends.filter(backend => backend.available())
    const backend = live[acquisition++ % live.length]
    if (backend === undefined) { socket.destroy(); return }
    acquired.push(backend.id)
    backend.consumer.handleUpgrade(request, socket, head)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) {
    await closeServer(server).catch(() => {})
    throw error
  }
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Relay TLS load balancer did not bind a TCP port')
  }
  let open = true
  return {
    url: `wss://127.0.0.1:${String(address.port)}/v1/remote-access/relay`,
    close: async () => {
      if (!open) return
      open = false
      await closeServer(server)
    },
  }
}

class ScenarioRouteStore implements RelayRouteStore {
  private readonly routes = new Map<string, {
    authorities: Map<string, { endpoint: 'mobile' | 'desktop'; pairingSelector?: RelayPairingSelector }>
    revision: number
    revoked: boolean
  }>()
  async rotate(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number> {
    const revision = (this.routes.get(routeId)?.revision ?? 0) + 1
    const authorities = new Map(this.routes.get(routeId)?.authorities ?? [])
    for (const [value, owner] of authorities) if (owner.endpoint === endpoint) authorities.delete(value)
    authorities.set(Buffer.from(digest).toString('hex'), { endpoint })
    this.routes.set(routeId, { authorities, revision, revoked: false })
    return revision
  }
  async issue(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    digest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number | undefined> {
    const route = this.routes.get(routeId)
    if (route === undefined || route.revoked) return undefined
    route.authorities.set(Buffer.from(digest).toString('hex'), {
      endpoint, ...(pairingSelector === undefined ? {} : { pairingSelector }),
    })
    return route.revision
  }
  async registerPairing(
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
    authorities.set(Buffer.from(desktopDigest).toString('hex'), { endpoint: 'desktop', pairingSelector })
    authorities.set(Buffer.from(mobileDigest).toString('hex'), { endpoint: 'mobile', pairingSelector })
    this.routes.set(routeId, { authorities, revision, revoked: false })
    return revision
  }
  async authorize(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array) {
    const route = this.routes.get(routeId)
    const authority = route?.authorities.get(Buffer.from(digest).toString('hex'))
    return route !== undefined && !route.revoked && authority?.endpoint === endpoint
      ? { revision: route.revision, ...(authority.pairingSelector === undefined
        ? {}
        : { pairingSelector: authority.pairingSelector }) }
      : undefined
  }
  async revokeCredential(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    digest: Uint8Array,
  ): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const authorities = new Map(current?.authorities ?? [])
    const encoded = Buffer.from(digest).toString('hex')
    if (authorities.get(encoded)?.endpoint === endpoint) authorities.delete(encoded)
    this.routes.set(routeId, { authorities, revision, revoked: current?.revoked ?? true })
    return revision
  }
  async revoke(routeId: RelayRouteId): Promise<number> {
    const revision = (this.routes.get(routeId)?.revision ?? 0) + 1
    this.routes.set(routeId, { authorities: new Map(), revision, revoked: true })
    return revision
  }
}

class InMemoryRedisBus {
  readonly published: string[] = []
  private readonly values = new Map<string, string>()
  private readonly sets = new Map<string, Set<string>>()
  private readonly subscriptions = new Map<string, Set<(message: string) => void>>()
  client(): RelayRedisClient {
    const client: RelayRedisClient = {
      get: async key => this.values.get(key) ?? null,
      sMembers: async key => [...(this.sets.get(key) ?? [])],
      set: async (key, value) => { this.values.set(key, value); return 'OK' },
      eval: async (_script, options) => {
        const key = options.keys[0]
        if (key === undefined) return 0
        const routeKey = options.keys[1]
        if (options.arguments.length === 3 && routeKey !== undefined) {
          this.values.set(key, options.arguments[0] as string)
          const members = this.sets.get(routeKey) ?? new Set<string>()
          members.add(options.arguments[2] as string)
          this.sets.set(routeKey, members)
          return 1
        }
        const value = this.values.get(key)
        if (value === undefined) return 0
        const record = JSON.parse(value) as { connectionToken?: string }
        if (record.connectionToken !== options.arguments[0]) return 0
        const replacement = options.arguments[1]
        if (options.arguments.length === 2) {
          this.values.delete(key)
          if (routeKey !== undefined) this.sets.get(routeKey)?.delete(options.arguments[1] as string)
        } else if (replacement !== undefined) {
          this.values.set(key, replacement)
          if (routeKey !== undefined) {
            const members = this.sets.get(routeKey) ?? new Set<string>()
            members.add(options.arguments[3] as string)
            this.sets.set(routeKey, members)
          }
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
    return client
  }
  retainedCiphertextValueCount(): number {
    return [...this.values.values()].filter(value => value.includes('ciphertext')).length
  }
}

/** Staged owner that aggregates partial-acquisition and cleanup failures. */
export class ScenarioResourceOwner {
  private readonly resources: Array<{ close(): Promise<void> }> = []
  /** @param resource - successfully acquired resource transferred to this owner. @returns the same resource. */
  add<T extends { close(): Promise<void> }>(resource: T): T { this.resources.push(resource); return resource }
  /** Close every acquired resource in reverse acquisition order. */
  async close(): Promise<void> {
    const results = await Promise.allSettled(this.resources.splice(0).reverse().map(async (resource) => { await resource.close() }))
    throwRejected(results, 'Two-instance Relay resource cleanup failed')
  }
}

/** Run staged acquisition and aggregate the work failure with every cleanup failure. */
export async function withResources(work: (owner: ScenarioResourceOwner) => Promise<void>): Promise<void> {
  const owner = new ScenarioResourceOwner()
  const workResult = await Promise.allSettled([work(owner)])
  const cleanupResult = await Promise.allSettled([owner.close()])
  throwRejected([...workResult, ...cleanupResult], 'Two-instance Relay scenario failed')
}

/** Validate cross-field timing and queue relationships before resource acquisition. */
export function validateBundledConfig(config: Config): void {
  if (config.heartbeatIntervalMs >= Math.min(config.directoryTtlMs, config.heartbeatTimeoutMs)) {
    throw new TypeError('Relay heartbeatIntervalMs must be less than directoryTtlMs and heartbeatTimeoutMs')
  }
  if (config.inboundMaxBytes < REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('Relay inboundMaxBytes must admit one maximum Relay message')
  }
}

function endpointOnlyHandshake(): PairingHandshakeProvider {
  const unavailable = () => Promise.reject(new Error('Two-instance scenario forbids Platform pairing cryptography'))
  return {
    createChallenge: unavailable,
    completeChallenge: unavailable,
    activatePairing: unavailable,
    destroyChallenge: () => {}, destroyPendingPairing: () => {}, destroyPairing: () => {},
  }
}

async function waitForDirectory(
  coordinator: RelayCoordinator,
  routeId: RelayRouteId,
  attachmentId: RelayAttachmentId,
): Promise<RelayDirectoryEntry> {
  let found: RelayDirectoryEntry | undefined
  await waitUntil(async () => { found = await coordinator.locate(routeId, attachmentId); return found !== undefined })
  if (found === undefined) throw new Error('Relay directory entry disappeared')
  return found
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Relay Snow scenario timed out')
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

/**
 * Bound one scenario phase so a CI-only stall fails with the phase name instead of a global timeout.
 * @param phase - human-readable scenario phase for the diagnostic message.
 * @param operation - scenario step to bound.
 * @returns the settled operation result.
 */
function withPhaseTimeout<T>(phase: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`two-instance relay phase timed out: ${phase}`)) }, 10_000)
  })
  return Promise.race([operation, timeout]).finally(() => { clearTimeout(timer) })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

function throwRejected(results: PromiseSettledResult<unknown>[], message: string): void {
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length === 1) throw errorFromUnknown(errors[0])
  if (errors.length > 1) throw new AggregateError(errors, message)
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}
