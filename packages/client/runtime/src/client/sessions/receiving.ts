/** Host-snapshot adapter for model-silent member-question receiving Sessions. */
import type { IApiClient, MemberQuestionReceiverSnapshot, RpcId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionFace } from '../contract/session.ts'
import type { ConversationSnapshot, MemberQuestionRecordView, PromptError } from './conversation.ts'
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
  readonly materialized: boolean
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
  #pending: MemberQuestionReceiverSnapshot['pending'][number] | undefined
  #promptError: PromptError | null = null
  #host: SessionFace | undefined
  #hostDisposer: (() => void) | undefined
  #promptAdmission: {
    readonly revision: number
    readonly content?: Parameters<SessionFace['prompt']>[0]
    readonly mode: Parameters<SessionFace['prompt']>[1]
    readonly rpcId: RpcId
  } | undefined

  constructor(readonly sessionId: SessionId, private readonly api: IApiClient) {
    this.#snapshot = this.buildSnapshot(undefined, EMPTY)
  }

  getSnapshot(): ConversationSnapshot { return this.#snapshot }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  publish(
    pending: MemberQuestionReceiverSnapshot['pending'][number] | undefined,
    wait: PendingWait<'question'> | undefined,
    records: readonly ReceivingMemberQuestionRecord[],
  ): void {
    if (this.#snapshot.pending[0] === wait && this.#snapshot.memberQuestionRecords === records) return
    this.#pending = pending
    if (pending?.reservedAdmission !== undefined
      && String(this.#promptAdmission?.rpcId) !== pending.reservedAdmission.rpcId) {
      this.#promptAdmission = {
        revision: pending.revision,
        mode: pending.reservedAdmission.mode,
        rpcId: pending.reservedAdmission.rpcId as unknown as RpcId,
      }
    }
    this.#snapshot = this.buildSnapshot(wait, records)
    this.publishChange()
  }

  bindHost(host: SessionFace): void {
    if (this.#host === host) return
    this.#hostDisposer?.()
    this.#host = host
    this.#hostDisposer = host.subscribe(() => {
      this.refreshSnapshot()
    })
    this.refreshSnapshot()
  }

  dispose(): void {
    this.#hostDisposer?.()
    this.#hostDisposer = undefined
    this.#host = undefined
    this.#listeners.clear()
  }

  private publishChange(): void {
    for (const listener of [...this.#listeners]) {
      try { listener() } catch (error) { console.error('receiving session subscriber failed:', error) }
    }
  }

  private refreshSnapshot(): void {
    this.#snapshot = this.buildSnapshot(
      this.#snapshot.pending[0] as PendingWait<'question'> | undefined,
      this.#snapshot.memberQuestionRecords ?? EMPTY,
    )
    this.publishChange()
  }

  async prompt(
    content: Parameters<SessionFace['prompt']>[0],
    mode: Parameters<SessionFace['prompt']>[1],
    signal?: AbortSignal,
  ): ReturnType<SessionFace['prompt']> {
    const pending = this.#pending
    if (pending === undefined || this.#host !== undefined) {
      return this.#host?.prompt(content, mode, signal) ?? this.unroutable('prompt')
    }
    const retained = this.#promptAdmission
    const admission = retained?.revision === pending.revision
      ? { ...retained, content: retained.content ?? structuredClone(content) }
      : {
        revision: pending.revision,
        content: structuredClone(content),
        mode,
        rpcId: crypto.randomUUID() as RpcId,
      }
    this.#promptAdmission = admission
    if (this.#promptError !== null) {
      this.#promptError = null
      this.refreshSnapshot()
    }
    try {
      const response = await this.api.memberQuestions.admitHumanTurn({
        receivingSessionId: pending.receivingSessionId,
        revision: pending.revision,
        content: admission.content,
        mode: admission.mode,
      }, signal, admission.rpcId)
      if (response.result.ok) {
        this.#promptAdmission = undefined
      }
      if (!response.result.ok) {
        this.#promptError = { op: 'send', error: response.result.error }
        this.refreshSnapshot()
      }
      return response.result
    } catch (error: unknown) {
      const failure = {
        ok: false as const,
        error: { code: 'internal' as const, message: String(error), details: {} },
      }
      this.#promptError = { op: 'send', error: failure.error }
      this.refreshSnapshot()
      return failure
    }
  }
  readAttachment(...args: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> { return this.#host?.readAttachment(...args) ?? this.unroutable('attachment read') }
  updateQueue(...args: Parameters<SessionFace['updateQueue']>): ReturnType<SessionFace['updateQueue']> { return this.#host?.updateQueue(...args) ?? this.unroutable('queue mutation') }
  cancel(...args: Parameters<SessionFace['cancel']>): ReturnType<SessionFace['cancel']> { return this.#host?.cancel(...args) ?? this.unroutable('turn cancellation') }
  rename(...args: Parameters<SessionFace['rename']>): ReturnType<SessionFace['rename']> { return this.#host?.rename(...args) ?? this.unroutable('rename') }
  loadOlder(...args: Parameters<SessionFace['loadOlder']>): ReturnType<SessionFace['loadOlder']> { return this.#host?.loadOlder(...args) ?? this.unroutable('history') }
  command(...args: Parameters<SessionFace['command']>): ReturnType<SessionFace['command']> { return this.#host?.command(...args) ?? this.unroutable('command') }

  private unroutable(operation: string): Promise<never> {
    return Promise.reject(new Error(`receiving session ${this.sessionId} has no ${operation} route`))
  }

  private buildSnapshot(
    wait: PendingWait<'question'> | undefined,
    records: readonly ReceivingMemberQuestionRecord[],
  ): ConversationSnapshot {
    const host = this.#host?.getSnapshot()
    const legacy = host?.chat.legacy ?? EMPTY_CHAT_SNAPSHOT.legacy
    return {
      ...host,
      sessionId: this.sessionId,
      views: host?.views ?? EMPTY_CONVERSATION_VIEWS,
      chat: host?.chat ?? EMPTY_CHAT_SNAPSHOT,
      nodes: legacy.nodes,
      turnTimings: legacy.turnTimings,
      turnEnds: legacy.turnEnds,
      partial: null,
      runningCalls: legacy.runningCalls,
      pending: wait === undefined ? EMPTY : [wait],
      queue: host?.queue ?? EMPTY,
      running: host?.running ?? false,
      subagent: host?.subagent ?? null,
      composerPhase: 'active',
      memberQuestionRecords: records,
      removed: false,
      openState: host?.openState ?? 'open',
      openError: host?.openError ?? null,
      hasMore: host?.hasMore ?? false,
      loadingOlder: host?.loadingOlder ?? false,
      promptError: this.#promptError,
      blank: false,
      lastAgentError: host?.lastAgentError ?? null,
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
   * Whether the receiver ledger mapped this identity to an ordinary Host Session.
   * @param sessionId - receiving Session identity.
   * @returns true after authoritative materialization.
   */
  isMaterialized(sessionId: SessionId): boolean { return this.#rows.get(sessionId)?.materialized === true }
  /**
   * Attach the ordinary Host face while retaining receiver pending/record projection.
   * @param sessionId - materialized receiving Session identity.
   * @param host - ordinary Host-backed Session face.
   */
  bindHost(sessionId: SessionId, host: SessionFace): void {
    this.#faces.get(sessionId)?.bindHost(host)
  }

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
      this.#faces.get(sessionId)?.dispose()
      this.#faces.delete(sessionId)
    }
    this.#onChange()
  }

  /** Disconnect changes no business state; the next Host baseline converges by revision. */
  handleDisconnected(): void {}

  /** Release all renderer carriers and projected rows. */
  dispose(): void {
    for (const row of this.#rows.values()) row.active?.wait.markSettled()
    for (const face of this.#faces.values()) face.dispose()
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
    const records = group.terminal.flatMap((view): ReceivingMemberQuestionRecord[] => {
      const terminal = view.terminal
      if (terminal.outcome === 'answered'
        && (this.#currentInstallationId === undefined
          || terminal.settledByInstallationId === this.#currentInstallationId)) {
        return []
      }
      const state = terminal.outcome === 'answered' ? 'answered-elsewhere' : terminal.outcome
      return [{
        questionId: view.questionId,
        state,
        askedAt: view.arrivedAt,
        terminalAt: terminal.settledAt,
        intent: intentOf(view.brief, view.receivingAccountId, view.cachedReferences),
        ...(terminal.outcome === 'answered' || terminal.outcome === 'declined'
          ? { settledByDeviceName: terminal.settledByDeviceName }
          : {}),
      }]
    })
    const pending = group.pending
    const active = pending === undefined ? undefined : {
      questionId: pending.questionId,
      intent: intentOf(pending.operation, pending.receivingAccountId, pending.cachedReferences),
      wait: this.waitFor(pending),
    }
    this.#rows.get(sessionId)?.active?.wait.markSettled()
    const updatedAt = Math.max(pending?.arrivedAt ?? 0, ...records.map(record => record.terminalAt))
    const revision = Math.max(pending?.revision ?? 0, ...group.terminal.map(record => record.revision))
    const row: ReceivingSessionRow = {
      sessionId,
      title: briefSourceLine(intentOf(exemplar, accountId, pending?.cachedReferences).origin),
      updatedAt,
      revision,
      materialized: pending?.hostSessionId !== undefined
        || group.terminal.some(record => record.hostSessionId !== undefined),
      active,
      records,
    }
    this.#rows.set(sessionId, row)
    let face = this.#faces.get(sessionId)
    if (face === undefined) {
      face = new ReceivingSessionFace(sessionId, this.#api)
      this.#faces.set(sessionId, face)
    }
    face.publish(pending, active?.wait, records)
  }

  private waitFor(pending: MemberQuestionReceiverSnapshot['pending'][number]): PendingWait<'question'> {
    const rpcId = pending.questionId as unknown as RpcId
    const intent = intentOf(pending.operation, pending.receivingAccountId, pending.cachedReferences)
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
  cachedReferences?: readonly { path: string; cachedPath: string }[],
): MemberQuestionIntent {
  return {
    kind: 'member-question',
    questionId: operation.questionId,
    originSessionId: operation.originSessionId,
    toProjectMember: receivingAccountId,
    origin: operation.origin,
    background: operation.background,
    references: operation.references.map((reference) => {
      const cached = cachedReferences?.find(entry => entry.path === reference.path)?.cachedPath
      return {
        ...reference,
        ...(cached === undefined ? {} : { cachedPath: cached }),
      }
    }),
    expiresAt: operation.expiresAt,
  }
}
