/** Shipped Mobile mutation adapter for one current Snow IK attachment. */

import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  decodeProtocolBase64Url,
  parseCompanionOperationId,
  parseCompanionInteractionId,
  parseCompanionSessionId,
  parseCompanionWorkspaceId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionOperation,
  type CompanionOperationId,
  type CompanionMutationResult,
  type CompanionResult,
  type RelayAttachmentId,
  type RelayPairingSelector,
} from '@deepseek-ai/dsh-remote-protocol'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'
import { transferSelectedCompanionAttachment } from './companion-attachment.ts'
import type { CompanionForegroundRuntime } from './companion-lifecycle.ts'
import type { PairingCompanionKeyVault } from './companion-keys.ts'
import {
  type CompanionOperationReceipt,
  type CompanionStatusAnswer,
  type CompanionUncertainOperationSettlement,
} from './companion-cache.ts'
import type { MobilePendingSettlement, MobilePendingSettlementReceipt } from './companion-projection.ts'
import type {
  MobileCompanionMutationChannel,
  MobileCompanionTrackedSubmission,
} from './companion-surface.ts'

interface ActiveMobileSnowChannel {
  channel: SnowCompanionProtocolChannel
  targetAttachmentId: RelayAttachmentId
  pairingSelector: RelayPairingSelector
  generation: number
}

/** Mutable physical-connection owner shared by the Relay callbacks and the stable React adapter. */
export class MobileSnowCompanionConnection {
  private active: ActiveMobileSnowChannel | undefined
  private readonly invalidated = new Set<() => void>()

  /** Publish one completed current-generation IK channel. */
  connect(active: ActiveMobileSnowChannel): void {
    if (this.active !== undefined && this.active !== active) {
      this.active = undefined
      this.publishInvalidated()
    }
    this.active = active
  }

  /** Invalidate the channel before its Snow transport is disposed. */
  disconnect(): void {
    this.active = undefined
    this.publishInvalidated()
  }

  /** @returns the exact current physical channel, or undefined while disconnected. */
  current(): ActiveMobileSnowChannel | undefined { return this.active }

  /** @param listener - pending product work invalidated by connection loss. */
  onInvalidated(listener: () => void): () => void {
    this.invalidated.add(listener)
    return () => { this.invalidated.delete(listener) }
  }

  private publishInvalidated(): void {
    const failures: unknown[] = []
    for (const listener of [...this.invalidated]) {
      try { listener() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) {
      console.error('[mobile-companion] connection invalidation subscriber failures:', new AggregateError(failures))
    }
  }
}

/** Product dependencies that never leave endpoint-owned authority inside Platform. */
export interface MobileSnowCompanionProductOptions {
  runtime: CompanionForegroundRuntime
  connection: MobileSnowCompanionConnection
  installation: Pick<PlatformAccountInstallation, 'authorizeCurrentInstallation'>
  attachmentKeys: Pick<PairingCompanionKeyVault, 'attachmentKeyMaterial'>
  platformOrigin: string
  sendCiphertext(targetAttachmentId: RelayAttachmentId, ciphertext: Uint8Array): Promise<void>
  reportFailure?(error: unknown): void
  trackHistoryRefresh?(sessionId: SessionId, submission: MobileCompanionTrackedSubmission): void
  trackSurfaceRefresh?(submission: MobileCompanionTrackedSubmission): void
  /** Apply one durable reconnect outcome to the current Mobile presentation. */
  recoveredReceipt?(receipt: CompanionOperationReceipt): void
  /** Durable receipt owner selected for the authenticated Account and pairing. */
  operationSettlement?: CompanionUncertainOperationSettlement
}

/** Stable Mobile UI adapter whose every send revalidates current foreground generation. */
export class MobileSnowCompanionProductChannel implements MobileCompanionMutationChannel {
  private readonly refreshAfterConfirmation = new Map<CompanionOperationId, SessionId>()
  private operationSettlement: CompanionUncertainOperationSettlement | undefined
  private readonly mutations = new Map<CompanionOperationId, {
    active: ActiveMobileSnowChannel
    resolve(result: CompanionMutationResult): void
    reject(error: unknown): void
  }>()
  private readonly statusQueries = new Map<CompanionOperationId, {
    active: ActiveMobileSnowChannel
    resolve(answer: CompanionStatusAnswer): void
    reject(error: unknown): void
  }>()
  private reconciliation: Promise<readonly CompanionOperationReceipt[]> | undefined
  private readonly images = new Map<CompanionOperationId, {
    active: ActiveMobileSnowChannel
    sessionId: string
    attachmentId: string
    mediaType: string
    sha256?: string
    count?: number
    chunks: Uint8Array[]
    resolve(dataUrl: string): void
    reject(error: unknown): void
  }>()

