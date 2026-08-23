/** Product-owned Mobile projection of authenticated Desktop Companion state. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConversationSnapshot, SessionId, SessionListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CompanionAttachmentRejectedResult,
  CompanionHostFailure,
  CompanionOperationId,
  CompanionResult,
  CompanionSessionId,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionAttachmentDeliveryUncertainError } from './companion-attachment.ts'
import type { CompanionOperationReceipt } from './companion-cache.ts'
import { companionMayMutate, type CompanionForegroundRuntime } from './companion-lifecycle.ts'
import { requireCompanionMutation, type CompanionMutationName } from './companion-mutation.ts'
import {
  adaptMobileCompanionProjection,
  assertCompanionJsonProjection,
  type MobileCompanionProjectionDto,
  type MobilePendingSettlement,
  type MobilePendingSettlementReceipt,
} from './companion-projection.ts'

/** Authenticated JSON Desktop projection accepted for one physical connection. */
export type ValidatedDesktopSurfaceResync = MobileCompanionProjectionDto

type ValidatedCompanionProjectionReceipt =
  | {
    readonly type: 'conversation-snapshot'
    readonly operationId: CompanionOperationId
    readonly sessionId: CompanionSessionId
    readonly beforeSeq?: number | undefined
  }
  | { readonly type: 'surface-snapshot'; readonly operationId: CompanionOperationId }

/** Receiver installed beside one authenticated decoder generation. */
export interface ValidatedDesktopSurfaceResyncReceiver {
  /** @param message - decoded projection authenticated for this receiver's physical connection. */
  acceptValidatedDesktopResync(message: ValidatedDesktopSurfaceResync): void
  /** @param projection - exact authenticated projection applied to the aggregate Mobile state. */
  acceptValidatedCompanionProjection(projection: ValidatedCompanionProjectionReceipt): boolean
}

/** Result receiver owned by one authenticated physical connection generation. */
export interface ValidatedCompanionResultReceiver {
  /** @param result - validated result decoded by the connection that owns this receiver. */
  acceptValidatedCompanionResult(result: CompanionResult): void
}

/** Encrypted projection cache selected by the authenticated Account and Personal Pairing. */
export interface MobileCompanionProjectionCache {
  /** Seal the latest Desktop-confirmed projection. */
  save(projection: MobileCompanionProjectionDto): Promise<void>
  /** Open the last Desktop-confirmed projection for Remote Offline presentation. */
  restore(): Promise<MobileCompanionProjectionDto | undefined>
  /** Remove cached content and receipts without deleting pairing authority. */
  clear(): Promise<void>
}

/** Desktop-authoritative search state; Mobile never synthesizes substring hits. */
interface MobileCompanionSearchItem {
  /** Session identity converted from the authenticated protocol value. */
  readonly sessionId: SessionId
  /** Desktop-authoritative full-text result excerpt. */
  readonly snippet: string
}

/** Desktop-authoritative search state; Mobile never synthesizes substring hits. */
export type MobileCompanionSearchSnapshot =
  | { readonly query: ''; readonly status: 'idle'; readonly items: readonly []; readonly hasMore: false }
  | {
    readonly query: string
    readonly status: 'loading' | 'ready'
    readonly items: readonly MobileCompanionSearchItem[]
    readonly hasMore: boolean
  }
  | {
    readonly query: string
    readonly status: 'error'
    readonly items: readonly MobileCompanionSearchItem[]
    readonly hasMore: boolean
    readonly error: CompanionHostFailure
  }

/** Latest attachment state retained until another file is selected. */
export type MobileCompanionAttachmentSnapshot =
  | { readonly status: 'idle' }
  | { readonly operationId: CompanionOperationId; readonly status: 'sending' | 'accepted' }
  | {
    readonly operationId: CompanionOperationId
    readonly status: 'rejected'
    readonly reason: CompanionAttachmentRejectedResult['reason']
    readonly message: string
  }
  | {
    readonly operationId: CompanionOperationId
    readonly status: 'failed' | 'uncertain'
    readonly message: string
  }

