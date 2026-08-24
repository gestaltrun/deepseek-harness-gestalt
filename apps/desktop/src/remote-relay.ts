/** Desktop Host composition for the endpoint-owned Snow Remote Relay endpoint. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { SelectedPlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import {
  parseRelayAttachmentId,
  REMOTE_PROTOCOL_LIMITS,
  type RelayAttachmentId,
  type RelayPairingSelector,
  type RelayPeerDescriptor,
  type RelayPeerUpdateMessage,
  type RelayReadyMessage,
  type RelayRouteId,
  type CompanionOperation,
  type CompanionMessage,
  type CompanionProjection,
  type CompanionResult,
} from '@deepseek-ai/dsh-remote-protocol'
import type { RelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client'
import {
  DesktopRelayEndpointLifecycle,
  FailClosedDesktopRelayLifecycle,
  type DesktopRelayLifecycle,
} from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'
import { NodeRelayEndpointSocket } from '@deepseek-ai/dsh-remote-access-client/node-relay-socket'
import {
  initializeSnowChannel,
  SnowDesktopAttachmentOwner,
  type SnowCompanionProtocolChannel,
} from '@deepseek-ai/dsh-noise-channel'
import { sealDesktopForegroundSynchronization } from './noise-companion.ts'
import type { DesktopSnowPairingVault } from './snow-pairing-vault.ts'
import type {
  DesktopCompanionLiveProjectionChange,
} from './companion-live-projection.ts'
import type { DesktopCompanionLiveProjectionPayload } from './companion-product.ts'

const CRYPTO_GATE = 'Personal Pairing requires an independently reviewed handshake and Relay crypto provider.'
const SURFACE_CHANGE_KEY = '\0surface'
/** Validated Desktop endpoint deployment inputs. */
export interface DesktopRemoteRelayConfig {
  url: string
  attachTimeoutMs: number
  heartbeatIntervalMs: number
  reconnectDelayMs: number
  inboundMaxBytes: number
  inboundMaxMessages: number
}

/** Product composition dependencies for a Desktop Relay lifecycle. */
export interface DesktopRemoteRelayOptions {
  environment: SelectedPlatformEnvironment
  source: NodeJS.ProcessEnv | Record<string, string | undefined>
  connect?: (signal: AbortSignal, config: DesktopRemoteRelayConfig) => Promise<RelayEndpointSocket>
  snowPairingVault: DesktopSnowPairingVault
  initializeWasm?: () => void
  /** Read the Platform-authenticated Desktop Installation name for each fresh synchronization. */
  desktopName(): string | undefined
  /** Execute one application operation after Snow authentication. */
  handleOperation: DesktopCompanionOperationHandler
  /** Bind authenticated Snow connections to current Host projection. */
  liveProjection?: Omit<DesktopCompanionLiveProjectionAdapter, 'reconnect'>
}

interface DesktopSnowAcceptOwner {
  accept(
    ciphertext: Uint8Array,
    sourceAttachmentId: RelayAttachmentId,
    routeId: RelayRouteId,
    localAttachmentId: RelayAttachmentId,
  ): ReturnType<SnowDesktopAttachmentOwner['accept']>
}

type DesktopRelaySender = (
  pairingSelector: RelayPairingSelector,
  targetAttachmentId: RelayAttachmentId,
  ciphertext: Uint8Array,
) => Promise<void>

/** Pairing-scoped application operation admitted only after Snow authentication. */
export type DesktopCompanionOperationHandler = (
  operation: CompanionOperation,
  pairingSelector: RelayPairingSelector,
  context: { generation: number; desktopRevision: number },
) => Promise<CompanionResult | CompanionProjection | readonly CompanionResult[]>

