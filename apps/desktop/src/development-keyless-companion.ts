/** Host-owned development Companion authority for keyless Desktop. */

import {
  isDevelopmentKeylessSyncCiphertext,
  negotiateDevelopmentCompanionProtocol,
  openDevelopmentCompanionMessage,
  sealDevelopmentCompanionMessage,
} from '@deepseek-ai/dsh-remote-access-client'
import {
  parseCompanionInteractionId,
  parseCompanionTranscriptEntryId,
  type CompanionApprovalTranscriptEntry,
  type CompanionAskUserTranscriptEntry,
  type CompanionConfirmedResult,
  type CompanionImageTranscriptEntry,
  type CompanionMessage,
  type CompanionOperation,
  type CompanionOperationId,
  type CompanionSessionId,
  type CompanionTextTranscriptEntry,
  type CompanionTranscriptEntry,
} from '@deepseek-ai/dsh-remote-protocol'

const DEVELOPMENT_KEYLESS_SYNC_CIPHERTEXT = Uint8Array.of(1)
const IMAGE_FILE_NAME = /\.(avif|gif|heic|jpe?g|png|webp)$/iu

/** Delay before the development assistant and interaction projection. */
export const DEVELOPMENT_COMPANION_STREAM_DELAY_MS = 2_000

interface DevelopmentSession {
  sessionId: CompanionSessionId
  title: string
  workspace?: string
  entries: CompanionTranscriptEntry[]
  streaming: boolean
  pendingPrompt?: string
}

/** Hooks that let Relay deliver delayed development projections. */
export interface DevelopmentKeylessCompanionHooks {
  /** Milliseconds before the assistant projection; `0` completes inside `reply()`. */
  readonly streamDelayMs?: number
  /** Schedule a delayed completion; the returned disposer cancels it. */
  readonly schedule?: (task: () => Promise<void>, delayMs: number) => () => void
  /** Deliver frames after the stream delay to the inbound source attachment. */
  readonly emit?: (frames: readonly Uint8Array[]) => void | Promise<void>
  /** Clock used to reject expired attachment capabilities. */
  readonly now?: () => number
}

/** In-process Desktop authority for development Encrypted Companion operations. */
export class DevelopmentKeylessCompanionAuthority {
  private readonly protocol = negotiateDevelopmentCompanionProtocol()
  private readonly sessions = new Map<string, DevelopmentSession>()
  private readonly committed = new Map<string, CompanionConfirmedResult>()
  private readonly timers = new Map<string, () => void>()
  private entryCount = 0

  /** @param hooks - optional stream delay, scheduler, delayed emit, and clock. */
  constructor(private readonly hooks: DevelopmentKeylessCompanionHooks = {}) {}

  /**
   * Reply to one inbound development frame.
   * @param ciphertext - one-byte sync or a sealed Companion message.
   * @returns outbound frames for the source attachment; empty when the frame cannot be opened.
   */
  async reply(ciphertext: Uint8Array): Promise<readonly Uint8Array[]> {
    if (isDevelopmentKeylessSyncCiphertext(ciphertext)) return [DEVELOPMENT_KEYLESS_SYNC_CIPHERTEXT]
    let message: CompanionMessage
    try {
      message = await openDevelopmentCompanionMessage(this.protocol, ciphertext)
    } catch {
      // Unreviewed development frames that fail AES-GCM or Companion decode must not tear Relay.
      return []
    }
    if (message.type !== 'operation') return []
    const replies = this.handle(message.operation)
    return await Promise.all(replies.map(async reply => await sealDevelopmentCompanionMessage(this.protocol, reply)))
  }