/** Correlated cancel, history, or refresh failure owned by the Mobile product surface. */
export interface MobileCompanionOperationFailure {
  /** Exact request correlation from the encrypted Companion protocol. */
  readonly operationId: CompanionOperationId
  /** Product operation class that owns presentation of this failure. */
  readonly operation: 'create' | 'prompt' | 'cancel' | 'interaction' | 'history' | 'refresh'
  /** Session scope for cancel and history; refresh is Desktop-wide. */
  readonly sessionId?: SessionId | undefined
  /** Stable Host failure projected for display. */
  readonly failure: CompanionHostFailure
}

/** Current Desktop-confirmed content retained while a replacement connection resynchronizes. */
export interface MobileCompanionSurfaceSnapshot {
  /** Desktop display name from the last authenticated resync. */
  readonly desktopName?: string | undefined
  /** Last authenticated Session projection. */
  readonly sessions: SessionListState
  /** Last authenticated Workspace projection. */
  readonly workspaces: readonly WorkspaceView[]
  /** Last authenticated opened conversations. */
  readonly conversations: Readonly<Partial<Record<SessionId, ConversationSnapshot>>>
  /** Current Desktop-authoritative full-text search state. */
  readonly search: MobileCompanionSearchSnapshot
  /** Latest selected-file transfer and its correlated Desktop outcome. */
  readonly attachment: MobileCompanionAttachmentSnapshot
  /** Latest correlated non-attachment product failure. */
  readonly operationFailure?: MobileCompanionOperationFailure | undefined
  /** Latest Companion Cache deletion failure; retained content remains visible. */
  readonly cacheFailure?: string | undefined
}

/** One selected-file transfer started by the encrypted Companion channel. */
interface MobileCompanionAttachmentSubmission {
  readonly operationId: CompanionOperationId
  readonly completion: Promise<void>
}

interface MobileCompanionMutationSubmission {
  readonly operationId: CompanionOperationId
  readonly completion: Promise<void>
}

/** One encrypted operation whose wire-send completion is observable by the Mobile surface. */
export interface MobileCompanionTrackedSubmission {
  readonly operationId: CompanionOperationId
  readonly completion: Promise<void>
}

/** Encrypted mutations owned by one authenticated physical connection. */
export interface MobileCompanionMutationChannel {
  create(input: { workspace?: string }): MobileCompanionTrackedSubmission
  submit(sessionId: SessionId, text: string): MobileCompanionMutationSubmission
  cancel(sessionId: SessionId): MobileCompanionTrackedSubmission
  attach(sessionId: SessionId, file: File): MobileCompanionAttachmentSubmission
  search(query: string): MobileCompanionTrackedSubmission
  loadOlder(sessionId: SessionId, beforeSeq?: number): MobileCompanionTrackedSubmission
  settle(settlement: MobilePendingSettlement): Promise<MobilePendingSettlementReceipt>
}

/** Authenticated content reads owned by one physical connection. */
interface MobileCompanionContentChannel {
  loadImage(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string>
}

/** Content and mutation adapters installed atomically with one decoder receiver. */
export interface MobileCompanionConnectionChannel {
  readonly mutations: MobileCompanionMutationChannel
  readonly content: MobileCompanionContentChannel
}

interface ActiveConnection {
  readonly token: symbol
  readonly channel: MobileCompanionConnectionChannel
}

interface PendingHistoryOperation {
  readonly operationId: CompanionOperationId
  readonly sessionId: SessionId
  readonly beforeSeq?: number | undefined
}

/** Generation-bound Desktop projection plus fail-closed Mobile callbacks. */
export class MobileCompanionSurface {
  readonly #runtime: CompanionForegroundRuntime
  readonly #listeners = new Set<() => void>()
  #activeConnection: ActiveConnection | undefined
  #snapshot: MobileCompanionSurfaceSnapshot = emptySurfaceSnapshot()
  #searchOperationId: CompanionOperationId | undefined
  #attachmentOperationId: CompanionOperationId | undefined
  #refreshOperationId: CompanionOperationId | undefined
  #projectionCache: MobileCompanionProjectionCache | undefined
  readonly #operations = new Map<CompanionOperationId, {
    kind: 'create' | 'submit' | 'cancel'
    sessionId?: SessionId
  }>()
  readonly #historyOperations = new Map<CompanionOperationId, PendingHistoryOperation>()
  readonly #historyInFlight = new Map<SessionId, PendingHistoryOperation>()

