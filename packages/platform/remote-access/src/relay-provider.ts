/** Host-only stateless Relay provider over persistent authority and shared coordination. */

import { createHash, randomBytes as secureRandomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  deriveRelayCredentialPublicKeyDigest,
  parseRelayPairingSelector,
  verifyRelayAttachmentProof,
  type RelayAttachMessage,
  type RelayAttachmentId,
  type RelayCiphertextMessage,
  type RelayHeartbeatMessage,
  type RelayPairingSelector,
  type RelayPeerUpdateMessage,
  type RelayReadyMessage,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  RemoteRelayError,
  RemoteRelayService,
} from '@deepseek-ai/dsh-remote-access'
import type {
  RelayConnectionToken,
  RelayCoordinationEvent,
  RelayCoordinator,
  RelayDeliveryId,
  RelayDirectoryEntry,
  RelayInstanceId,
  RelayRouteStore,
  RemoteRelayAttachment,
  RemoteRelayConfig,
} from './relay.ts'
import { createDeferred } from './deferred.ts'

interface LocalAttachment {
  entry: RelayDirectoryEntry
  deliver: (message: RelayCiphertextMessage | RelayPeerUpdateMessage) => Promise<void>
  credentialDigest: Uint8Array
  close?: () => void | Promise<void>
  writer: Promise<void>
  bufferedBytes: number
  heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  closed: boolean
  closeTransaction: Promise<void> | undefined
  unregistered: boolean
  writerDrained: boolean
  socketClosed: boolean
  capacityHeld: boolean
}

interface PendingDelivery {
  promise: Promise<boolean>
  settle(delivered: boolean): void
}

/** Stateless Relay provider over persistent route authority and ephemeral shared coordination. */
export class RemoteRelayProvider extends RemoteRelayService {
  private readonly attachments = new Map<string, LocalAttachment>()
  private readonly attachmentReservations = new Set<string>()
  private readonly attachmentQuiescence = new Set<Promise<void>>()
  private readonly pendingDeliveries = new Map<RelayDeliveryId, (delivered: boolean) => void>()
  private readonly ready: Promise<() => Promise<void>>
  private readonly config: RemoteRelayConfig
  private readonly randomBytes: (size: number) => Uint8Array
  private readonly schedule: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private disposed = false
  private deliverySequence = 0
  private disposeTransaction: Promise<void> | undefined
  private coordinatorStopped = false

  /** @param ctx - Platform context. @param options - instance, storage, coordination, bounds, and entropy. */
  constructor(ctx: Context, private readonly options: {
    instanceId: RelayInstanceId
    routeStore: RelayRouteStore
    coordinator: RelayCoordinator
    config: RemoteRelayConfig
    randomBytes?: (size: number) => Uint8Array
    deliveryId?: () => RelayDeliveryId
    clock?: { now(): number }
    schedule?: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>
    capacity?: { tryAcquire(): boolean; release(): void; retryAfterMs: number }
  }) {
    super(ctx)
    this.config = validateRemoteRelayConfig(options.config)
    this.randomBytes = options.randomBytes ?? secureRandomBytes
    this.schedule = options.schedule ?? ((task, delayMs) => setTimeout(task, delayMs))
    this.ready = options.coordinator.listen(options.instanceId, event => this.receiveCoordinationEvent(event))
    ctx.effect(() => async () => { await this.dispose() }, 'remote-access: Relay resources')
  }