  /** @param options - current lifecycle, endpoint key vault, Account proof owner, and Relay sender. */
  constructor(private readonly options: MobileSnowCompanionProductOptions) {
    this.operationSettlement = options.operationSettlement
    options.connection.onInvalidated(() => { this.rejectPending() })
  }

  /** Select the receipt owner for the current Account and Personal Pairing. */
  setOperationSettlement(settlement: CompanionUncertainOperationSettlement | undefined): void {
    this.operationSettlement = settlement
  }

  create(input: { workspace?: string }): MobileCompanionTrackedSubmission {
    const operationIdValue = operationId()
    const operation: CompanionOperation = {
      type: 'create-session', operationId: operationIdValue,
      ...(input.workspace === undefined ? {} : { workspaceId: parseCompanionWorkspaceId(input.workspace) }),
    }
    const active = this.requireActive()
    const permit = this.options.runtime.bindCompanionMutationPermit('session-create')
    if (permit === undefined) throw new Error('Companion Session creation has no current connection generation')
    const completion = this.sendMutation(active, operation, 'session-create', permit).then((result) => {
      requireConfirmed(result, 'Companion Session creation')
      this.queueSurfaceRefresh()
    })
    return { operationId: operationIdValue, completion }
  }

  submit(sessionId: SessionId, text: string): { operationId: CompanionOperationId; completion: Promise<void> } {
    const operationIdValue = operationId()
    const operation: CompanionOperation = {
      type: 'submit-prompt',
      operationId: operationIdValue,
      sessionId: parseCompanionSessionId(sessionId),
      text,
    }
    const active = this.requireActive()
    const permit = this.options.runtime.bindCompanionMutationPermit('prompt')
    if (permit === undefined) throw new Error('Companion prompt has no current connection generation')
    const completion = this.sendMutation(
      active, operation, 'prompt', permit, parseCompanionSessionId(sessionId),
    ).then((result) => {
      requireConfirmed(result, 'Companion prompt')
      this.queueRefresh(sessionId)
    })
    return { operationId: operationIdValue, completion }
  }

  cancel(sessionId: SessionId): MobileCompanionTrackedSubmission {
    const operationIdValue = operationId()
    const operation: CompanionOperation = {
      type: 'cancel-session', operationId: operationIdValue, sessionId: parseCompanionSessionId(sessionId),
    }
    const active = this.requireActive()
    const permit = this.options.runtime.bindCompanionMutationPermit('cancel')
    if (permit === undefined) throw new Error('Companion cancel has no current connection generation')
    return {
      operationId: operationIdValue,
      completion: this.sendMutation(active, operation, 'cancel', permit, operation.sessionId).then((result) => {
        requireConfirmed(result, 'Companion cancel')
        this.queueRefresh(sessionId)
      }),
    }
  }