  /** @param runtime - current physical-connection synchronization authority. */
  constructor(runtime: CompanionForegroundRuntime) { this.#runtime = runtime }

  /** @returns the last authenticated Desktop projection. */
  getSnapshot(): MobileCompanionSurfaceSnapshot { return this.#snapshot }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Select the cache owned by the current Account and Personal Pairing. */
  setProjectionCache(cache: MobileCompanionProjectionCache | undefined): void {
    if (cache === this.#projectionCache) return
    this.#projectionCache = cache
    this.#activeConnection = undefined
    this.#operations.clear()
    this.#historyOperations.clear()
    this.#historyInFlight.clear()
    this.#searchOperationId = undefined
    this.#attachmentOperationId = undefined
    this.#refreshOperationId = undefined
    this.#snapshot = emptySurfaceSnapshot()
    this.publish()
  }

  /** Restore cached read-only content only while no authenticated generation has replaced it. */
  async restoreProjectionCache(): Promise<boolean> {
    const cache = this.#projectionCache
    if (cache === undefined) return false
    const projection = await cache.restore()
    if (projection === undefined || cache !== this.#projectionCache || this.#activeConnection !== undefined) return false
    const adapted = adaptMobileCompanionProjection(
      projection,
      () => Promise.reject(new Error('Companion interaction requires foreground synchronization')),
    )
    this.#snapshot = {
      ...adapted,
      search: { query: '', status: 'idle', items: [], hasMore: false },
      attachment: { status: 'idle' },
    }
    this.publish()
    return true
  }

  /** Clear cached content for the selected Desktop while retaining Personal Pairing keys. */
  async clearProjectionCache(): Promise<void> {
    try {
      await this.#projectionCache?.clear()
    } catch (error) {
      this.#snapshot = {
        ...this.#snapshot,
        cacheFailure: error instanceof Error ? error.message : 'Companion Cache deletion failed',
      }
      this.publish()
      throw error
    }
    if (!this.mayMutate()) {
      this.#snapshot = emptySurfaceSnapshot()
      this.publish()
    }
  }

  /** Drop the current authority immediately, optionally deleting its serialized cache afterward. */
  async releaseProjectionCache(deleteStored: boolean): Promise<void> {
    const cache = this.#projectionCache
    this.setProjectionCache(undefined)
    if (deleteStored && cache !== undefined) await cache.clear()
  }

  /**
   * Register the exact surface refresh sent on the current authenticated channel.
   * @param submission - protocol id and send completion returned by the refresh sender.
   */
  trackSurfaceRefresh(submission: MobileCompanionTrackedSubmission): void {
    this.requireActive('other-mutation')
    this.#refreshOperationId = submission.operationId
    void submission.completion.catch(() => {
      if (this.#refreshOperationId !== submission.operationId) return
      this.#refreshOperationId = undefined
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: this.sendFailure('refresh', submission.operationId),
      }
      this.publish()
    })
  }

  /**
   * Register a post-mutation tail-history refresh already sent by the product channel.
   * @param sessionId - exact Session refreshed after the mutation.
   * @param submission - protocol id and send completion for the history request.
   */
  trackHistoryRefresh(sessionId: SessionId, submission: MobileCompanionTrackedSubmission): void {
    this.requireActive('history')
    this.registerHistory(sessionId, undefined, submission)
  }

  /** @returns whether current synchronization and its bound encrypted channel admit mutations. */
  mayMutate(): boolean {
    return this.#activeConnection !== undefined && companionMayMutate(this.#runtime.getState())
  }

  /** Bind projection, content, and mutations to one physical connection generation. */
  bindAuthenticatedConnection(
    channel: MobileCompanionConnectionChannel,
  ): ValidatedDesktopSurfaceResyncReceiver | undefined {
    const lifecycleReceiver = this.#runtime.bindValidatedDesktopResync()
    if (lifecycleReceiver === undefined) return undefined
    const token = Symbol('mobile-companion-connection')
    return {
      acceptValidatedDesktopResync: (message) => {
        assertCompanionJsonProjection(message)
        const active = { token, channel }
        const projection = adaptMobileCompanionProjection(
          message,
          settlement => this.settlePending(active, settlement),
        )
        const previousConnection = this.#activeConnection
        const replacingConnection = previousConnection !== undefined && previousConnection.token !== token
        const conversations = { ...projection.conversations }
        if (!replacingConnection) {
          for (const pending of this.#historyInFlight.values()) {
            const conversation = conversations[pending.sessionId]
            if (conversation !== undefined) {
              conversations[pending.sessionId] = { ...conversation, loadingOlder: true }
            }
          }
        }
        const previousSnapshot = this.#snapshot
        this.#activeConnection = active
        this.#snapshot = {
          ...projection,
          conversations,
          search: replacingConnection
            ? { query: '', status: 'idle', items: [], hasMore: false }
            : previousSnapshot.search,
          attachment: previousSnapshot.attachment,
          operationFailure: previousSnapshot.operationFailure,
          cacheFailure: previousSnapshot.cacheFailure,
        }
        let accepted: boolean
        try {
          accepted = lifecycleReceiver.acceptValidatedDesktopResync(message)
        } catch (error) {
          this.#activeConnection = previousConnection
          this.#snapshot = previousSnapshot
          throw error
        }
        if (!accepted) {
          this.#activeConnection = previousConnection
          this.#snapshot = previousSnapshot
          return
        }
        if (replacingConnection) {
          this.#operations.clear()
          this.#historyOperations.clear()
          this.#historyInFlight.clear()
          this.#searchOperationId = undefined
          this.#refreshOperationId = undefined
        }
        this.publish()
        void this.#projectionCache?.save(message).catch((error: unknown) => {
          console.error('[companion-cache] authenticated projection retention failed:', error)
        })
      },
      acceptValidatedCompanionProjection: (projection) => {
        if (this.#activeConnection?.token !== token || !companionMayMutate(this.#runtime.getState())) return false
        return this.acceptCurrentCompanionProjection(projection)
      },
    }
  }

