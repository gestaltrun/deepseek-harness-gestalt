/** Product-owned Mobile projection of authenticated Desktop Companion state. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConversationSnapshot, SessionId, SessionListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CompanionAttachmentRejectedResult,
  CompanionHostFailure,
  CompanionOperationId,
  CompanionResult,
  CompanionSessionSearchItem,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionAttachmentDeliveryUncertainError } from './companion-attachment.ts'
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

/** Receiver installed beside one authenticated decoder generation. */
export interface ValidatedDesktopSurfaceResyncReceiver {
  /** @param message - decoded projection authenticated for this receiver's physical connection. */
  acceptValidatedDesktopResync(message: ValidatedDesktopSurfaceResync): void
}

/** Result receiver owned by one authenticated physical connection generation. */
export interface ValidatedCompanionResultReceiver {
  /** @param result - validated result decoded by the connection that owns this receiver. */
  acceptValidatedCompanionResult(result: CompanionResult): void
}

/** Desktop-authoritative search state; Mobile never synthesizes substring hits. */
export type MobileCompanionSearchSnapshot =
  | { readonly query: ''; readonly status: 'idle'; readonly items: readonly []; readonly hasMore: false }
  | {
    readonly query: string
    readonly status: 'loading' | 'ready'
    readonly items: readonly CompanionSessionSearchItem[]
    readonly hasMore: boolean
  }
  | {
    readonly query: string
    readonly status: 'error'
    readonly items: readonly CompanionSessionSearchItem[]
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
}

/** One selected-file transfer started by the encrypted Companion channel. */
interface MobileCompanionAttachmentSubmission {
  readonly operationId: CompanionOperationId
  readonly completion: Promise<void>
}

/** Encrypted mutations owned by one authenticated physical connection. */
export interface MobileCompanionMutationChannel {
  create(input: { workspace?: string }): void
  submit(sessionId: string, text: string): void
  cancel(sessionId: string): void
  attach(sessionId: string, file: File): MobileCompanionAttachmentSubmission
  search(query: string): CompanionOperationId
  loadOlder(sessionId: string): void
  settle(settlement: MobilePendingSettlement): Promise<MobilePendingSettlementReceipt>
}

/** Authenticated content reads owned by one physical connection. */
export interface MobileCompanionContentChannel {
  loadImage(sessionId: string, attachment: ImageAttachmentRef): Promise<string>
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

/** Generation-bound Desktop projection plus fail-closed Mobile callbacks. */
export class MobileCompanionSurface {
  readonly #runtime: CompanionForegroundRuntime
  readonly #listeners = new Set<() => void>()
  #activeConnection: ActiveConnection | undefined
  #snapshot: MobileCompanionSurfaceSnapshot = {
    sessions: {
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    },
    workspaces: [],
    conversations: {},
    search: { query: '', status: 'idle', items: [], hasMore: false },
    attachment: { status: 'idle' },
  }
  #searchOperationId: CompanionOperationId | undefined
  #attachmentOperationId: CompanionOperationId | undefined

  /** @param runtime - current physical-connection synchronization authority. */
  constructor(runtime: CompanionForegroundRuntime) { this.#runtime = runtime }

  /** @returns the last authenticated Desktop projection. */
  getSnapshot(): MobileCompanionSurfaceSnapshot { return this.#snapshot }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
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
        const previousSnapshot = this.#snapshot
        this.#activeConnection = active
        this.#snapshot = {
          ...projection,
          search: previousSnapshot.search,
          attachment: previousSnapshot.attachment,
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
        this.publish()
      },
    }
  }

  readonly create = (input: { workspace?: string }): void => {
    this.transmit('session-create', (channel) => { channel.mutations.create(input) })
  }

  readonly submit = (sessionId: string, text: string): void => {
    this.transmit('prompt', (channel) => { channel.mutations.submit(sessionId, text) })
  }

  readonly cancel = (sessionId: string): void => {
    this.transmit('cancel', (channel) => { channel.mutations.cancel(sessionId) })
  }

  readonly attach = (sessionId: string, file: File): void => {
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
    this.#searchOperationId = this.transmit('other-mutation', channel => channel.mutations.search(trimmed))
    this.#snapshot = {
      ...this.#snapshot,
      search: { query: trimmed, status: 'loading', items: [], hasMore: false },
    }
    this.publish()
  }

  readonly loadOlder = (sessionId: string): void => {
    this.transmit('history', (channel) => { channel.mutations.loadOlder(sessionId) })
  }

  readonly loadImage = async (sessionId: string, attachment: ImageAttachmentRef): Promise<string> => {
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

  private acceptCurrentCompanionResult(result: CompanionResult): void {
    if (result.operationId === this.#searchOperationId && result.type === 'session-search') {
      this.#snapshot = {
        ...this.#snapshot,
        search: {
          query: this.#snapshot.search.query,
          status: 'ready',
          items: result.items.map(item => ({ ...item })),
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
      this.#snapshot = 'absent' in result
        ? {
          ...this.#snapshot,
          attachment: {
            operationId: result.operationId,
            status: 'failed',
            message: 'Desktop reports that the attachment was not submitted.',
          },
        }
        : { ...this.#snapshot, attachment: { operationId: result.operationId, status: 'accepted' } }
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