/** Endpoint adapter joining authenticated Snow connections to Host live projection. */
export interface DesktopCompanionLiveProjectionAdapter {
  /** Register one current encrypted connection and return its disposer. */
  connect(
    pairingSelector: RelayPairingSelector,
    changed: (change: DesktopCompanionLiveProjectionChange) => void,
    disconnect: (error: Error) => void,
  ): () => void
  /** Build one current Host replacement without assigning wire generation or revision. */
  project(
    change: DesktopCompanionLiveProjectionChange,
    pairingSelector: RelayPairingSelector,
    signal: AbortSignal,
  ): Promise<DesktopCompanionLiveProjectionPayload>
  /** Revalidate detailed transcript ownership immediately before publication. */
  retainsConversation(
    change: DesktopCompanionLiveProjectionChange,
    pairingSelector: RelayPairingSelector,
  ): boolean
  /** Force a fresh physical attachment after projection loss or bounded-queue overflow. */
  reconnect(pairingSelector: RelayPairingSelector, error: Error): void
}

interface DesktopSnowProjection {
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  peers: readonly RelayPeerDescriptor[]
  cancellation: AbortController
}

interface DesktopSnowActiveChannel {
  readonly channel: SnowCompanionProtocolChannel
  readonly peer: RelayPeerDescriptor
  readonly cancellation: AbortController
  readonly pendingLive: Map<string, DesktopCompanionLiveProjectionChange>
  outbound: Promise<void>
  livePump?: Promise<void>
  liveDisposer?: () => void
  retired: boolean
}

interface DesktopSnowPendingProtocol {
  readonly projection: DesktopSnowProjection
  readonly peer: RelayPeerDescriptor
  readonly finish: (payload: Uint8Array) => SnowCompanionProtocolChannel
  readonly cancel: () => void
}

/** Attachment-generation owner that rejects late Snow accept results before channel publication. */
export class DesktopSnowRelayChannelOwner {
  private readonly channels = new Map<RelayAttachmentId, DesktopSnowActiveChannel>()
  private readonly pendingProtocols = new Map<RelayAttachmentId, DesktopSnowPendingProtocol>()
  private readonly projections = new Map<RelayPairingSelector, DesktopSnowProjection>()
  private readonly tasks = new Set<Promise<void>>()
  private desktopRevision = 0

  /** @param owner - Desktop Snow IK responder. @param send - current Relay attachment sender. */
  constructor(
    private readonly owner: DesktopSnowAcceptOwner,
    private readonly send: DesktopRelaySender,
    private readonly handleOperation: DesktopCompanionOperationHandler | undefined,
    private readonly desktopName: () => string | undefined,
    private readonly liveProjection?: DesktopCompanionLiveProjectionAdapter,
  ) {}

  /** @param update - current route-bound peer projection. @param selector - owned pairing selector. */
  updatePeers(update: RelayReadyMessage | RelayPeerUpdateMessage, selector: RelayPairingSelector): void {
    this.invalidate(selector)
    this.projections.set(selector, {
      routeId: update.routeId,
      attachmentId: update.attachmentId,
      peers: update.peers,
      cancellation: new AbortController(),
    })
  }

  /** @param selector - pairing whose attachment generation is no longer current. */
  invalidate(selector: RelayPairingSelector): void {
    this.projections.get(selector)?.cancellation.abort()
    this.projections.delete(selector)
    for (const [attachmentId, pending] of this.pendingProtocols) {
      if (pending.peer.pairingSelector !== selector) continue
      pending.cancel()
      this.pendingProtocols.delete(attachmentId)
    }
    for (const [attachmentId, active] of this.channels) {
      if (active.peer.pairingSelector !== selector) continue
      active.retired = true
      active.cancellation.abort()
      active.pendingLive.clear()
      active.liveDisposer?.()
      active.channel.dispose()
      this.channels.delete(attachmentId)
    }
  }

  /** @param attachmentId - lost local attachment invalidating its pairing projection. */
  connectionLost(attachmentId: RelayAttachmentId): void {
    for (const [selector, projection] of this.projections) {
      if (projection.attachmentId === attachmentId) this.invalidate(selector)
    }
  }