  attach(sessionId: SessionId, file: File): { operationId: ReturnType<typeof parseCompanionOperationId>; completion: Promise<void> } {
    const operationIdValue = operationId()
    const permit = this.options.runtime.bindCompanionMutationPermit('attachment')
    if (permit === undefined) throw new Error('Companion attachment has no current connection generation')
    const active = this.requireActive()
    const pairingId = parsePersonalPairingId(active.pairingSelector)
    const attachmentKey = this.options.attachmentKeys.attachmentKeyMaterial(pairingId)
    if (attachmentKey === undefined) throw new Error('Companion attachment has no retained attachment key')
    const completion = (async () => {
      try {
        const authorization = await this.options.installation.authorizeCurrentInstallation()
        permit.requireCurrent()
        await transferSelectedCompanionAttachment(file, {
          attachmentKey,
          origin: this.options.platformOrigin,
          authorizationHeaders: authorizationHeaders(authorization, active.pairingSelector),
          operationId: operationIdValue,
          sessionId: parseCompanionSessionId(sessionId),
          permit,
          send: async (offer) => {
            const result = await this.sendMutation(active, offer, 'attachment', permit, offer.sessionId)
            if (result.type === 'confirmed') this.queueRefresh(sessionId)
          },
        })
      } finally {
        attachmentKey.fill(0)
      }
    })()
    return { operationId: operationIdValue, completion }
  }

  search(query: string): MobileCompanionTrackedSubmission {
    const operationIdValue = operationId()
    return this.sendTracked({ type: 'search-sessions', operationId: operationIdValue, query })
  }

  /** Request the current Desktop Session and Workspace baseline after foreground synchronization. */
  refreshSurface(offset = 0): MobileCompanionTrackedSubmission {
    const operationIdValue = operationId()
    return this.sendTracked({ type: 'refresh-surface', operationId: operationIdValue, offset })
  }

  loadOlder(sessionId: SessionId, beforeSeq?: number): MobileCompanionTrackedSubmission {
    const operationIdValue = operationId()
    return this.sendTracked({
      type: 'load-history', operationId: operationIdValue, sessionId: parseCompanionSessionId(sessionId),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: REMOTE_PROTOCOL_LIMITS.historyPageMessages,
    })
  }

  settle(settlement: MobilePendingSettlement): Promise<MobilePendingSettlementReceipt> {
    const active = this.requireActive()
    const operationIdValue = operationId()
    const operation: CompanionOperation = {
      type: 'settle-interaction', operationId: operationIdValue,
      sessionId: parseCompanionSessionId(settlement.sessionId),
      interactionId: parseCompanionInteractionId(settlement.interactionId),
      settlement: interactionSettlement(settlement),
    }
    const permit = this.options.runtime.bindCompanionMutationPermit(settlement.kind)
    if (permit === undefined) return Promise.reject(new Error('Companion interaction has no current connection generation'))
    return this.sendMutation(active, operation, settlement.kind, permit, operation.sessionId).then((result) => {
      if (result.type === 'operation-failed') throw new Error(result.failure.message)
      if (result.type !== 'interaction-receipt') throw new Error('Companion interaction returned an invalid result')
      if (result.accepted) {
        this.queueRefresh(settlement.sessionId)
        return { accepted: true }
      }
      if (result.reason === undefined) throw new Error('Companion interaction receipt omitted its rejection reason')
      return { accepted: false, reason: result.reason }
    })
  }

  /** Read and verify exact image bytes projected by the Paired Desktop. */
  loadImage(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    const active = this.requireActive()
    const operationIdValue = operationId()
    const operation: CompanionOperation = {
      type: 'read-image', operationId: operationIdValue,
      sessionId: parseCompanionSessionId(sessionId), attachmentId: String(attachment.attachmentId),
    }
    return new Promise<string>((resolve, reject) => {
      this.images.set(operationIdValue, {
        active, sessionId, attachmentId: String(attachment.attachmentId), mediaType: attachment.mediaType,
        chunks: [], resolve, reject,
      })
      const permit = this.options.runtime.bindCompanionMutationPermit('other-mutation')
      if (permit === undefined) {
        this.images.delete(operationIdValue)
        reject(new Error('Companion image has no current connection generation'))
        return
      }
      void this.sendCurrent(active, { type: 'operation', operation }, permit).catch((error: unknown) => {
        this.images.delete(operationIdValue)
        reject(asError(error, 'Companion image send failed'))
      })
    })
  }

