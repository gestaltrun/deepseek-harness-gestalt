/** Host-only stateless Relay provider over persistent authority and shared coordination. */

import { createHash, randomBytes as secureRandomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  parseRelayCredential,
  type RelayAttachMessage,
  type RelayAttachmentId,
  type RelayCiphertextMessage,
  type RelayCredential,
  type RelayHeartbeatMessage,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  parseRelayCredentialFingerprint,
  RemoteRelayError,
  RemoteRelayService,
} from '@deepseek-ai/dsh-remote-access'
import type {
  RelayConnectionToken,
  RelayCoordinationEvent,
  RelayCoordinator,
  RelayCredentialGrant,
  RelayDeliveryId,
  RelayDirectoryEntry,
  RelayInstanceId,
  RelayRouteStore,
  RelayPairingActivitySink,
  RemoteRelayAttachment,
  RemoteRelayConfig,
} from './relay.ts'

interface LocalAttachment {
  entry: RelayDirectoryEntry
  deliver: (message: RelayCiphertextMessage) => Promise<void>
  credentialDigest: Uint8Array
  credentialFingerprint: ReturnType<typeof parseRelayCredentialFingerprint>
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
  activityReleased: boolean
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
    pairingActivity?: RelayPairingActivitySink
  }) {
    super(ctx)
    this.config = validateRemoteRelayConfig(options.config)
    this.randomBytes = options.randomBytes ?? secureRandomBytes
    this.schedule = options.schedule ?? ((task, delayMs) => setTimeout(task, delayMs))
    this.ready = options.coordinator.listen(options.instanceId, event => this.receiveCoordinationEvent(event))
    ctx.effect(() => async () => { await this.dispose() }, 'remote-access: Relay resources')
  }

  async rotateCredential(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop' = 'desktop'): Promise<RelayCredentialGrant> {
    this.assertOpen()
    const credential = this.newCredential()
    const revision = await this.options.routeStore.rotate(routeId, endpoint, credentialDigest(credential))
    if (revision > 1) await this.options.coordinator.invalidate({ type: 'invalidate', routeId, revision })
    return { routeId, endpoint, credential, revision }
  }

  async issueCredential(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop' = 'mobile'): Promise<RelayCredentialGrant> {
    this.assertOpen()
    const credential = this.newCredential()
    const revision = await this.options.routeStore.issue(routeId, endpoint, credentialDigest(credential))
    if (revision === undefined) throw new RemoteRelayError('RELAY_ROUTE_REVOKED', 'Relay route is inactive')
    return { routeId, endpoint, credential, revision }
  }

  async revokeCredential(grant: RelayCredentialGrant): Promise<void> {
    this.assertOpen()
    const revision = await this.options.routeStore.revokeCredential(
      grant.routeId,
      grant.endpoint,
      credentialDigest(grant.credential),
    )
    await this.options.coordinator.invalidate({ type: 'invalidate', routeId: grant.routeId, revision })
  }

  async revokeRoute(routeId: RelayRouteId): Promise<void> {
    this.assertOpen()
    const revision = await this.options.routeStore.revoke(routeId)
    await this.options.coordinator.invalidate({ type: 'invalidate', routeId, revision })
  }

  async attach(input: {
    message: RelayAttachMessage
    deliver: (message: RelayCiphertextMessage) => Promise<void>
    close?: () => void | Promise<void>
    signal?: AbortSignal
    announce?: () => Promise<void>
  }): Promise<RemoteRelayAttachment> {
    this.assertOpen()
    const quiescence = deferred<void>()
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
    deliver: (message: RelayCiphertextMessage) => Promise<void>
    close?: () => void | Promise<void>
    signal?: AbortSignal
    announce?: () => Promise<void>
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
      const digest = credentialDigest(input.message.credential)
      let revision: number | undefined
      try {
        revision = await this.options.routeStore.authorize(
          input.message.routeId,
          input.message.endpoint,
          digest,
          signal,
        )
      } catch {
        throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay route authority is unavailable')
      }
      this.assertOpen()
      if (revision === undefined) {
        throw new RemoteRelayError('RELAY_ATTACHMENT_REJECTED', 'Relay credential is invalid')
      }
      const entry: RelayDirectoryEntry = {
        routeId: input.message.routeId,
        attachmentId: input.message.attachmentId,
        endpoint: input.message.endpoint,
        instanceId: this.options.instanceId,
        connectionToken: this.connectionToken(),
        revision,
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
        credentialFingerprint: fingerprintFromDigest(digest),
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
        activityReleased: false,
      }
      local = attached
      this.attachments.set(key, attached)
      try {
        if (input.announce !== undefined) await input.announce()
        throwIfAborted(signal)
        await this.options.coordinator.register(entry, signal)
        throwIfAborted(signal)
        const currentRevision = await this.options.routeStore.authorize(entry.routeId, entry.endpoint, digest, signal)
        if (this.disposed || currentRevision !== entry.revision) {
          await this.closeAndDrain(attached)
          throw new RemoteRelayError(
            this.disposed ? 'REMOTE_OFFLINE' : 'RELAY_ATTACHMENT_REJECTED',
            this.disposed ? 'Platform Instance is offline' : 'Relay credential was superseded during attachment',
          )
        }
        await this.recordPairingActivity(attached, this.now())
        this.armHeartbeat(attached)
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
    await this.recordPairingActivity(local, this.now())
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
    let revision: number | undefined
    try {
      revision = await this.options.routeStore.authorize(
        local.entry.routeId,
        local.entry.endpoint,
        local.credentialDigest,
      )
    } catch {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('RELAY_ROUTE_REVOKED', 'Relay route authority could not be revalidated')
    }
    if (revision === undefined || revision !== local.entry.revision) {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('RELAY_ROUTE_REVOKED', 'Relay route authority changed')
    }
    const refreshed = { ...local.entry, expiresAt: this.now() + this.config.directoryTtlMs }
    if (!await this.options.coordinator.refresh(refreshed)) {
      await this.closeAndDrain(local)
      throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay directory entry is no longer current')
    }
    local.entry = refreshed
    await this.recordPairingActivity(local, this.now())
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

  private async deliver(local: LocalAttachment, message: RelayCiphertextMessage): Promise<boolean> {
    const size = message.ciphertext.byteLength
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
    if (!local.activityReleased && local.entry.endpoint === 'mobile' && this.options.pairingActivity !== undefined) {
      operations.push({
        complete: () => { local.activityReleased = true },
        promise: this.options.pairingActivity.releaseRelayLease({
          credentialFingerprint: local.credentialFingerprint,
          connectionToken: local.entry.connectionToken,
          observedAt: this.now(),
        }),
      })
    }
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
  }

  private async recordPairingActivity(
    local: LocalAttachment,
    accessedAt: number,
  ): Promise<void> {
    if (local.entry.endpoint !== 'mobile' || this.options.pairingActivity === undefined) return
    await this.options.pairingActivity.recordRelayLease({
      credentialFingerprint: local.credentialFingerprint,
      connectionToken: local.entry.connectionToken,
      expiresAt: local.entry.expiresAt,
      accessedAt,
    })
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
    const result = deferred<boolean>()
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

  private newCredential(): RelayCredential {
    const bytes = this.randomBytes(32)
    if (bytes.byteLength !== 32) throw new TypeError('Relay credential source must return 32 bytes')
    const credential = parseRelayCredential(Buffer.from(bytes).toString('base64url'))
    bytes.fill(0)
    return credential
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteRelayError('REMOTE_OFFLINE', 'Relay attachment was cancelled')
}

const NEVER_ABORTED = new AbortController().signal

function credentialDigest(credential: RelayCredential): Uint8Array {
  return new Uint8Array(createHash('sha256').update(credential).digest())
}

function fingerprintFromDigest(digest: Uint8Array): ReturnType<typeof parseRelayCredentialFingerprint> {
  return parseRelayCredentialFingerprint(Buffer.from(digest).toString('base64url'))
}

function attachmentKey(routeId: RelayRouteId, attachmentId: RelayAttachmentId): string {
  return `${routeId}:${attachmentId}`
}

function validateRemoteRelayConfig(config: RemoteRelayConfig): RemoteRelayConfig {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Remote Relay ${name} must be a positive integer`)
  }
  return { ...config }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