  /**
   * Open one current-generation encrypted frame or authenticate a fresh IK attachment.
   * @param ciphertext - Relay-routed Snow ciphertext.
   * @param sourceAttachmentId - Relay-authenticated peer attachment.
   * @param localAttachmentId - current Desktop attachment.
   * @param pairingSelector - pairing selected by the Relay projection.
   * @param lifecycleSignal - physical controller lifetime.
   */
  async receive(
    ciphertext: Uint8Array,
    sourceAttachmentId: RelayAttachmentId,
    localAttachmentId: RelayAttachmentId,
    pairingSelector: RelayPairingSelector,
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    const current = this.projections.get(pairingSelector)
    if (current === undefined) throw new Error('Desktop Relay ciphertext has no peer projection')
    if (current.attachmentId !== localAttachmentId) throw new Error('Desktop Relay ciphertext has a stale local attachment')
    const projected = current.peers.find(peer => peer.attachmentId === sourceAttachmentId)
    const existing = this.channels.get(sourceAttachmentId)
    if (existing !== undefined) {
      if (projected === undefined || projected.generation !== existing.peer.generation
        || projected.pairingSelector !== existing.peer.pairingSelector) {
        throw new Error('Desktop Relay rejected a stale Snow channel')
      }
      const message = existing.channel.open(ciphertext)
      if (message.type === 'operation') {
        if (this.handleOperation === undefined) {
          throw new Error('Desktop Companion operation handler is unavailable')
        }
        const output = await this.handleOperation(message.operation, pairingSelector, {
          generation: existing.peer.generation,
          desktopRevision: this.desktopRevision,
        })
        if (!this.isCurrent(current, pairingSelector, projected)) {
          throw new Error('Desktop Relay rejected a stale Companion operation result')
        }
        const outputs = isCompanionResultList(output) ? output : [output]
        for (const item of outputs) {
          if (!this.isCurrent(current, pairingSelector, projected)) {
            throw new Error('Desktop Relay rejected a stale Companion operation result')
          }
          await this.sendOutput(existing, item)
        }
      }
      return
    }
    const pending = this.pendingProtocols.get(sourceAttachmentId)
    if (pending !== undefined) {
      if (projected === undefined || pending.projection !== current
        || projected.generation !== pending.peer.generation
        || projected.pairingSelector !== pending.peer.pairingSelector) {
        this.pendingProtocols.delete(sourceAttachmentId)
        pending.cancel()
        throw new Error('Desktop Relay rejected a stale Companion negotiation')
      }
      this.pendingProtocols.delete(sourceAttachmentId)
      const channel = pending.finish(ciphertext)
      await this.publishActive(channel, current, projected, pairingSelector, sourceAttachmentId)
      return
    }
    if (projected === undefined) throw new Error('Desktop Relay rejected an unprojected Snow peer')
    const acceptedPromise = this.owner.accept(ciphertext, sourceAttachmentId, current.routeId, current.attachmentId)
    const accepted = await abortableAccept(acceptedPromise, [current.cancellation.signal, lifecycleSignal])
    let retained = false
    try {
      if (!this.isCurrent(current, pairingSelector, projected)
        || accepted.generation !== projected.generation
        || accepted.pairingSelector !== projected.pairingSelector) {
        throw new Error('Desktop Relay rejected a stale Snow IK transcript')
      }
      await this.send(accepted.pairingSelector, accepted.targetAttachmentId, accepted.payload)
      if (!this.isCurrent(current, pairingSelector, projected)) {
        throw new Error('Desktop Relay rejected a stale Snow IK transcript')
      }
      this.pendingProtocols.set(sourceAttachmentId, {
        projection: current,
        peer: projected,
        finish: accepted.negotiation.finish,
        cancel: accepted.negotiation.cancel,
      })
      retained = true
    } finally {
      if (!retained) accepted.negotiation.cancel()
    }
  }