  /** Accept one result already authenticated by the current physical Snow receiver. */
  acceptResult(result: CompanionResult): void {
    if (result.type === 'status') {
      const query = this.statusQueries.get(result.operationId)
      if (query !== undefined) {
        this.statusQueries.delete(result.operationId)
        query.resolve('committed' in result
          ? { committed: true, original: result.committed }
          : { committed: false })
      }
      return
    }
    if (result.type === 'confirmed' || result.type === 'attachment-rejected'
      || result.type === 'operation-failed' || result.type === 'interaction-receipt') {
      const mutation = this.mutations.get(result.operationId)
      if (mutation !== undefined) {
        this.mutations.delete(result.operationId)
        mutation.resolve(result)
      }
    }
    if (result.type === 'operation-failed') {
      this.refreshAfterConfirmation.delete(result.operationId)
      const image = this.images.get(result.operationId)
      if (image !== undefined) {
        this.images.delete(result.operationId)
        image.reject(new Error(result.failure.message))
      }
      return
    }
    if (result.type === 'confirmed') {
      const sessionId = this.refreshAfterConfirmation.get(result.operationId)
      if (sessionId === undefined) return
      this.refreshAfterConfirmation.delete(result.operationId)
      this.queueRefresh(sessionId)
      return
    }
    if (result.type === 'interaction-receipt') return
    if (result.type !== 'image-chunk') return
    const pending = this.images.get(result.operationId)
    if (pending === undefined) return
    if (this.options.connection.current() !== pending.active
      || result.sessionId !== pending.sessionId || result.attachmentId !== pending.attachmentId
      || result.mediaType !== pending.mediaType || result.index !== pending.chunks.length
      || (pending.count !== undefined && pending.count !== result.count)
      || (pending.sha256 !== undefined && pending.sha256 !== result.sha256)) {
      this.images.delete(result.operationId)
      pending.reject(new Error('Companion image result did not match its current request'))
      return
    }
    pending.count = result.count
    pending.sha256 = result.sha256
    pending.chunks.push(decodeProtocolBase64Url(result.data, REMOTE_PROTOCOL_LIMITS.imageChunkBytes, 'Companion image chunk'))
    if (pending.chunks.length !== result.count) return
    this.images.delete(result.operationId)
    void finishImage(pending).then(
      (value) => { pending.resolve(value) },
      (error: unknown) => { pending.reject(asError(error, 'Companion image verification failed')) },
    )
  }

  private sendTracked(operation: CompanionOperation): MobileCompanionTrackedSubmission {
    const permit = this.options.runtime.bindCompanionMutationPermit('other-mutation')
    if (permit === undefined) throw new Error('Companion operation has no current connection generation')
    const active = this.requireActive()
    return {
      operationId: operation.operationId,
      completion: this.sendCurrent(active, { type: 'operation', operation }, permit),
    }
  }

  private async sendCurrent(
    active: ActiveMobileSnowChannel,
    message: Parameters<SnowCompanionProtocolChannel['seal']>[0],
    permit: { requireCurrent(): void },
    beforeSend?: () => void | Promise<void>,
  ): Promise<void> {
    permit.requireCurrent()
    if (this.options.connection.current() !== active) throw new Error('Companion Snow channel was replaced')
    const ciphertext = active.channel.seal(message)
    permit.requireCurrent()
    await beforeSend?.()
    permit.requireCurrent()
    if (this.options.connection.current() !== active) throw new Error('Companion Snow channel was replaced')
    await this.options.sendCiphertext(active.targetAttachmentId, ciphertext)
    permit.requireCurrent()
    if (this.options.connection.current() !== active) throw new Error('Companion Snow channel was replaced')
  }

  /** Reconcile every unknown receipt once after the replacement connection synchronizes. */
  reconcileUnknown(): Promise<readonly CompanionOperationReceipt[]> {
    if (this.reconciliation !== undefined) return this.reconciliation
    const reconciliation = this.reconcileUnknownOwned()
    this.reconciliation = reconciliation
    void reconciliation.then(
      () => { if (this.reconciliation === reconciliation) this.reconciliation = undefined },
      () => { if (this.reconciliation === reconciliation) this.reconciliation = undefined },
    )
    return reconciliation
  }