  readonly create = (input: { workspace?: string }): void => {
    const submission = this.transmit('session-create', channel => channel.mutations.create(input))
    this.#operations.set(submission.operationId, { kind: 'create' })
    void submission.completion.catch(() => {
      if (this.#operations.get(submission.operationId)?.kind !== 'create') return
      this.#operations.delete(submission.operationId)
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: this.sendFailure('create', submission.operationId),
      }
      this.publish()
    })
  }

  readonly submit = async (sessionId: SessionId, text: string): Promise<void> => {
    const submission = this.transmit('prompt', channel => channel.mutations.submit(sessionId, text))
    this.#operations.set(submission.operationId, { kind: 'submit', sessionId })
    await submission.completion
  }

  readonly cancel = (sessionId: SessionId): void => {
    const submission = this.transmit('cancel', channel => channel.mutations.cancel(sessionId))
    this.#operations.set(submission.operationId, { kind: 'cancel', sessionId })
    void submission.completion.catch(() => {
      if (this.#operations.get(submission.operationId)?.kind !== 'cancel') return
      this.#operations.delete(submission.operationId)
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: this.sendFailure('cancel', submission.operationId, sessionId),
      }
      this.publish()
    })
  }

  readonly attach = (sessionId: SessionId, file: File): void => {
    if (this.#attachmentOperationId !== undefined) {
      throw new Error(`Attachment operation ${this.#attachmentOperationId} must be resolved before selecting another file`)
    }
    const submission = this.transmit('attachment', channel => channel.mutations.attach(sessionId, file))
    this.#attachmentOperationId = submission.operationId
    this.#snapshot = { ...this.#snapshot, attachment: { operationId: submission.operationId, status: 'sending' } }
    this.publish()
    void submission.completion.catch((error: unknown) => {
      if (this.#attachmentOperationId !== submission.operationId) return
      if (error instanceof CompanionAttachmentDeliveryUncertainError && error.operationId === submission.operationId) {
        this.#snapshot = {
          ...this.#snapshot,
          attachment: {
            operationId: submission.operationId,
            status: 'uncertain',
            message: 'Attachment delivery is uncertain; reconnect to reconcile it before retrying.',
          },
        }
      } else {
        this.#attachmentOperationId = undefined
        this.#snapshot = {
          ...this.#snapshot,
          attachment: {
            operationId: submission.operationId,
            status: 'failed',
            message: error instanceof Error ? error.message : 'Attachment transfer failed',
          },
        }
      }
      this.publish()
    })
  }

  readonly search = (query: string): void => {
    const trimmed = query.trim()
    if (trimmed === '') {
      this.#searchOperationId = undefined
      this.#snapshot = { ...this.#snapshot, search: { query: '', status: 'idle', items: [], hasMore: false } }
      this.publish()
      return
    }
    const submission = this.transmit('other-mutation', channel => channel.mutations.search(trimmed))
    this.#searchOperationId = submission.operationId
    this.#snapshot = {
      ...this.#snapshot,
      search: { query: trimmed, status: 'loading', items: [], hasMore: false },
    }
    this.publish()
    void submission.completion.catch((_error: unknown) => {
      if (this.#searchOperationId !== submission.operationId) return
      this.#searchOperationId = undefined
      this.#snapshot = {
        ...this.#snapshot,
        search: {
          query: trimmed,
          status: 'error',
          items: this.#snapshot.search.items,
          hasMore: this.#snapshot.search.hasMore,
          error: companionSendFailure(),
        },
      }
      this.publish()
    })
  }

  readonly loadOlder = (sessionId: SessionId): void => {
    this.requireActive('history')
    if (this.#historyInFlight.has(sessionId)) return
    const conversation = this.#snapshot.conversations[sessionId]
    const beforeSeq = conversation === undefined ? undefined : oldestNodeSeq(conversation)
    const submission = this.transmit('history', channel => channel.mutations.loadOlder(sessionId, beforeSeq))
    this.registerHistory(sessionId, beforeSeq, submission)
  }

  readonly loadImage = async (sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> => {
    const active = this.requireActive('other-mutation')
    const result = await active.channel.content.loadImage(sessionId, attachment)
    if (this.#activeConnection?.token !== active.token || !companionMayMutate(this.#runtime.getState())) {
      throw new Error('Companion content response belongs to a stale connection generation')
    }
    return result
  }

  /** Bind decoded-result acceptance to the current physical connection generation. */
  bindValidatedCompanionResults(): ValidatedCompanionResultReceiver | undefined {
    const active = this.#activeConnection
    if (active === undefined || !companionMayMutate(this.#runtime.getState())) return undefined
    return {
      acceptValidatedCompanionResult: (result) => {
        if (this.#activeConnection?.token !== active.token || !companionMayMutate(this.#runtime.getState())) return
        this.acceptCurrentCompanionResult(result)
      },
    }
  }

  /** Apply a durable reconnect outcome without relying on retired connection-local maps. */
  acceptRecoveredOperation(receipt: CompanionOperationReceipt): void {
    if (receipt.kind === 'attachment') {
      this.#attachmentOperationId = receipt.operationId
      this.acceptCurrentCompanionResult(receipt.status === 'committed' && receipt.original !== undefined
        ? receipt.original
        : { type: 'status', operationId: receipt.operationId, absent: true })
      return
    }
    const operation = recoveredFailureOperation(receipt.kind)
    if (operation === undefined) return
    const sessionId = receipt.sessionId === undefined ? undefined : localSessionId(receipt.sessionId)
    if (receipt.status === 'committed' && receipt.original?.type === 'operation-failed') {
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: {
          operationId: receipt.operationId, operation, sessionId, failure: receipt.original.failure,
        },
      }
    } else if (receipt.status === 'not-submitted') {
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: {
          operationId: receipt.operationId, operation, sessionId,
          failure: {
            kind: 'business', code: 'companion-not-submitted',
            message: 'Desktop reports that the Companion operation was not submitted.',
          },
        },
      }
    } else {
      this.#snapshot = { ...this.#snapshot, operationFailure: this.failureAfterSuccess(operation, sessionId) }
    }
    this.publish()
  }

  private acceptCurrentCompanionResult(result: CompanionResult): void {
    if (result.type === 'status' && 'committed' in result) {
      this.acceptCurrentCompanionResult(result.committed)
      return
    }
    if (result.operationId === this.#searchOperationId && result.type === 'session-search') {
      this.#snapshot = {
        ...this.#snapshot,
        search: {
          query: this.#snapshot.search.query,
          status: 'ready',
          items: result.items.map(item => ({ ...item, sessionId: localSessionId(item.sessionId) })),
          hasMore: result.hasMore,
        },
      }
      this.publish()
      return
    }
    if (result.operationId === this.#searchOperationId && result.type === 'operation-failed') {
      this.#snapshot = {
        ...this.#snapshot,
        search: {
          query: this.#snapshot.search.query,
          status: 'error',
          items: this.#snapshot.search.items,
          hasMore: this.#snapshot.search.hasMore,
          error: result.failure,
        },
      }
      this.publish()
      return
    }
    const operation = this.#operations.get(result.operationId)
    if (operation !== undefined && (result.type === 'confirmed' || result.type === 'operation-failed')) {
      this.#operations.delete(result.operationId)
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: result.type === 'operation-failed' && operation.kind !== 'submit'
          ? {
            operationId: result.operationId,
            operation: operation.kind,
            sessionId: operation.sessionId,
            failure: result.failure,
          }
          : operation.kind !== 'submit'
            ? this.failureAfterSuccess(operation.kind, operation.sessionId)
            : this.#snapshot.operationFailure,
      }
      this.publish()
      return
    }
    const history = this.#historyOperations.get(result.operationId)
    if (history !== undefined && result.type === 'operation-failed'
      && this.#historyInFlight.get(history.sessionId)?.operationId === result.operationId) {
      this.#historyOperations.delete(result.operationId)
      this.#historyInFlight.delete(history.sessionId)
      this.setHistoryLoading(history.sessionId, false)
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: {
          operationId: result.operationId,
          operation: 'history',
          sessionId: history.sessionId,
          failure: result.failure,
        },
      }
      this.publish()
      return
    }
    if (result.operationId === this.#refreshOperationId && result.type === 'operation-failed') {
      this.#refreshOperationId = undefined
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: {
          operationId: result.operationId,
          operation: 'refresh',
          failure: result.failure,
        },
      }
      this.publish()
      return
    }
    if (result.operationId !== this.#attachmentOperationId) return
    this.#attachmentOperationId = undefined
    if (result.type === 'confirmed') {
      this.#snapshot = { ...this.#snapshot, attachment: { operationId: result.operationId, status: 'accepted' } }
    } else if (result.type === 'attachment-rejected') {
      this.#snapshot = {
        ...this.#snapshot,
        attachment: {
          operationId: result.operationId,
          status: 'rejected',
          reason: result.reason,
          message: `Desktop rejected the attachment: ${result.reason}`,
        },
      }
    } else if (result.type === 'operation-failed') {
      this.#snapshot = {
        ...this.#snapshot,
        attachment: { operationId: result.operationId, status: 'failed', message: result.failure.message },
      }
    } else if (result.type === 'status') {
      this.#snapshot = {
        ...this.#snapshot,
        attachment: {
          operationId: result.operationId,
          status: 'failed',
          message: 'Desktop reports that the attachment was not submitted.',
        },
      }
    } else {
      return
    }
    this.publish()
  }

  private transmit<T>(
    kind: CompanionMutationName,
    send: (channel: MobileCompanionConnectionChannel) => T,
  ): T {
    const active = this.requireActive(kind)
    return send(active.channel)
  }

  private acceptCurrentCompanionProjection(
    projection: ValidatedCompanionProjectionReceipt,
  ): boolean {
    if (projection.type === 'surface-snapshot') {
      if (projection.operationId !== this.#refreshOperationId) return false
      this.#refreshOperationId = undefined
      this.#snapshot = { ...this.#snapshot, operationFailure: this.failureAfterSuccess('refresh') }
      return true
    }
    const pending = this.#historyOperations.get(projection.operationId)
    if (pending === undefined || localSessionId(projection.sessionId) !== pending.sessionId
      || projection.beforeSeq !== pending.beforeSeq
      || this.#historyInFlight.get(pending.sessionId)?.operationId !== projection.operationId) return false
    this.#historyOperations.delete(projection.operationId)
    this.#historyInFlight.delete(pending.sessionId)
    this.setHistoryLoading(pending.sessionId, false)
    this.#snapshot = {
      ...this.#snapshot,
      operationFailure: this.failureAfterSuccess('history', pending.sessionId),
    }
    return true
  }

  private failureAfterSuccess(
    operation: MobileCompanionOperationFailure['operation'],
    sessionId?: SessionId,
  ): MobileCompanionOperationFailure | undefined {
    const failure = this.#snapshot.operationFailure
    return failure?.operation === operation && failure.sessionId === sessionId ? undefined : failure
  }

  private registerHistory(
    sessionId: SessionId,
    beforeSeq: number | undefined,
    submission: MobileCompanionTrackedSubmission,
  ): void {
    if (this.#historyInFlight.has(sessionId)) {
      void submission.completion.catch(() => {})
      return
    }
    const pending = { operationId: submission.operationId, sessionId, beforeSeq }
    this.#historyOperations.set(submission.operationId, pending)
    this.#historyInFlight.set(sessionId, pending)
    this.setHistoryLoading(sessionId, true)
    this.publish()
    void submission.completion.catch(() => {
      if (this.#historyInFlight.get(sessionId)?.operationId !== submission.operationId) return
      this.#historyOperations.delete(submission.operationId)
      this.#historyInFlight.delete(sessionId)
      this.setHistoryLoading(sessionId, false)
      this.#snapshot = {
        ...this.#snapshot,
        operationFailure: this.sendFailure('history', submission.operationId, sessionId),
      }
      this.publish()
    })
  }

  private sendFailure(
    operation: MobileCompanionOperationFailure['operation'],
    operationId: CompanionOperationId,
    sessionId?: SessionId,
  ): MobileCompanionOperationFailure {
    return { operationId, operation, sessionId, failure: companionSendFailure() }
  }

  private setHistoryLoading(sessionId: SessionId, loadingOlder: boolean): void {
    const conversation = this.#snapshot.conversations[sessionId]
    if (conversation === undefined || conversation.loadingOlder === loadingOlder) return
    this.#snapshot = {
      ...this.#snapshot,
      conversations: {
        ...this.#snapshot.conversations,
        [sessionId]: { ...conversation, loadingOlder },
      },
    }
  }

  private requireActive(kind: CompanionMutationName): ActiveConnection {
    requireCompanionMutation(this.#runtime.getState(), kind)
    if (this.#activeConnection === undefined) {
      throw new Error('Companion authenticated connection channel is unavailable')
    }
    return this.#activeConnection
  }

  private async settlePending(
    expected: ActiveConnection,
    settlement: MobilePendingSettlement,
  ): Promise<MobilePendingSettlementReceipt> {
    const active = this.requireActive(settlement.kind)
    if (active.token !== expected.token) {
      throw new Error('Companion pending interaction belongs to a stale connection generation')
    }
    const receipt = await active.channel.mutations.settle(settlement)
    if (this.#activeConnection?.token !== expected.token || !companionMayMutate(this.#runtime.getState())) {
      throw new Error('Companion pending interaction belongs to a stale connection generation')
    }
    return receipt
  }

  private publish(): void {
    const errors: unknown[] = []
    for (const listener of [...this.#listeners]) {
      try { listener() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) {
      console.error('[companion-surface] subscriber failures:', new AggregateError(errors))
    }
  }
}

function emptySurfaceSnapshot(): MobileCompanionSurfaceSnapshot {
  return {
    sessions: {
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    },
    workspaces: [], conversations: {},
    search: { query: '', status: 'idle', items: [], hasMore: false },
    attachment: { status: 'idle' },
  }
}

function companionSendFailure(): CompanionHostFailure {
  return {
    kind: 'business',
    code: 'companion-send-failed',
    message: 'Companion encrypted operation could not be sent',
  }
}

function localSessionId(value: CompanionSessionId): SessionId {
  return value as unknown as SessionId
}

function oldestNodeSeq(conversation: ConversationSnapshot): number | undefined {
  let oldest: number | undefined
  for (const node of conversation.nodes) {
    if (!Number.isSafeInteger(node.seq) || node.seq < 0) continue
    if (oldest === undefined || node.seq < oldest) oldest = node.seq
  }
  return oldest
}

function recoveredFailureOperation(
  kind: CompanionOperationReceipt['kind'],
): MobileCompanionOperationFailure['operation'] | undefined {
  if (kind === 'session-create') return 'create'
  if (kind === 'prompt') return 'prompt'
  if (kind === 'cancel') return 'cancel'
  if (kind === 'approval' || kind === 'question') return 'interaction'
  return undefined
}