  private async publishActive(
    channel: SnowCompanionProtocolChannel,
    current: DesktopSnowProjection,
    projected: RelayPeerDescriptor,
    pairingSelector: RelayPairingSelector,
    sourceAttachmentId: RelayAttachmentId,
  ): Promise<void> {
    let published = false
    try {
      if (!this.isCurrent(current, pairingSelector, projected)) {
        throw new Error('Desktop Relay rejected a stale Companion negotiation')
      }
      const nextRevision = this.allocateDesktopRevision()
      const desktopName = this.desktopName()
      if (desktopName === undefined) throw new Error('Desktop Relay has no authenticated Installation presentation')
      const synchronization = sealDesktopForegroundSynchronization(
        channel, projected.generation, nextRevision, desktopName,
      )
      await this.send(pairingSelector, sourceAttachmentId, synchronization)
      if (!this.isCurrent(current, pairingSelector, projected)) {
        throw new Error('Desktop Relay rejected a stale Companion negotiation')
      }
      const active: DesktopSnowActiveChannel = {
        channel,
        peer: projected,
        cancellation: new AbortController(),
        pendingLive: new Map(),
        outbound: Promise.resolve(),
        retired: false,
      }
      this.channels.set(sourceAttachmentId, active)
      if (this.liveProjection !== undefined && channel.applicationMajor >= 4) {
        try {
          active.liveDisposer = this.liveProjection.connect(
            pairingSelector,
            (change) => { this.queueLive(active, change) },
            (error) => { this.failActive(active, error) },
          )
        } catch (error) {
          this.channels.delete(sourceAttachmentId)
          active.retired = true
          active.cancellation.abort()
          throw error
        }
      }
      published = true
    } finally {
      if (!published) channel.dispose()
    }
  }