  private async reconcileUnknownOwned(): Promise<readonly CompanionOperationReceipt[]> {
    const active = this.requireActive()
    const settlement = this.requireOperationSettlement()
    const rows = await settlement.reconcileUnknown({
      send: () => Promise.reject(new Error('Companion reconciliation never sends a mutation')),
      queryStatus: async operationIdValue => await this.queryStatus(active, operationIdValue),
    })
    for (const row of rows) {
      if (row.status === 'committed' && row.original !== undefined) {
        this.options.recoveredReceipt?.(row)
        this.refreshRecovered(row)
      } else if (row.status === 'not-submitted') {
        this.options.recoveredReceipt?.(row)
      }
    }
    return rows
  }

  private async sendMutation(
    active: ActiveMobileSnowChannel,
    operation: CompanionOperation,
    kind: Parameters<CompanionUncertainOperationSettlement['transmit']>[0]['kind'],
    permit: { requireCurrent(): void },
    sessionId?: ReturnType<typeof parseCompanionSessionId>,
  ): Promise<CompanionMutationResult> {
    const receipt = await this.requireOperationSettlement().transmit(
      { kind, operationId: operation.operationId, ...(sessionId === undefined ? {} : { sessionId }) },
      {
        send: async (_mutation, beforeSend) => {
          const outcome = new Promise<CompanionMutationResult>((resolve, reject) => {
            this.mutations.set(operation.operationId, { active, resolve, reject })
          })
          void outcome.catch(() => {})
          try {
            await this.sendCurrent(active, { type: 'operation', operation }, permit, beforeSend)
            return { known: true, result: await outcome }
          } catch (error) {
            this.mutations.delete(operation.operationId)
            throw error
          }
        },
        queryStatus: async operationIdValue => await this.queryStatus(active, operationIdValue),
      },
      this.options.runtime.getState(),
    )
    if (receipt.status !== 'committed' || receipt.original === undefined) {
      throw new Error(`Companion operation ${operation.operationId} requires reconnect reconciliation`)
    }
    return receipt.original
  }

  private queryStatus(
    active: ActiveMobileSnowChannel,
    operationIdValue: CompanionOperationId,
  ): Promise<CompanionStatusAnswer> {
    const permit = this.options.runtime.bindCompanionMutationPermit('other-mutation')
    if (permit === undefined) return Promise.reject(new Error('Companion status query has no current connection generation'))
    return new Promise((resolve, reject) => {
      this.statusQueries.set(operationIdValue, { active, resolve, reject })
      void this.sendCurrent(active, {
        type: 'operation', operation: { type: 'query-operation-status', operationId: operationIdValue },
      }, permit).catch((error: unknown) => {
        this.statusQueries.delete(operationIdValue)
        reject(asError(error, 'Companion status query failed'))
      })
    })
  }

  private requireOperationSettlement(): CompanionUncertainOperationSettlement {
    if (this.operationSettlement === undefined) throw new Error('Companion operation receipt owner is unavailable')
    return this.operationSettlement
  }

  private refreshRecovered(receipt: CompanionOperationReceipt): void {
    const sessionId = receipt.sessionId as SessionId | undefined
    if (receipt.kind === 'session-create') this.queueSurfaceRefresh()
    else if (sessionId !== undefined) this.queueRefresh(sessionId)
  }

  private requireActive(): ActiveMobileSnowChannel {
    const active = this.options.connection.current()
    if (active === undefined) throw new Error('Companion Snow channel is unavailable')
    return active
  }

  private queueRefresh(sessionId: SessionId): void {
    queueMicrotask(() => {
      this.startRefresh(
        () => this.loadOlder(sessionId),
        (submission) => { this.options.trackHistoryRefresh?.(sessionId, submission) },
        this.options.trackHistoryRefresh !== undefined,
      )
      this.queueSurfaceRefresh()
    })
  }

  private queueSurfaceRefresh(): void {
    this.startRefresh(
      () => this.refreshSurface(),
      (submission) => { this.options.trackSurfaceRefresh?.(submission) },
      this.options.trackSurfaceRefresh !== undefined,
    )
  }