  private handle(operation: CompanionOperation): CompanionMessage[] {
    switch (operation.type) {
      case 'create-session':
        return [this.confirm(this.createSession(operation))]
      case 'submit-prompt': {
        const confirmed = this.confirm(this.submitPrompt(operation))
        return [confirmed, this.transcript(operation.sessionId)]
      }
      case 'cancel-prompt': {
        const confirmed = this.confirm(this.cancelPrompt(operation))
        return [confirmed, this.transcript(operation.sessionId)]
      }
      case 'query-operation-status': {
        const committed = this.committed.get(operation.operationId)
        return [{
          type: 'result',
          result: committed === undefined
            ? { type: 'status', operationId: operation.operationId, absent: true }
            : { type: 'status', operationId: operation.operationId, committed },
        }]
      }
      case 'offer-attachment':
        return this.offerAttachment(operation)
      case 'settle-approval':
        return this.settleInteraction(operation, 'approval')
      case 'answer-ask-user':
        return this.settleInteraction(operation, 'ask-user')
      default: {
        const never: never = operation
        return never
      }
    }
  }

  private createSession(operation: Extract<CompanionOperation, { type: 'create-session' }>): CompanionOperationId {
    const existing = this.committed.get(operation.operationId)
    if (existing !== undefined) return existing.operationId
    if (!this.sessions.has(operation.sessionId)) {
      this.sessions.set(operation.sessionId, {
        sessionId: operation.sessionId,
        title: operation.title,
        ...(operation.workspace === undefined ? {} : { workspace: operation.workspace }),
        entries: [],
        streaming: false,
      })
    }
    return operation.operationId
  }

  private submitPrompt(operation: Extract<CompanionOperation, { type: 'submit-prompt' }>): CompanionOperationId {
    const existing = this.committed.get(operation.operationId)
    if (existing !== undefined) return existing.operationId
    const session = this.sessions.get(operation.sessionId) ?? {
      sessionId: operation.sessionId,
      title: 'Session',
      entries: [],
      streaming: false,
    }
    session.entries = [...session.entries, this.textEntry('user', operation.text)]
    session.pendingPrompt = operation.text
    session.streaming = true
    this.sessions.set(operation.sessionId, session)
    const delay = this.hooks.streamDelayMs ?? 0
    if (delay <= 0) this.finishPrompt(session)
    else this.scheduleFinish(operation.sessionId, delay)
    return operation.operationId
  }

  private cancelPrompt(operation: Extract<CompanionOperation, { type: 'cancel-prompt' }>): CompanionOperationId {
    const existing = this.committed.get(operation.operationId)
    if (existing !== undefined) return existing.operationId
    this.cancelTimer(operation.sessionId)
    const session = this.sessions.get(operation.sessionId)
    if (session !== undefined && session.streaming) {
      session.entries = [...session.entries, this.textEntry('assistant', 'cancelled')]
      session.streaming = false
      session.pendingPrompt = undefined
    }
    return operation.operationId
  }

  private offerAttachment(
    operation: Extract<CompanionOperation, { type: 'offer-attachment' }>,
  ): CompanionMessage[] {
    const existing = this.committed.get(operation.operationId)
    if (existing !== undefined) return [{ type: 'result', result: existing }, this.transcript(operation.sessionId)]
    if (operation.expiresAt <= (this.hooks.now?.() ?? Date.now())) {
      return [{
        type: 'result',
        result: { type: 'attachment-rejected', operationId: operation.operationId, reason: 'expired' },
      }]
    }
    const session = this.requireSession(operation.sessionId)
    session.entries = [
      ...session.entries,
      IMAGE_FILE_NAME.test(operation.fileName)
        ? this.imageEntry(operation.fileName)
        : this.textEntry('user', `Attached: ${operation.fileName}`),
    ]
    return [this.confirm(operation.operationId), this.transcript(operation.sessionId)]
  }

  private settleInteraction(
    operation: Extract<CompanionOperation, { type: 'settle-approval' | 'answer-ask-user' }>,
    kind: 'approval' | 'ask-user',
  ): CompanionMessage[] {
    const existing = this.committed.get(operation.operationId)
    if (existing !== undefined) return [{ type: 'result', result: existing }, this.transcript(operation.sessionId)]
    const session = this.sessions.get(operation.sessionId)
    if (session !== undefined) {
      session.entries = session.entries.map((entry) => {
        if (entry.type !== kind || entry.interactionId !== operation.interactionId) return entry
        if (entry.settled !== undefined) return entry
        if (!entry.authorized.includes(operation.decision)) return entry
        return {
          ...entry,
          settled: {
            decision: operation.decision,
            ...('persistent' in operation
              ? { persistent: operation.persistent }
              : {}),
          },
        }
      })
    }
    return [this.confirm(operation.operationId), this.transcript(operation.sessionId)]
  }

