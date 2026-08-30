// ReceivingQuestionBook owns the renderer-only SessionFace and interaction
// lifetime for every member-question route. No Host Session exists on this
// path, so its snapshot contains only the pending question carrier and its
// terminal record never acquires chat, queue, history, or model authority.

import type {
  ClientResponse, RpcId, RpcReceipt, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionFace } from '../contract/session.ts'
import type { ConversationSnapshot } from './conversation.ts'
import { EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS } from './conversation.ts'
import { PendingWait } from './pending.ts'
import { ProjectionValueStore } from './projection-store.ts'

/** The member-question intent as it rides the accepted wire frame. */
export type MemberQuestionIntent = Extract<
  NonNullable<AskUserQuestionItem['intent']>,
  { kind: 'member-question' }
>

/**
 * Receiver-side lifecycle state of one routed member question. `superseded`
 * and `expired` are derived locally (route-key replacement and the countdown
 * sweep); `answered-elsewhere` marks a settlement the receiving install did
 * not produce (the member answered on another device).
 */
export type ReceivingMemberQuestionState =
  | 'pending'
  | 'answered'
  | 'answered-elsewhere'
  | 'declined'
  | 'expired'
  | 'withdrawn'
  | 'superseded'

/** One routed member question tracked on its receiving session. */
export interface ReceivingMemberQuestionRecord {
  /** Branded question identity from the intent. */
  questionId: string
  /** The requested frame's rpcId — the withdrawal/cancellation correlation key. */
  rpcId: RpcId
  /** The carried Decision Brief, verbatim. */
  intent: MemberQuestionIntent
  state: ReceivingMemberQuestionState
  /** Arrival instant (book clock). */
  askedAt: number
  /** Terminal instant (book clock); absent while pending. */
  terminalAt?: number
  /** The one response carrier rendered while this record is pending. */
  wait: PendingWait<'question'>
}

/** One receiving session: all routed asks of one route key, newest activity last. */
export interface ReceivingSessionRow {
  /** Deterministic renderer-only session id derived from the route key. */
  sessionId: SessionId
  /** `<originSessionId>::<toProjectMember>` — the supersede route key. */
  routeKey: string
  /** List title: the brief's first source line. */
  title: string
  /** Last state change (book clock). */
  updatedAt: number
  /** The single pending card, if any; every other record is terminal. */
  active: ReceivingMemberQuestionRecord | undefined
  /** Terminal records in arrival order (oldest first) — the record band. */
  records: ReceivingMemberQuestionRecord[]
}

/** Injectable timeout seat used to drive the earliest pending expiry. */
export interface ReceivingQuestionTimer {
  /**
   * Schedule one callback after the non-negative delay.
   * @param callback - expiry callback.
   * @param delayMs - non-negative delay in milliseconds.
   * @returns Opaque timer handle accepted by {@link ReceivingQuestionTimer.clear}.
   */
  set(callback: () => void, delayMs: number): unknown
  /**
   * Cancel one previously scheduled callback.
   * @param handle - value returned by {@link ReceivingQuestionTimer.set}.
   */
  clear(handle: unknown): void
}

/** Construction options for the receiver-side registry. */
export interface ReceivingQuestionBookOptions {
  /** Account reference of the local receiving member. */
  receiverMemberId?: string
  /** Instant source paired with the timer seat. */
  clock?: () => number
  /** Timeout implementation; production uses the platform timer. */
  timer?: ReceivingQuestionTimer
  /** Publish list-level changes caused without a wire frame, such as expiry. */
  onChange?: () => void
}

const SYSTEM_TIMER: ReceivingQuestionTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

const EMPTY: readonly never[] = []

/** Renderer-only session implementation owned by one receiving row. */
class ReceivingSessionFace implements SessionFace {
  readonly projections = new ProjectionValueStore()
  readonly #listeners = new Set<() => void>()
  #snapshot: ConversationSnapshot

  constructor(readonly sessionId: SessionId) {
    this.#snapshot = this.buildSnapshot(undefined)
  }

