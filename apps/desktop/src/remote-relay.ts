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

const CRYPTO_GATE = 'Personal Pairing requires an independently reviewed handshake and Relay crypto provider.'

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
) => Promise<CompanionResult>

interface DesktopSnowProjection {
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  peers: readonly RelayPeerDescriptor[]
  cancellation: AbortController
}

/** Attachment-generation owner that rejects late Snow accept results before channel publication. */
export class DesktopSnowRelayChannelOwner {
  private readonly channels = new Map<RelayAttachmentId, {
    channel: SnowCompanionProtocolChannel
    peer: RelayPeerDescriptor
  }>()
  private readonly projections = new Map<RelayPairingSelector, DesktopSnowProjection>()
  private desktopRevision = 0

  /** @param owner - Desktop Snow IK responder. @param send - current Relay attachment sender. */
  constructor(
    private readonly owner: DesktopSnowAcceptOwner,
    private readonly send: DesktopRelaySender,
    private readonly handleOperation: DesktopCompanionOperationHandler | undefined,
    private readonly desktopName: () => string | undefined,
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
    for (const [attachmentId, active] of this.channels) {
      if (active.peer.pairingSelector !== selector) continue
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
        const result = await this.handleOperation(message.operation, pairingSelector)
        if (!this.isCurrent(current, pairingSelector, projected)) {
          throw new Error('Desktop Relay rejected a stale Companion operation result')
        }
        await this.send(pairingSelector, sourceAttachmentId, existing.channel.seal({ type: 'result', result }))
      }
      return
    }
    if (projected === undefined) throw new Error('Desktop Relay rejected an unprojected Snow peer')
    const acceptedPromise = this.owner.accept(ciphertext, sourceAttachmentId, current.routeId, current.attachmentId)
    const accepted = await abortableAccept(acceptedPromise, [current.cancellation.signal, lifecycleSignal])
    let published = false
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
      const nextRevision = this.desktopRevision + 1
      const desktopName = this.desktopName()
      if (desktopName === undefined) throw new Error('Desktop Relay has no authenticated Installation presentation')
      const synchronization = sealDesktopForegroundSynchronization(
        accepted.channel, accepted.generation, nextRevision, desktopName,
      )
      await this.send(accepted.pairingSelector, accepted.targetAttachmentId, synchronization)
      if (!this.isCurrent(current, pairingSelector, projected)) {
        throw new Error('Desktop Relay rejected a stale Snow IK transcript')
      }
      this.channels.set(sourceAttachmentId, { channel: accepted.channel, peer: projected })
      this.desktopRevision = nextRevision
      published = true
    } finally {
      if (!published) accepted.channel.dispose()
    }
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
  }, options.handleOperation, () => options.desktopName())
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
  return lifecycle
}

async function abortableAccept<T extends { channel: SnowCompanionProtocolChannel }>(
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
    void promise.then((result) => { result.channel.dispose() }, () => {})
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