  /** Wait until every active or retiring live projection pump reaches quiescence. */
  async drain(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks])
  }

  private queueLive(active: DesktopSnowActiveChannel, change: DesktopCompanionLiveProjectionChange): void {
    if (active.retired || this.channels.get(active.peer.attachmentId) !== active) return
    const key = change.type === 'surface' ? SURFACE_CHANGE_KEY : change.sessionId
    if (change.type === 'surface') active.pendingLive.clear()
    active.pendingLive.set(key, change)
    if (active.pendingLive.size > REMOTE_PROTOCOL_LIMITS.liveProjectionPendingSessions) {
      this.failActive(active, new Error('Companion live projection consumer exceeded its pending Session ceiling'))
      return
    }
    if (active.livePump !== undefined) return
    const pump = this.pumpLive(active)
    active.livePump = pump
    this.tasks.add(pump)
    void pump.then(
      () => { if (active.livePump === pump) active.livePump = undefined },
      (error: unknown) => {
        if (active.livePump === pump) active.livePump = undefined
        this.failActive(active, error instanceof Error ? error : new Error('Companion live projection failed', { cause: error }))
      },
    ).finally(() => { this.tasks.delete(pump) })
  }

  private async pumpLive(active: DesktopSnowActiveChannel): Promise<void> {
    const adapter = this.liveProjection
    if (adapter === undefined) return
    while (!active.retired && !active.cancellation.signal.aborted) {
      const next = active.pendingLive.entries().next()
      if (next.done) return
      const [key, change] = next.value
      active.pendingLive.delete(key)
      if (change.type === 'surface') {
        const desktopName = this.desktopName()
        if (desktopName === undefined) throw new Error('Desktop Relay has no authenticated Installation presentation')
        await this.enqueueOutbound(active, () => ({
          type: 'projection',
          projection: {
            type: 'foreground-sync', desktopName, generation: active.peer.generation,
            desktopRevision: this.allocateDesktopRevision(),
          },
        }))
        continue
      }
      const payload = await adapter.project(change, active.peer.pairingSelector, active.cancellation.signal)
      if (!this.isActive(active)) return
      const projected = retainObservedConversation(payload, adapter.retainsConversation(change, active.peer.pairingSelector))
      await this.enqueueOutbound(active, () => ({
        type: 'projection',
        projection: boundLiveSessionProjection(active.channel, {
          type: 'session-live', generation: active.peer.generation,
          desktopRevision: this.allocateDesktopRevision(),
          ...retainObservedConversation(
            projected,
            adapter.retainsConversation(change, active.peer.pairingSelector),
          ),
        }),
      }))
    }
  }

  private async sendOutput(
    active: DesktopSnowActiveChannel,
    item: CompanionResult | CompanionProjection,
  ): Promise<void> {
    await this.enqueueOutbound(active, () => isCompanionProjection(item)
      ? { type: 'projection', projection: this.currentProjection(item, active.peer.generation) }
      : { type: 'result', result: item })
  }

  private enqueueOutbound(
    active: DesktopSnowActiveChannel,
    message: () => Parameters<SnowCompanionProtocolChannel['seal']>[0],
  ): Promise<void> {
    const result = active.outbound.then(async () => {
      if (!this.isActive(active)) {
        throw new Error('Desktop Relay rejected a stale Companion output')
      }
      const ciphertext = active.channel.seal(message())
      await this.send(active.peer.pairingSelector, active.peer.attachmentId, ciphertext)
      if (!this.isActive(active)) {
        throw new Error('Desktop Relay rejected a stale Companion output')
      }
    })
    this.tasks.add(result)
    void result.finally(() => { this.tasks.delete(result) }).catch(() => {})
    active.outbound = result.then(() => undefined, () => undefined)
    return result
  }

  private currentProjection(projection: CompanionProjection, generation: number): CompanionProjection {
    if (projection.type === 'surface-snapshot' || projection.type === 'conversation-snapshot'
      || projection.type === 'session-live') {
      return { ...projection, generation, desktopRevision: this.allocateDesktopRevision() }
    }
    return projection
  }

  private allocateDesktopRevision(): number {
    this.desktopRevision += 1
    return this.desktopRevision
  }

  private failActive(active: DesktopSnowActiveChannel, error: Error): void {
    if (active.retired) return
    const selector = active.peer.pairingSelector
    this.invalidate(selector)
    try { this.liveProjection?.reconnect(selector, error) } catch (failure) {
      console.error('[desktop-companion] live projection reconnect failed:', failure)
    }
  }

  private isActive(active: DesktopSnowActiveChannel): boolean {
    return !active.retired && !active.cancellation.signal.aborted
      && this.channels.get(active.peer.attachmentId) === active
  }

  private isCurrent(
    projection: DesktopSnowProjection,
    selector: RelayPairingSelector,
    peer: RelayPeerDescriptor,
  ): boolean {
    const retained = this.projections.get(selector)
    return retained === projection && !projection.cancellation.signal.aborted
      && retained.peers.some(candidate => candidate.attachmentId === peer.attachmentId
        && candidate.generation === peer.generation && candidate.pairingSelector === peer.pairingSelector)
  }
}

function retainObservedConversation(
  payload: DesktopCompanionLiveProjectionPayload,
  retained: boolean,
): DesktopCompanionLiveProjectionPayload {
  if (retained || !('conversation' in payload)) return payload
  const { conversation: _conversation, ...summary } = payload
  return summary
}