  getSnapshot(): ConversationSnapshot {
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Publish the current single pending wait while preserving its identity. */
  publish(wait: PendingWait<'question'> | undefined): void {
    if (this.#snapshot.pending[0] === wait) return
    this.#snapshot = this.buildSnapshot(wait)
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('receiving session subscriber failed:', error)
      }
    }
  }

  prompt(..._args: Parameters<SessionFace['prompt']>): ReturnType<SessionFace['prompt']> {
    return this.unroutable('prompt')
  }

  readAttachment(..._args: Parameters<SessionFace['readAttachment']>): ReturnType<SessionFace['readAttachment']> {
    return this.unroutable('attachment read')
  }

  updateQueue(..._args: Parameters<SessionFace['updateQueue']>): ReturnType<SessionFace['updateQueue']> {
    return this.unroutable('queue mutation')
  }

  cancel(..._args: Parameters<SessionFace['cancel']>): ReturnType<SessionFace['cancel']> {
    return this.unroutable('turn cancellation')
  }

  rename(..._args: Parameters<SessionFace['rename']>): ReturnType<SessionFace['rename']> {
    return this.unroutable('rename')
  }

  loadOlder(..._args: Parameters<SessionFace['loadOlder']>): ReturnType<SessionFace['loadOlder']> {
    return this.unroutable('history')
  }

  command(..._args: Parameters<SessionFace['command']>): ReturnType<SessionFace['command']> {
    return this.unroutable('command')
  }

  private unroutable(operation: string): Promise<never> {
    return Promise.reject(new Error(`receiving session ${this.sessionId} has no ${operation} route`))
  }