  async activateCredentialDigest(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number> {
    this.assertOpen()
    if (credentialDigest.byteLength !== 32) throw new TypeError('Relay credential digest must contain 32 bytes')
    const revision = await this.options.routeStore.rotate(routeId, endpoint, credentialDigest.slice())
    if (pairingSelector !== undefined) {
      const issued = await this.options.routeStore.issue(routeId, endpoint, credentialDigest.slice(), pairingSelector)
      if (issued !== revision) throw new RemoteRelayError('RELAY_ROUTE_REVOKED', 'Relay route activation diverged')
    }
    if (revision > 1) await this.options.coordinator.invalidate({ type: 'invalidate', routeId, revision })
    return revision
  }

  /**
   * @param routeId - active route.
   * @param endpoint - credential endpoint.
   * @param digest - endpoint-created SHA-256 digest.
   * @param pairingSelector - optional non-secret pairing selector.
   * @returns active route revision.
   */
  async registerCredentialDigest(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    digest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number> {
    this.assertOpen()
    if (digest.byteLength !== 32) throw new TypeError('Relay credential digest must contain 32 bytes')
    const revision = await this.options.routeStore.issue(routeId, endpoint, digest.slice(), pairingSelector)
    if (revision === undefined) throw new RemoteRelayError('RELAY_ROUTE_REVOKED', 'Relay route is inactive')
    return revision
  }

  async registerPairingCredentialDigests(
    routeId: RelayRouteId,
    pairingSelector: RelayPairingSelector,
    desktopCredentialDigest: Uint8Array,
    mobileCredentialDigest: Uint8Array,
  ): Promise<number> {
    this.assertOpen()
    if (desktopCredentialDigest.byteLength !== 32 || mobileCredentialDigest.byteLength !== 32) {
      throw new TypeError('Relay credential digests must each contain 32 bytes')
    }
    if (desktopCredentialDigest.every((byte, index) => byte === mobileCredentialDigest[index])) {
      throw new TypeError('Relay credential digests must be distinct')
    }
    return await this.options.routeStore.registerPairing(
      routeId, pairingSelector, desktopCredentialDigest.slice(), mobileCredentialDigest.slice(),
    )
  }

  /**
   * @param routeId - active route.
   * @param endpoint - credential endpoint.
   * @param digest - endpoint-created SHA-256 digest.
   */
  async revokeCredentialDigest(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    digest: Uint8Array,
  ): Promise<void> {
    this.assertOpen()
    if (digest.byteLength !== 32) throw new TypeError('Relay credential digest must contain 32 bytes')
    const revision = await this.options.routeStore.revokeCredential(routeId, endpoint, digest.slice())
    await this.options.coordinator.invalidate({ type: 'invalidate', routeId, revision })
  }

  async revokeRoute(routeId: RelayRouteId): Promise<void> {
    this.assertOpen()
    const revision = await this.options.routeStore.revoke(routeId)
    await this.options.coordinator.invalidate({ type: 'invalidate', routeId, revision })
  }

  async attach(input: {
    message: RelayAttachMessage
    deliver: (message: RelayCiphertextMessage | RelayPeerUpdateMessage) => Promise<void>
    close?: () => void | Promise<void>
    signal?: AbortSignal
    announce?: (message: RelayReadyMessage) => Promise<void>
  }): Promise<RemoteRelayAttachment> {
    this.assertOpen()
    const quiescence = createDeferred<void>()
    this.attachmentQuiescence.add(quiescence.promise)
    try {
      return await this.attachReserved(input)
    } finally {
      quiescence.resolve()
      this.attachmentQuiescence.delete(quiescence.promise)
    }
  }

  private async attachReserved(input: {
    message: RelayAttachMessage
    deliver: (message: RelayCiphertextMessage | RelayPeerUpdateMessage) => Promise<void>
    close?: () => void | Promise<void>
    signal?: AbortSignal
    announce?: (message: RelayReadyMessage) => Promise<void>
  }): Promise<RemoteRelayAttachment> {
    const signal = input.signal ?? NEVER_ABORTED
    throwIfAborted(signal)
    await this.ready
    throwIfAborted(signal)
    this.assertOpen()
    const key = attachmentKey(input.message.routeId, input.message.attachmentId)
    const replacing = this.attachments.has(key)
    let capacityHeld = false
    if (!replacing && this.options.capacity !== undefined) {
      if (!this.options.capacity.tryAcquire()) {
        throw new RemoteRelayError(
          'PLATFORM_CAPACITY',
          'Platform Instance has reached its Relay attachment limit',
          this.options.capacity.retryAfterMs,
        )
      }
      capacityHeld = true
    }
    if (this.attachmentReservations.has(key)
      || (!replacing && this.attachments.size + this.attachmentReservations.size >= this.config.maxConnections)) {
      if (capacityHeld) this.options.capacity?.release()
      throw new RemoteRelayError('PLATFORM_CAPACITY', 'Platform Instance has reached its Relay attachment limit', this.config.capacityRetryAfterMs)
    }
    this.attachmentReservations.add(key)
    let local: LocalAttachment | undefined
    try {
      if (input.message.expiresAt <= this.now() || !await verifyRelayAttachmentProof(input.message)) {
        throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay attachment proof is invalid or expired')
      }
      const digest = await deriveRelayCredentialPublicKeyDigest(input.message.credentialPublicKey)
      let authorization
      try {
        authorization = await this.options.routeStore.authorize(
          input.message.routeId,
          input.message.endpoint,
          digest,
          signal,
        )
      } catch {
        throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay route authority is unavailable')
      }
      this.assertOpen()
      if (authorization === undefined) {
        throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay credential is invalid')
      }
      const entry: RelayDirectoryEntry = {
        routeId: input.message.routeId,
        attachmentId: input.message.attachmentId,
        endpoint: input.message.endpoint,
        instanceId: this.options.instanceId,
        connectionToken: this.connectionToken(),
        revision: authorization.revision,
        ...(authorization.pairingSelector === undefined ? {} : { pairingSelector: authorization.pairingSelector }),
        expiresAt: this.now() + this.config.directoryTtlMs,
      }
      const existing = this.attachments.get(key)
      if (existing !== undefined) {
        if (existing.capacityHeld) {
          existing.capacityHeld = false
          capacityHeld = true
        }
        await this.closeAndDrain(existing)
      }
      this.assertOpen()
      throwIfAborted(signal)
      const attached: LocalAttachment = {
        entry,
        deliver: input.deliver,
        credentialDigest: digest,
        ...(input.close === undefined ? {} : { close: input.close }),
        writer: Promise.resolve(),
        bufferedBytes: 0,
        heartbeatTimer: undefined,
        closed: false,
        closeTransaction: undefined,
        unregistered: false,
        writerDrained: false,
        socketClosed: input.close === undefined,
        capacityHeld,
      }
      local = attached
      this.attachments.set(key, attached)
      try {
        const routeEntries = await this.options.coordinator.list(entry.routeId)
        const ready = relayReady(entry, routeEntries, this.now())
        if (input.announce !== undefined) await input.announce(ready)
        throwIfAborted(signal)
        await this.options.coordinator.register(entry, signal)
        throwIfAborted(signal)
        const current = await this.options.routeStore.authorize(entry.routeId, entry.endpoint, digest, signal)
        if (this.disposed || current?.revision !== entry.revision
          || current.pairingSelector !== entry.pairingSelector) {
          await this.closeAndDrain(attached)
          throw new RemoteRelayError(
            this.disposed ? 'REMOTE_OFFLINE' : 'RELAY_ATTACHMENT_REJECTED',
            this.disposed ? 'Platform Instance is offline' : 'Relay credential was superseded during attachment',
          )
        }
        this.armHeartbeat(attached)
        await this.publishPeerUpdates(entry.routeId, entry.connectionToken)
      } catch (error) {
        if (!attached.closed) await this.closeAndDrain(attached)
        throw error
      }
      return {
        receive: async (message) => {
          if (message.type === 'heartbeat') await this.heartbeat(attached, message)
          else await this.forward(attached, message)
        },
        close: async () => { await this.closeAndDrain(attached) },
      }
    } catch (error) {
      if (local === undefined && capacityHeld) this.options.capacity?.release()
      throw error
    } finally {
      this.attachmentReservations.delete(key)
    }
  }

  /** Close every local attachment and coordination subscription, observing every failure. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.disposeTransaction !== undefined) return this.disposeTransaction
    const transaction = this.runDispose()
    this.disposeTransaction = transaction
    try {
      await transaction
    } finally {
      this.disposeTransaction = undefined
    }
  }

  private async runDispose(): Promise<void> {
    for (const resolve of this.pendingDeliveries.values()) resolve(false)
    this.pendingDeliveries.clear()
    await Promise.all(this.attachmentQuiescence)
    const readiness = await Promise.allSettled([this.ready])
    if (readiness[0].status !== 'fulfilled') {
      throw new AggregateError(
        readiness.filter(result => result.status === 'rejected').map(result => result.reason as unknown),
        'Remote Relay disposal failed',
      )
    }
    const stop = readiness[0].value
    const attachments = [...this.attachments.values()]
    const stopCoordinator = this.coordinatorStopped
      ? Promise.resolve()
      : stop().then(() => { this.coordinatorStopped = true })
    const results = await Promise.allSettled([...attachments.map(attachment => this.closeAndDrain(attachment)), stopCoordinator])
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (errors.length > 0) throw new AggregateError(errors, 'Remote Relay disposal failed')
  }

  private async forward(local: LocalAttachment, message: RelayCiphertextMessage): Promise<void> {
    if (local.closed) throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay attachment is closed')
    if (message.routeId !== local.entry.routeId || message.sourceAttachmentId !== local.entry.attachmentId) {
      throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay ciphertext source does not match its attachment')
    }
    const target = await this.options.coordinator.locate(message.routeId, message.targetAttachmentId)
    if (target === undefined || target.expiresAt <= this.now()) {
      throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay target is offline')
    }
    if (this.pendingDeliveries.size >= this.config.maxPendingDeliveries) {
      throw new RemoteRelayError(
        'PLATFORM_CAPACITY',
        'Platform Instance has reached its pending Relay delivery limit',
        this.config.capacityRetryAfterMs,
      )
    }
    const deliveryId = this.allocateDeliveryId()
    const acknowledgement = this.awaitDelivery(deliveryId)
    try {
      const subscribed = await this.options.coordinator.publish(target.instanceId, {
        ...message,
        sourceInstanceId: this.options.instanceId,
        targetConnectionToken: target.connectionToken,
        deliveryId,
        revision: target.revision,
      })
      if (!subscribed) acknowledgement.settle(false)
      if (!await acknowledgement.promise) {
        throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay target is offline')
      }
    } finally {
      this.pendingDeliveries.delete(deliveryId)
    }
  }

  private async heartbeat(local: LocalAttachment, message: RelayHeartbeatMessage): Promise<void> {
    if (local.closed) throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay attachment is closed')
    if (message.attachmentId !== local.entry.attachmentId) {
      throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay heartbeat does not match its attachment')
    }
    let authorization
    try {
      authorization = await this.options.routeStore.authorize(
        local.entry.routeId,
        local.entry.endpoint,
        local.credentialDigest,
      )
    } catch {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('RELAY_ROUTE_REVOKED', 'Relay route authority could not be revalidated')
    }
    if (authorization === undefined || authorization.revision !== local.entry.revision
      || authorization.pairingSelector !== local.entry.pairingSelector) {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('RELAY_ROUTE_REVOKED', 'Relay route authority changed')
    }
    const refreshed = { ...local.entry, expiresAt: this.now() + this.config.directoryTtlMs }
    if (!await this.options.coordinator.refresh(refreshed)) {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay directory entry is no longer current')
    }
    local.entry = refreshed
    this.armHeartbeat(local)
  }

  private async receiveCoordinationEvent(event: RelayCoordinationEvent): Promise<void> {
    if (event.type === 'invalidate') {
      const matches = [...this.attachments.values()].filter(
        attachment => attachment.entry.routeId === event.routeId && attachment.entry.revision < event.revision,
      )
      const results = await Promise.allSettled(matches.map(attachment => this.closeAndDrain(attachment)))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Relay invalidation cleanup failed')
      return
    }
    if (event.type === 'delivered') {
      this.pendingDeliveries.get(event.deliveryId)?.(true)
      return
    }
    if (event.type === 'peer-update') {
      const target = this.attachments.get(attachmentKey(event.routeId, event.attachmentId))
      if (target === undefined || target.closed
        || target.entry.connectionToken !== event.targetConnectionToken
        || target.entry.revision !== event.revision) return
      const { targetConnectionToken: _targetConnectionToken, revision: _revision, ...message } = event
      await this.deliver(target, message)
      return
    }
    const target = this.attachments.get(attachmentKey(event.routeId, event.targetAttachmentId))
    if (target === undefined || target.closed
      || target.entry.connectionToken !== event.targetConnectionToken
      || target.entry.revision !== event.revision) return
    const {
      sourceInstanceId,
      targetConnectionToken: _targetConnectionToken,
      deliveryId,
      revision: _revision,
      ...message
    } = event
    if (await this.deliver(target, message)) {
      await this.options.coordinator.publish(sourceInstanceId, { type: 'delivered', deliveryId })
    }
  }

  private async deliver(
    local: LocalAttachment,
    message: RelayCiphertextMessage | RelayPeerUpdateMessage,
  ): Promise<boolean> {
    const size = message.type === 'ciphertext' ? message.ciphertext.byteLength : 0
    if (local.bufferedBytes + size > this.config.maxBufferedCiphertextBytes) {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('RELAY_SLOW_CONSUMER', 'Relay target exceeded its ciphertext buffer limit')
    }
    local.bufferedBytes += size
    const write = local.writer.then(async () => {
      if (local.closed) return false
      await local.deliver(message)
      return !local.closed
    }).finally(() => { local.bufferedBytes -= size })
    local.writer = write.then(() => {}, () => {})
    try {
      return await write
    } catch {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay target writer failed')
    }
  }

  private async closeAndDrain(local: LocalAttachment): Promise<void> {
    if (local.closeTransaction !== undefined) return local.closeTransaction
    local.closed = true
    clearTimeout(local.heartbeatTimer)
    local.heartbeatTimer = undefined
    const transaction = this.runCloseTransaction(local)
    local.closeTransaction = transaction
    try {
      await transaction
    } finally {
      local.closeTransaction = undefined
    }
  }

  private async runCloseTransaction(local: LocalAttachment): Promise<void> {
    const operations: Array<{ complete(): void; promise: Promise<unknown> }> = []
    if (!local.unregistered) operations.push({
      complete: () => { local.unregistered = true },
      promise: this.options.coordinator.unregister(local.entry),
    })
    if (!local.writerDrained) operations.push({
      complete: () => { local.writerDrained = true },
      promise: local.writer,
    })
    if (!local.socketClosed && local.close !== undefined) operations.push({
      complete: () => { local.socketClosed = true },
      promise: Promise.resolve().then(local.close),
    })
    const results = await Promise.allSettled(operations.map(operation => operation.promise))
    const errors: unknown[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') operations[index]?.complete()
      else errors.push(result.reason as unknown)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Relay attachment drain failed')
    const key = attachmentKey(local.entry.routeId, local.entry.attachmentId)
    if (this.attachments.get(key) === local) this.attachments.delete(key)
    if (local.capacityHeld) {
      local.capacityHeld = false
      this.options.capacity?.release()
    }
    await this.publishPeerUpdates(local.entry.routeId)
  }

  private async publishPeerUpdates(routeId: RelayRouteId, exclude?: RelayConnectionToken): Promise<void> {
    const entries = await this.options.coordinator.list(routeId)
    const now = this.now()
    const active = entries.filter(entry => entry.expiresAt > now)
    await Promise.all(active.filter(target => target.connectionToken !== exclude).map(async (target) => {
      const update = relayPeerUpdate(target, active, now)
      await this.options.coordinator.publish(target.instanceId, {
        ...update,
        targetConnectionToken: target.connectionToken,
        revision: target.revision,
      })
    }))
  }

  private connectionToken(): RelayConnectionToken {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) throw new TypeError('Relay connection-token source must return 16 bytes')
    const value = Buffer.from(bytes).toString('base64url') as RelayConnectionToken
    bytes.fill(0)
    return value
  }

  private deliveryId(): RelayDeliveryId {
    if (this.options.deliveryId !== undefined) return this.options.deliveryId()
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) throw new TypeError('Relay delivery-id source must return 16 bytes')
    this.deliverySequence += 1
    const value = `${Buffer.from(bytes).toString('base64url')}-${String(this.deliverySequence)}` as RelayDeliveryId
    bytes.fill(0)
    return value
  }

  private allocateDeliveryId(): RelayDeliveryId {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const deliveryId = this.deliveryId()
      if (!this.pendingDeliveries.has(deliveryId)) return deliveryId
    }
    throw new RemoteRelayError(
      'PLATFORM_CAPACITY',
      'Relay delivery correlation could not be allocated',
      this.config.capacityRetryAfterMs,
    )
  }

  private awaitDelivery(deliveryId: RelayDeliveryId): PendingDelivery {
    const result = createDeferred<boolean>()
    const settle = (delivered: boolean): void => {
      clearTimeout(timeout)
      this.pendingDeliveries.delete(deliveryId)
      result.resolve(delivered)
    }
    const timeout = this.schedule(() => { settle(false) }, this.config.deliveryAckTimeoutMs)
    timeout.unref()
    this.pendingDeliveries.set(deliveryId, settle)
    return { promise: result.promise, settle }
  }

  private armHeartbeat(local: LocalAttachment): void {
    if (local.heartbeatTimer !== undefined) clearTimeout(local.heartbeatTimer)
    local.heartbeatTimer = this.schedule(() => {
      void this.closeAndDrain(local).catch((error: unknown) => {
        console.error('[remote-access] Relay heartbeat timeout cleanup failed:', error)
      })
    }, this.config.heartbeatTimeoutMs)
    local.heartbeatTimer.unref()
  }

  private now(): number { return this.options.clock?.now() ?? Date.now() }

  private assertOpen(): void {
    if (this.disposed) throw new RemoteRelayError('REMOTE_OFFLINE', 'Platform Instance is offline')
  }

}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay attachment was cancelled')
}

const NEVER_ABORTED = new AbortController().signal

function attachmentKey(routeId: RelayRouteId, attachmentId: RelayAttachmentId): string {
  return `${routeId}:${attachmentId}`
}

function relayReady(
  local: RelayDirectoryEntry,
  entries: readonly RelayDirectoryEntry[],
  now: number,
): RelayReadyMessage {
  const candidates = entries.filter(peer => peer.routeId === local.routeId
    && peer.endpoint !== local.endpoint
    && peer.expiresAt > now
    && peer.revision === local.revision
    && (local.pairingSelector === undefined || peer.pairingSelector === local.pairingSelector))
  const peersBySelector = new Map<RelayPairingSelector, RelayReadyMessage['peers'][number]>()
  for (const peer of candidates) {
    const pairingSelector = peer.pairingSelector ?? local.pairingSelector
      ?? parseRelayPairingSelector('development-keyless-pairing')
    peersBySelector.set(pairingSelector, {
      attachmentId: peer.attachmentId,
      pairingSelector,
      generation: connectionGeneration(local, peer, pairingSelector),
    })
  }
  return {
    type: 'ready', transportVersion: 1, routeId: local.routeId,
    attachmentId: local.attachmentId,
    peers: [...peersBySelector.values()],
  }
}

function relayPeerUpdate(
  local: RelayDirectoryEntry,
  entries: readonly RelayDirectoryEntry[],
  now: number,
): RelayPeerUpdateMessage {
  const ready = relayReady(local, entries, now)
  return { ...ready, type: 'peer-update' }
}

function connectionGeneration(
  local: RelayDirectoryEntry,
  peer: RelayDirectoryEntry,
  pairingSelector: RelayPairingSelector,
): number {
  const tokens = [local.connectionToken, peer.connectionToken].sort()
  const digest = createHash('sha256')
    .update(`${local.routeId}\0${pairingSelector}\0${tokens[0]}\0${tokens[1]}`)
    .digest()
  return digest.readUIntBE(0, 6) + 1
}

function validateRemoteRelayConfig(config: RemoteRelayConfig): RemoteRelayConfig {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Remote Relay ${name} must be a positive integer`)
  }
  return { ...config }
}