  private startRefresh(
    start: () => MobileCompanionTrackedSubmission,
    track: (submission: MobileCompanionTrackedSubmission) => void,
    tracked: boolean,
  ): void {
    let submission: MobileCompanionTrackedSubmission
    try {
      submission = start()
    } catch (error) {
      this.reportFailure(error)
      return
    }
    if (!tracked) {
      this.reportUntracked(submission)
      return
    }
    try {
      track(submission)
    } catch (error) {
      this.reportUntracked(submission)
      this.reportFailure(error)
    }
  }

  private reportUntracked(submission: MobileCompanionTrackedSubmission): void {
    void submission.completion.catch((error: unknown) => { this.reportFailure(error) })
  }

  private reportFailure(error: unknown): void {
    try { this.options.reportFailure?.(error) } catch {
      console.error('[mobile-companion] product failure reporter threw')
    }
  }

  private rejectPending(): void {
    const error = new Error('Companion operation belongs to a disconnected connection generation')
    for (const pending of this.mutations.values()) pending.reject(error)
    for (const pending of this.statusQueries.values()) pending.reject(error)
    for (const pending of this.images.values()) pending.reject(error)
    this.mutations.clear()
    this.statusQueries.clear()
    this.images.clear()
    this.refreshAfterConfirmation.clear()
  }
}

function operationId(): ReturnType<typeof parseCompanionOperationId> {
  return parseCompanionOperationId(crypto.randomUUID())
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value })
}

function requireConfirmed(result: CompanionMutationResult, subject: string): void {
  if (result.type === 'confirmed') return
  if (result.type === 'operation-failed') throw new Error(result.failure.message)
  throw new Error(`${subject} returned ${result.type}`)
}

function interactionSettlement(
  settlement: MobilePendingSettlement,
): Extract<CompanionOperation, { type: 'settle-interaction' }>['settlement'] {
  const result = settlement.result
  if (settlement.kind === 'approval') {
    if (!result.ok || !isRecord(result.value)
      || (result.value.outcome !== 'allowed-once' && result.value.outcome !== 'rejected')) {
      throw new TypeError('Companion Approval settlement result is invalid')
    }
    return { kind: 'approval', outcome: result.value.outcome }
  }
  if (!result.ok) {
    if (result.error.code !== 'cancelled') throw new TypeError('Companion Ask User cancellation is invalid')
    return { kind: 'question-cancelled' }
  }
  if (!isRecord(result.value) || !isRecord(result.value.answer) || !Array.isArray(result.value.answer.answers)) {
    throw new TypeError('Companion Ask User settlement result is invalid')
  }
  return {
    kind: 'question',
    answers: result.value.answer.answers.map((value) => {
      if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.selected)
        || value.selected.some(item => typeof item !== 'string')
        || (value.custom !== undefined && typeof value.custom !== 'string')) {
        throw new TypeError('Companion Ask User answer is invalid')
      }
      return {
        id: value.id,
        selected: value.selected as string[],
        ...(value.custom === undefined ? {} : { custom: value.custom }),
      }
    }),
  }
}

async function finishImage(pending: {
  mediaType: string
  sha256?: string
  chunks: Uint8Array[]
}): Promise<string> {
  const length = pending.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of pending.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const sha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
  if (pending.sha256 === undefined || sha256 !== pending.sha256) {
    throw new Error('Companion image digest verification failed')
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${pending.mediaType};base64,${btoa(binary)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorizationHeaders(
  authorization: Awaited<ReturnType<PlatformAccountInstallation['authorizeCurrentInstallation']>>,
  selector: RelayPairingSelector,
): Record<string, string> {
  return {
    Authorization: `Bearer ${authorization.accessToken}`,
    'X-Gestalt-Proof-Jti': authorization.proof.jti,
    'X-Gestalt-Proof-Issued-At': String(authorization.proof.issuedAt),
    'X-Gestalt-Proof-Signature': authorization.proof.signature,
    'X-Gestalt-Pairing-Selector': selector,
  }
}
