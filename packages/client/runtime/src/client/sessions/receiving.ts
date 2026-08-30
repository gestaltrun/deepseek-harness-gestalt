/** Host-snapshot adapter for model-silent member-question receiving Sessions. */
import type {
  IApiClient, MemberQuestionReceiverSnapshot, RpcId, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionFace } from '../contract/session.ts'
import type { ConversationSnapshot, MemberQuestionRecordView } from './conversation.ts'
import { EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS } from './conversation.ts'
import { PendingWait } from './pending.ts'
import { ProjectionValueStore } from './projection-store.ts'

/** Carried presentation intent for a routed member question. */
export type MemberQuestionIntent = Extract<
  NonNullable<AskUserQuestionItem['intent']>,
  { kind: 'member-question' }
>

/** Client presentation states projected from Host terminal records. */
export type ReceivingMemberQuestionState =
  | 'pending' | 'answered' | 'answered-elsewhere' | 'declined'
  | 'expired' | 'withdrawn' | 'superseded'

/** Host-projected terminal record band. */
export type ReceivingMemberQuestionRecord = MemberQuestionRecordView

/** One Host-owned receiving Session projection. */
export interface ReceivingSessionRow {
  readonly sessionId: SessionId
  readonly title: string
  readonly updatedAt: number
  readonly revision: number
  readonly active: {
    readonly questionId: string
    readonly intent: MemberQuestionIntent
    readonly wait: PendingWait<'question'>
  } | undefined
  readonly records: readonly ReceivingMemberQuestionRecord[]
}

/** Client-only identity used to derive answered-elsewhere presentation. */
export interface ReceivingQuestionBookOptions {
  readonly currentInstallationId?: string
}

const EMPTY: readonly never[] = []

class ReceivingSessionFace implements SessionFace {
  readonly projections = new ProjectionValueStore()
  readonly #listeners = new Set<() => void>()
  #snapshot: ConversationSnapshot

  constructor(readonly sessionId: SessionId) {
    this.#snapshot = this.buildSnapshot(undefined, EMPTY)
  }