  private buildSnapshot(wait: PendingWait<'question'> | undefined): ConversationSnapshot {
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
      composerPhase: 'active',
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
 * The brief's first source line: where the ask came from, rendered as the
 * receiving session's title.
 * @param origin - the carried origin identity.
 * @returns `"<project> — <origin session title>"`.
 */
export function briefSourceLine(origin: MemberQuestionIntent['origin']): string {
  return `${origin.projectName} — ${origin.originSessionTitle}`
}

/**
 * Whether a request batch is a member-question batch and which intent carries
 * it: every question must declare the intent, and the batch must agree on one
 * brief — the banner and the receiving session are per-request, so a mixed or
 * conflicting batch stays with the generic flow (it is still wire-accepted).
 * @param questions - the requested frame's whole batch.
 * @returns The shared member-question intent, or undefined.
 */
export function memberQuestionIntentOf(
  questions: readonly AskUserQuestionItem[],
): MemberQuestionIntent | undefined {
  const first = questions[0]?.intent
  if (first?.kind !== 'member-question') return undefined
  // Batch agreement is by value: wire parses mint one intent object per
  // question, so reference equality would reject a legitimate batch.
  const shared = JSON.stringify(first)
  const rest = questions.slice(1)
  if (rest.some(question => JSON.stringify(question.intent) !== shared)) return undefined
  return first
}

/**
 * Receiver-side registry of member-question sessions (see the module doc).
 * All instants come from the injected clock so tests drive expiry with a fake
 * clock; production uses `Date.now`.
 */
export class ReceivingQuestionBook {
  readonly #rows = new Map<string, ReceivingSessionRow>()
  readonly #faces = new Map<SessionId, ReceivingSessionFace>()
  /** rpcId → route key, so a resolved frame finds its record. */
  readonly #byRpcId = new Map<RpcId, string>()
  readonly #clock: () => number
  readonly #timer: ReceivingQuestionTimer
  readonly #respond: (message: ClientResponse) => Promise<RpcReceipt>
  readonly #onChange: () => void
  #timerHandle: unknown
  #timerScheduled = false
  #timerDeadline: number | undefined
  /** Account reference used as the receiving half of every route key. */
  readonly receiverMemberId: string

  /**
   * @param respond - response carrier used by every minted question wait.
   * @param options - receiving identity, clock, timeout seat, and publication callback.
   */
  constructor(
    respond: (message: ClientResponse) => Promise<RpcReceipt>,
    options: ReceivingQuestionBookOptions = {},
  ) {
    this.receiverMemberId = options.receiverMemberId ?? 'self'
    this.#clock = options.clock ?? Date.now
    this.#timer = options.timer ?? SYSTEM_TIMER
    this.#respond = respond
    this.#onChange = options.onChange ?? (() => {})
  }

  /**
   * Current receiving-session rows (snapshot order: arrival order).
   * @returns the rows snapshot in arrival order.
   */
  rows(): readonly ReceivingSessionRow[] {
    return [...this.#rows.values()]
  }

  /**
   * Resolve the renderer-only face for one receiving Session identity.
   * @param sessionId - possible receiving Session id.
   * @returns The identity-stable face, or undefined for an ordinary Session.
   */
  face(sessionId: SessionId): SessionFace | undefined {
    return this.#faces.get(sessionId)
  }

  /**
   * Retire response carriers from a dead connection generation without
   * inventing a terminal business outcome. A replay may mint fresh carriers
   * for requests the next generation still reports as pending.
   */
  resetPending(): void {
    let changed = false
    for (const row of this.#rows.values()) {
      if (row.active === undefined) continue
      row.active.wait.markSettled()
      row.active = undefined
      this.#faces.get(row.sessionId)?.publish(undefined)
      changed = true
    }
    this.#byRpcId.clear()
    this.#clearTimer()
    if (changed) this.#onChange()
  }

  /** Cancel owned timer work and invalidate every exposed response carrier. */
  dispose(): void {
    this.resetPending()
  }

  /**
   * Deliver one requested member-question batch: locate or create the route
   * key's receiving session, supersede a still-pending predecessor, and file
   * the new ask as the single active card.
   * @param rpcId - the requested frame's rpcId.
   * @param sourceSessionId - protocol Session id carried by the requested frame.
   * @param questions - the frame's whole batch.
   * @returns The receiving row, or undefined when the batch is not a
   * member-question batch (the generic flow owns it).
   */
  handleRequested(
    rpcId: RpcId,
    sourceSessionId: SessionId,
    questions: readonly AskUserQuestionItem[],
  ): ReceivingSessionRow | undefined {
    const intent = memberQuestionIntentOf(questions)
    if (intent === undefined) return undefined
    // Expire before replay or supersede: a question whose carried deadline
    // passed never regains a pending response carrier on a later delivery.
    this.sweep()
    // Requested-frame replays keep the original response carrier. rpcId is
    // the stable interaction identity across one connection generation.
    const priorRouteKey = this.#byRpcId.get(rpcId)
    const priorRow = priorRouteKey === undefined ? undefined : this.#rows.get(priorRouteKey)
    if (priorRow !== undefined) return priorRow
    const now = this.#clock()
    const routeKey = `${intent.originSessionId}::${intent.toProjectMember}`
    let row = this.#rows.get(routeKey)
    if (row === undefined) {
      const sessionId = receivingSessionId(routeKey)
      row = {
        sessionId,
        routeKey,
        title: briefSourceLine(intent.origin),
        updatedAt: now,
        active: undefined,
        records: [],
      }
      this.#rows.set(routeKey, row)
      this.#faces.set(sessionId, new ReceivingSessionFace(sessionId))
    }
    if (row.active !== undefined) {
      this.#retire(row.active, 'superseded', now)
    }
    const record: ReceivingMemberQuestionRecord = {
      questionId: intent.questionId,
      rpcId,
      intent,
      state: 'pending',
      askedAt: now,
      wait: new PendingWait('question', rpcId, sourceSessionId, { questions: [...questions] }, this.#respond),
    }
    row.active = record
    row.updatedAt = now
    this.#byRpcId.set(rpcId, routeKey)
    this.#faces.get(row.sessionId)?.publish(record.wait)
    this.#scheduleExpiry()
    this.#onChange()
    return row
  }

  /**
   * Settle one routed ask by its resolved frame: `answered` closes the card as
   * answered here, `cancelled` (the sender's withdrawal or a turn abort on the
   * asking side) propagates as withdrawn.
   * @param questionRpcId - the resolved frame's correlation rpcId.
   * @param outcome - the resolved frame's outcome.
   */
  handleResolved(questionRpcId: RpcId, outcome: 'answered' | 'cancelled'): void {
    const routeKey = this.#byRpcId.get(questionRpcId)
    if (routeKey === undefined) return
    const row = this.#rows.get(routeKey)
    if (row?.active?.rpcId !== questionRpcId) return
    this.#retire(row.active, outcome === 'answered' ? 'answered' : 'withdrawn', this.#clock())
  }

  /**
   * Record that one still-pending ask was answered on another device: the
   * local card closes as answered-elsewhere (cross-device settlement relay).
   * @param questionId - the settled question identity.
   */
  markAnsweredElsewhere(questionId: string): void {
    for (const row of this.#rows.values()) {
      if (row.active?.questionId !== questionId) continue
      this.#retire(row.active, 'answered-elsewhere', this.#clock())
      return
    }
  }

  /**
   * Decline one still-pending ask without answering (the receiver's explicit
   * decline of the whole batch).
   * @param questionRpcId - the pending card's rpcId.
   */
  decline(questionRpcId: RpcId): void {
    const routeKey = this.#byRpcId.get(questionRpcId)
    const row = this.#rows.get(routeKey ?? '')
    if (row?.active?.rpcId !== questionRpcId) return
    this.#retire(row.active, 'declined', this.#clock())
  }

  /**
   * Receiving session that currently tracks one requested frame's rpcId.
   * @param rpcId - the requested frame's rpcId.
   * @returns The receiving session id, or undefined for an unknown rpcId.
   */
  sessionOfRpc(rpcId: RpcId): SessionId | undefined {
    const routeKey = this.#byRpcId.get(rpcId)
    return routeKey === undefined ? undefined : this.#rows.get(routeKey)?.sessionId
  }

  /**
   * Flip every active card whose carried deadline has passed. The book's one
   * earliest-deadline timer calls this method; direct calls remain useful for
   * deterministic book tests.
   * @returns Whether any card flipped.
   */
  sweep(): boolean {
    const now = this.#clock()
    let changed = false
    for (const row of this.#rows.values()) {
      const active = row.active
      if (active === undefined || now < active.intent.expiresAt) continue
      this.#retire(active, 'expired', now)
      changed = true
    }
    return changed
  }

  /** Move one pending card to a terminal state and file it on the record band. */
  #retire(record: ReceivingMemberQuestionRecord, state: ReceivingMemberQuestionState, at: number): void {
    const row = this.#rows.get(this.#byRpcId.get(record.rpcId) ?? '')
    record.state = state
    record.terminalAt = at
    record.wait.markSettled()
    if (row === undefined) return
    if (row.active === record) row.active = undefined
    if (!row.records.includes(record)) row.records = [...row.records, record]
    row.updatedAt = at
    this.#faces.get(row.sessionId)?.publish(undefined)
    this.#scheduleExpiry()
    this.#onChange()
  }

  /** Keep exactly one timeout at the earliest pending carried deadline. */
  #scheduleExpiry(): void {
    let earliest: number | undefined
    for (const row of this.#rows.values()) {
      const deadline = row.active?.intent.expiresAt
      if (deadline === undefined || (earliest !== undefined && deadline >= earliest)) continue
      earliest = deadline
    }
    if (earliest === this.#timerDeadline && this.#timerScheduled) return
    this.#clearTimer()
    this.#timerDeadline = earliest
    if (earliest === undefined) return
    const delayMs = Math.min(Math.max(0, earliest - this.#clock()), 2_147_483_647)
    this.#timerHandle = this.#timer.set(() => {
      this.#timerScheduled = false
      this.#timerDeadline = undefined
      if (!this.sweep()) this.#scheduleExpiry()
    }, delayMs)
    this.#timerScheduled = true
  }

  /** Cancel the one scheduled expiry without changing record state. */
  #clearTimer(): void {
    if (this.#timerScheduled) this.#timer.clear(this.#timerHandle)
    this.#timerScheduled = false
    this.#timerDeadline = undefined
  }
}

/**
 * Deterministic receiving-session id for one route key: the same remote ask
 * always locates the same local receiving session, across reconnects and
 * generations, without a host round-trip.
 * @param routeKey - `<originSessionId>::<toProjectMember>`.
 * @returns The renderer-only session id.
 */
export function receivingSessionId(routeKey: string): SessionId {
  return `mq-recv:${routeKey}` as SessionId
}