function boundLiveSessionProjection(
  channel: SnowCompanionProtocolChannel,
  projection: Extract<CompanionProjection, { type: 'session-live' }>,
): Extract<CompanionProjection, { type: 'session-live' }> {
  const message = (candidate: typeof projection): CompanionMessage => ({ type: 'projection', projection: candidate })
  if (channel.canEncode(message(projection))) return projection
  if (!('conversation' in projection) || projection.conversation === undefined
    || !isRecord(projection.conversation)) {
    if (!channel.canEncode(message(projection))) throw new Error('Companion live projection summary exceeds its negotiated wire limit')
    return projection
  }
  const nodes = Array.isArray(projection.conversation.nodes) ? projection.conversation.nodes : []
  for (let offset = 0; offset < nodes.length; offset += 1) {
    const candidate = {
      ...projection,
      conversation: { ...projection.conversation, nodes: nodes.slice(offset), hasMore: true },
    }
    if (channel.canEncode(message(candidate))) return candidate
  }
  let lower = 0
  let upper = REMOTE_PROTOCOL_LIMITS.transcriptPageBytes
  let fitted: typeof projection | undefined
  while (lower <= upper) {
    const limit = Math.floor((lower + upper) / 2)
    const candidate = {
      ...projection,
      conversation: truncateConversationText({
        ...projection.conversation,
        hasMore: true,
        nodes: nodes.length === 0 ? [] : [nodes.at(-1)],
      }, limit),
    }
    if (channel.canEncode(message(candidate))) {
      fitted = candidate
      lower = limit + 1
    } else {
      upper = limit - 1
    }
  }
  if (fitted !== undefined) return fitted
  const { conversation: _conversation, ...summary } = projection
  if (!channel.canEncode(message(summary))) throw new Error('Companion live projection summary exceeds its negotiated wire limit')
  return summary
}

function truncateConversationText(value: unknown, limit: number, key?: string): unknown {
  if (typeof value === 'string') {
    return key === 'text' || key === 'argsRaw' || key === 'message'
      ? truncateUtf8(value, limit)
      : value
  }
  if (Array.isArray(value)) return value.map(item => truncateConversationText(item, limit))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    truncateConversationText(entryValue, limit, entryKey),
  ]))
}

function truncateUtf8(value: string, limit: number): string {
  if (new TextEncoder().encode(value).byteLength <= limit) return value
  if (limit <= 0) return ''
  const suffix = limit >= 3 ? '…' : ''
  const contentLimit = limit - new TextEncoder().encode(suffix).byteLength
  let result = ''
  let bytes = 0
  for (const codePoint of value) {
    const size = new TextEncoder().encode(codePoint).byteLength
    if (bytes + size > contentLimit) break
    result += codePoint
    bytes += size
  }
  return result + suffix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCompanionProjection(
  value: CompanionResult | CompanionProjection,
): value is CompanionProjection {
  return value.type === 'foreground-sync' || value.type === 'transcript-page'
    || value.type === 'surface-snapshot' || value.type === 'conversation-snapshot'
    || value.type === 'session-live'
}

function isCompanionResultList(
  value: CompanionResult | CompanionProjection | readonly CompanionResult[],
): value is readonly CompanionResult[] {
  return Array.isArray(value)
}

/**
 * Keep Relay unavailable until the reviewed product channel is composed.
 * @returns fail-closed Desktop-owned Relay lifecycle injected into Settings.
 */
export function loadDesktopRemoteRelayConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): DesktopRemoteRelayConfig {
  const url = required(source, 'DSH_REMOTE_RELAY_WSS_URL')
  if (new URL(url).protocol !== 'wss:') throw new TypeError('DSH_REMOTE_RELAY_WSS_URL must use WSS')
  const config: DesktopRemoteRelayConfig = {
    url,
    attachTimeoutMs: positiveInteger(source, 'DSH_REMOTE_RELAY_ATTACH_TIMEOUT_MS'),
    heartbeatIntervalMs: positiveInteger(source, 'DSH_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS'),
    reconnectDelayMs: positiveInteger(source, 'DSH_REMOTE_RELAY_RECONNECT_DELAY_MS'),
    inboundMaxBytes: positiveInteger(source, 'DSH_REMOTE_RELAY_INBOUND_MAX_BYTES'),
    inboundMaxMessages: positiveInteger(source, 'DSH_REMOTE_RELAY_INBOUND_MAX_MESSAGES'),
  }
  if (config.inboundMaxBytes < REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('DSH_REMOTE_RELAY_INBOUND_MAX_BYTES must admit one maximum Relay message')
  }
  return config
}