  private requireSession(sessionId: CompanionSessionId): DevelopmentSession {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: DevelopmentSession = {
      sessionId,
      title: 'Session',
      entries: [],
      streaming: false,
    }
    this.sessions.set(sessionId, created)
    return created
  }

  private scheduleFinish(sessionId: CompanionSessionId, delayMs: number): void {
    this.cancelTimer(sessionId)
    const schedule = this.hooks.schedule ?? defaultSchedule
    const cancel = schedule(async () => {
      this.timers.delete(sessionId)
      const session = this.sessions.get(sessionId)
      if (session === undefined || !session.streaming) return
      this.finishPrompt(session)
      const frames = await Promise.all(
        [this.transcript(sessionId)].map(async message => await sealDevelopmentCompanionMessage(this.protocol, message)),
      )
      await this.hooks.emit?.(frames)
    }, delayMs)
    this.timers.set(sessionId, cancel)
  }

  private cancelTimer(sessionId: CompanionSessionId): void {
    this.timers.get(sessionId)?.()
    this.timers.delete(sessionId)
  }

  private finishPrompt(session: DevelopmentSession): void {
    const text = session.pendingPrompt ?? ''
    session.entries = [
      ...session.entries,
      this.textEntry('assistant', `Desktop accepted: ${text}`),
      this.approvalEntry(session.sessionId),
      this.askUserEntry(session.sessionId),
    ]
    session.streaming = false
    session.pendingPrompt = undefined
  }

  private confirm(operationId: CompanionOperationId): CompanionMessage {
    const existing = this.committed.get(operationId)
    if (existing !== undefined) return { type: 'result', result: existing }
    const result: CompanionConfirmedResult = {
      type: 'confirmed',
      operationId,
      committedAt: Date.now(),
      outcome: 'accepted',
    }
    this.committed.set(operationId, result)
    return { type: 'result', result }
  }

  private transcript(sessionId: CompanionSessionId): CompanionMessage {
    const session = this.sessions.get(sessionId)
    return {
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId,
        entries: session?.entries ?? [],
        ...(session?.streaming === true ? { streaming: true } : {}),
      },
    }
  }

  private textEntry(role: 'user' | 'assistant', text: string): CompanionTextTranscriptEntry {
    this.entryCount += 1
    return {
      type: 'text',
      entryId: parseCompanionTranscriptEntryId(`entry-${String(this.entryCount)}`),
      role,
      text,
    }
  }

  private imageEntry(fileName: string): CompanionImageTranscriptEntry {
    this.entryCount += 1
    return {
      type: 'image',
      entryId: parseCompanionTranscriptEntryId(`entry-${String(this.entryCount)}`),
      fileName,
      alt: fileName,
    }
  }

  private approvalEntry(sessionId: CompanionSessionId): CompanionApprovalTranscriptEntry {
    this.entryCount += 1
    return {
      type: 'approval',
      entryId: parseCompanionTranscriptEntryId(`entry-${String(this.entryCount)}`),
      interactionId: parseCompanionInteractionId(`approval-${sessionId}-${String(this.entryCount)}`),
      summary: 'Allow Desktop development action',
      authorized: ['once', 'always'],
    }
  }

  private askUserEntry(sessionId: CompanionSessionId): CompanionAskUserTranscriptEntry {
    this.entryCount += 1
    return {
      type: 'ask-user',
      entryId: parseCompanionTranscriptEntryId(`entry-${String(this.entryCount)}`),
      interactionId: parseCompanionInteractionId(`question-${sessionId}-${String(this.entryCount)}`),
      summary: 'Which Desktop path?',
      authorized: ['A', 'B'],
    }
  }
}

function defaultSchedule(task: () => Promise<void>, delayMs: number): () => void {
  const timer = setTimeout(() => { void task() }, delayMs)
  return () => { clearTimeout(timer) }
}