  getSnapshot(): ConversationSnapshot { return this.#snapshot }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  publish(wait: PendingWait<'question'> | undefined, records: readonly ReceivingMemberQuestionRecord[]): void {
    if (this.#snapshot.pending[0] === wait && this.#snapshot.memberQuestionRecords === records) return
    this.#snapshot = this.buildSnapshot(wait, records)
    for (const listener of [...this.#listeners]) {
      try { listener() } catch (error) { console.error('receiving session subscriber failed:', error) }
    }
  }

  prompt(..._args: Parameters<SessionFace['prompt']>): ReturnType<SessionFace['prompt']> { return this.unroutable('prompt') }
  readAttachment(..._args: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> { return this.unroutable('attachment read') }
  updateQueue(..._args: Parameters<SessionFace['updateQueue']>): ReturnType<SessionFace['updateQueue']> { return this.unroutable('queue mutation') }
  cancel(..._args: Parameters<SessionFace['cancel']>): ReturnType<SessionFace['cancel']> { return this.unroutable('turn cancellation') }
  rename(..._args: Parameters<SessionFace['rename']>): ReturnType<SessionFace['rename']> { return this.unroutable('rename') }
  loadOlder(..._args: Parameters<SessionFace['loadOlder']>): ReturnType<SessionFace['loadOlder']> { return this.unroutable('history') }
  command(..._args: Parameters<SessionFace['command']>): ReturnType<SessionFace['command']> { return this.unroutable('command') }

  private unroutable(operation: string): Promise<never> {
    return Promise.reject(new Error(`receiving session ${this.sessionId} has no ${operation} route`))
  }

  private buildSnapshot(
    wait: PendingWait<'question'> | undefined,
    records: readonly ReceivingMemberQuestionRecord[],
  ): ConversationSnapshot {
    const legacy = EMPTY_CHAT_SNAPSHOT.legacy
    return {
      sessionId: this.sessionId,
      views: EMPTY_CONVERSATION_VIEWS,
      chat: EMPTY_CHAT_SNAPSHOT,
      nodes: legacy.nodes,
      turnTimings: legacy.turnTimings,
      turnEnds: legacy.turnEnds,
      partial: null,
      runningCalls: legacy.runningCalls,
      pending: wait === undefined ? EMPTY : [wait],
      queue: EMPTY,
      running: false,
      subagent: null,
      composerPhase: 'disabled',
      memberQuestionRecords: records,
      removed: false,
      openState: 'open',
      openError: null,
      hasMore: false,
      loadingOlder: false,
      promptError: null,
      blank: false,
      lastAgentError: null,
    }
  }
}

/**
 * Build the receiving row title from the Host brief origin.
 * @param origin - carried project and source-Session identity.
 * @returns the visible source line.
 */
export function briefSourceLine(origin: MemberQuestionIntent['origin']): string {
  return `${origin.projectName} — ${origin.originSessionTitle}`
}

/**
 * Read one shared member-question intent from a complete question batch.
 * @param questions - questions expected to carry one identical intent.
 * @returns the shared intent, or undefined for a mixed or generic batch.
 */
export function memberQuestionIntentOf(
  questions: readonly AskUserQuestionItem[],
): MemberQuestionIntent | undefined {
  const first = questions[0]?.intent
  if (first?.kind !== 'member-question') return undefined
  const shared = JSON.stringify(first)
  return questions.slice(1).some(question => JSON.stringify(question.intent) !== shared) ? undefined : first
}

/** Project one authoritative Host snapshot into stable renderer Session faces. */
export class ReceivingQuestionBook {
  readonly #api: IApiClient
  readonly #onChange: () => void
  #currentInstallationId: string | undefined
  readonly #rows = new Map<SessionId, ReceivingSessionRow>()
  readonly #faces = new Map<SessionId, ReceivingSessionFace>()
  #revision = -1

  constructor(
    api: IApiClient,
    options: ReceivingQuestionBookOptions & { onChange?: () => void } = {},
  ) {
    this.#api = api
    this.#onChange = options.onChange ?? (() => {})
    this.#currentInstallationId = options.currentInstallationId
  }

  /**
   * List the current Host-projected receiving rows.
   * @returns the receiving rows.
   */
  rows(): readonly ReceivingSessionRow[] { return [...this.#rows.values()] }
  /**
   * Resolve the renderer face for one Host receiving identity.
   * @param sessionId - persisted Host receiving Session id.
   * @returns the renderer-only face when the Host projection contains it.
   */
  face(sessionId: SessionId): SessionFace | undefined { return this.#faces.get(sessionId) }

  /**
   * Replace browser state from one higher-revision complete Host projection.
   * @param snapshot - complete committed receiver projection.
   * @param currentInstallationId - authenticated Client Installation used only for answered-elsewhere display.
   */
  applySnapshot(snapshot: MemberQuestionReceiverSnapshot, currentInstallationId?: string): void {
    if (snapshot.revision <= this.#revision) return
    if (currentInstallationId !== undefined) this.#currentInstallationId = currentInstallationId
    this.#revision = snapshot.revision
    const sessionIds = new Set<SessionId>()
    const groups = new Map<SessionId, {
      pending: MemberQuestionReceiverSnapshot['pending'][number] | undefined
      terminal: MemberQuestionReceiverSnapshot['terminal']
    }>()
    for (const pending of snapshot.pending) {
      const sessionId = pending.receivingSessionId as unknown as SessionId
      sessionIds.add(sessionId)
      groups.set(sessionId, { pending, terminal: [] })
    }
    for (const terminal of snapshot.terminal) {
      const sessionId = terminal.receivingSessionId as unknown as SessionId
      sessionIds.add(sessionId)
      const group = groups.get(sessionId) ?? { pending: undefined, terminal: [] }
      group.terminal = [...group.terminal, terminal]
      groups.set(sessionId, group)
    }
    for (const [sessionId, group] of groups) this.projectGroup(sessionId, group)
    for (const sessionId of [...this.#rows.keys()]) {
      if (sessionIds.has(sessionId)) continue
      this.#rows.get(sessionId)?.active?.wait.markSettled()
      this.#rows.delete(sessionId)
      this.#faces.delete(sessionId)
    }
    this.#onChange()
  }

  /** Disconnect changes no business state; the next Host baseline converges by revision. */
  handleDisconnected(): void {}

  /** Release all renderer carriers and projected rows. */
  dispose(): void {
    for (const row of this.#rows.values()) row.active?.wait.markSettled()
    this.#rows.clear()
    this.#faces.clear()
  }

  private projectGroup(
    sessionId: SessionId,
    group: {
      pending: MemberQuestionReceiverSnapshot['pending'][number] | undefined
      terminal: MemberQuestionReceiverSnapshot['terminal']
    },
  ): void {
    const exemplar = group.pending?.operation ?? group.terminal.at(-1)?.brief
    if (exemplar === undefined) return
    const accountId = group.pending?.receivingAccountId ?? group.terminal[0]?.receivingAccountId
    if (accountId === undefined) return
    const records = group.terminal.map((view): ReceivingMemberQuestionRecord => {
      const terminal = view.terminal
      const state = terminal.outcome === 'answered'
        && this.#currentInstallationId !== undefined
        && terminal.settledByInstallationId !== this.#currentInstallationId
        ? 'answered-elsewhere'
        : terminal.outcome
      return {
        questionId: view.questionId,
        state,
        askedAt: view.arrivedAt,
        terminalAt: terminal.settledAt,
        intent: intentOf(view.brief, view.receivingAccountId),
        ...(terminal.outcome === 'answered' || terminal.outcome === 'declined'
          ? { settledByDeviceName: terminal.settledByDeviceName }
          : {}),
      }
    })
    const pending = group.pending
    const active = pending === undefined ? undefined : {
      questionId: pending.questionId,
      intent: intentOf(pending.operation, pending.receivingAccountId),
      wait: this.waitFor(pending),
    }
    this.#rows.get(sessionId)?.active?.wait.markSettled()
    const updatedAt = Math.max(pending?.arrivedAt ?? 0, ...records.map(record => record.terminalAt))
    const revision = Math.max(pending?.revision ?? 0, ...group.terminal.map(record => record.revision))
    const row: ReceivingSessionRow = {
      sessionId,
      title: briefSourceLine(intentOf(exemplar, accountId).origin),
      updatedAt,
      revision,
      active,
      records,
    }
    this.#rows.set(sessionId, row)
    let face = this.#faces.get(sessionId)
    if (face === undefined) {
      face = new ReceivingSessionFace(sessionId)
      this.#faces.set(sessionId, face)
    }
    face.publish(active?.wait, records)
  }

  private waitFor(pending: MemberQuestionReceiverSnapshot['pending'][number]): PendingWait<'question'> {
    const rpcId = pending.questionId as unknown as RpcId
    const intent = intentOf(pending.operation, pending.receivingAccountId)
    const questions: AskUserQuestionItem[] = pending.operation.questions.map(question => ({
      id: question.id,
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.options === undefined ? {} : { options: question.options.map(option => ({ ...option })) }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
      intent,
    }))
    return new PendingWait(
      'question', rpcId, pending.operation.originSessionId as unknown as SessionId, { questions },
      async (message) => {
        const response = message.result.ok
          ? { kind: 'answered' as const, answers: (message.result.value as {
            answer: { answers: { id: string; selected: string[]; custom?: string }[] }
          }).answer.answers }
          : { kind: 'declined' as const }
        const result = await this.#api.memberQuestions.settle({
          receivingSessionId: pending.receivingSessionId,
          revision: pending.revision,
          questionId: pending.questionId,
          response,
        })
        return result.result.ok
          ? { accepted: true }
          : { accepted: false, reason: result.result.error.code === 'bad-request' ? 'not-pending' : 'bad-response' }
      },
    )
  }
}

function intentOf(
  operation: MemberQuestionReceiverSnapshot['pending'][number]['operation'],
  receivingAccountId: string,
): MemberQuestionIntent {
  return {
    kind: 'member-question',
    questionId: operation.questionId,
    originSessionId: operation.originSessionId,
    toProjectMember: receivingAccountId,
    origin: operation.origin,
    background: operation.background,
    references: operation.references.map(reference => ({ ...reference })),
    expiresAt: operation.expiresAt,
  }
}