/**
 * Select the observable production crypto gate or the explicit development endpoint.
 * @param options - Platform environment, process configuration, and optional socket adapter.
 * @returns Desktop-owned Relay lifecycle injected into Settings.
 */
export function createDesktopRemoteRelay(options: DesktopRemoteRelayOptions): DesktopRelayLifecycle {
  if (options.environment.environment !== 'production') return new FailClosedDesktopRelayLifecycle(CRYPTO_GATE)
  const config = loadDesktopRemoteRelayConfig(options.source)
  ;(options.initializeWasm ?? initializeDesktopSnowWasm)()
  const owner = new SnowDesktopAttachmentOwner(selector => options.snowPairingVault.reconnectState(selector))
  const channelOwner = new DesktopSnowRelayChannelOwner(owner, async (...input) => {
    await lifecycle.sendCiphertext(...input)
  }, options.handleOperation, () => options.desktopName(), options.liveProjection === undefined ? undefined : {
    ...options.liveProjection,
    reconnect: (selector, error) => {
      console.error('[desktop-companion] live projection requires Relay reconnect:', error)
      void lifecycle.reconnect(selector).catch((failure: unknown) => {
        console.error('[desktop-companion] Relay reconnect failed:', failure)
      })
    },
  })
  const lifecycle = new DesktopRelayEndpointLifecycle({
    attachmentId: () => parseRelayAttachmentId(crypto.randomUUID()),
    connect: async signal => options.connect === undefined
      ? await NodeRelayEndpointSocket.connect(config.url, signal, {
        maxBytes: config.inboundMaxBytes, maxMessages: config.inboundMaxMessages,
      })
      : await options.connect(signal, config),
    attachTimeoutMs: config.attachTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconnectDelayMs: config.reconnectDelayMs,
    onPeerAttachments: (update, selector) => { channelOwner.updatePeers(update, selector) },
    onCiphertext: async (ciphertext, sourceAttachmentId, localAttachmentId, pairingSelector, signal) => {
      await channelOwner.receive(ciphertext, sourceAttachmentId, localAttachmentId, pairingSelector, signal)
    },
    onPairingRetired: (selector) => { channelOwner.invalidate(selector) },
    resynchronize: async () => {},
    onConnectionLost: (attachmentId) => { channelOwner.connectionLost(attachmentId) },
  })
  return {
    configure: async (grant) => { await lifecycle.configure(grant) },
    synchronize: async (grants) => { await lifecycle.synchronize(grants) },
    start: async () => { await lifecycle.start() },
    stop: async (reason) => {
      await lifecycle.stop(reason)
      await channelOwner.drain()
    },
    getState: () => lifecycle.getState(),
  }
}

async function abortableAccept<T extends { negotiation: { cancel(): void } }>(
  promise: Promise<T>,
  signals: readonly AbortSignal[],
): Promise<T> {
  const cleanups: Array<() => void> = []
  const cancellation = new Promise<never>((_resolve, reject) => {
    const abort = (): void => { reject(new Error('Desktop Relay Snow accept was cancelled')) }
    for (const signal of signals) {
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      cleanups.push(() => { signal.removeEventListener('abort', abort) })
    }
  })
  try {
    return await Promise.race([promise, cancellation])
  } catch (error) {
    void promise.then((result) => { result.negotiation.cancel() }, () => {})
    throw error
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
}

function initializeDesktopSnowWasm(): void {
  const require = createRequire(import.meta.url)
  const glue = require.resolve('@deepseek-ai/dsh-noise-channel/snow-wasm')
  initializeSnowChannel(readFileSync(glue.replace(/\.js$/u, '_bg.wasm')))
}

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} must be configured`)
  return value
}

function positiveInteger(source: Record<string, string | undefined>, name: string): number {
  const value = Number(required(source, name))
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}
