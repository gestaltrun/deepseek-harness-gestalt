// ReceivingQuestionBook: the receiver-side registry of member-question
// sessions. A routed `question/requested` frame whose whole batch declares the
// `member-question` intent lands here instead of a host session: the book
// locates or creates one local receiving session per route key (origin remote
// session + receiving member) and keeps the single-active-card invariant
// (a newer ask supersedes a still-pending older one), the expiry sweep, and
// the terminal record band. Receiving sessions are renderer-only identities —
// no host Session exists, so no agent turn and no local model output can ever
// attach; the conversation mount that renders the Decision Brief is the next
// milestone.

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

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
  rpcId: string
  /** The carried Decision Brief, verbatim. */
  intent: MemberQuestionIntent
  state: ReceivingMemberQuestionState
  /** Arrival instant (book clock). */
  askedAt: number
  /** Terminal instant (book clock); absent while pending. */
  terminalAt?: number
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
  /** rpcId → route key, so a resolved frame finds its record. */
  readonly #byRpcId = new Map<string, string>()
  readonly #clock: () => number

  /**
   * @param receiverMemberId - account reference of the local receiving member
   * (the second half of every route key).
   * @param clock - instant source; inject a fake clock to drive expiry.
   */
  constructor(
    readonly receiverMemberId: string,
    clock: () => number = Date.now,
  ) {
    this.#clock = clock
  }

  /** Current receiving-session rows (snapshot order: arrival order). */
  rows(): readonly ReceivingSessionRow[] {
    return [...this.#rows.values()]
  }

  /**
   * Deliver one requested member-question batch: locate or create the route
   * key's receiving session, supersede a still-pending predecessor, and file
   * the new ask as the single active card.
   * @param rpcId - the requested frame's rpcId.
   * @param questions - the frame's whole batch.
   * @returns The receiving row, or undefined when the batch is not a
   * member-question batch (the generic flow owns it).
   */
  handleRequested(rpcId: string, questions: readonly AskUserQuestionItem[]): ReceivingSessionRow | undefined {
    const intent = memberQuestionIntentOf(questions)
    if (intent === undefined) return undefined
    // Expire before superseding: an ask whose countdown already passed is
    // recorded as expired, never as superseded by a later arrival.
    this.sweep()
    const now = this.#clock()
    const routeKey = `${intent.originSessionId}::${intent.toProjectMember}`
    let row = this.#rows.get(routeKey)
    if (row === undefined) {
      row = {
        sessionId: receivingSessionId(routeKey),
        routeKey,
        title: briefSourceLine(intent.origin),
        updatedAt: now,
        active: undefined,
        records: [],
      }
      this.#rows.set(routeKey, row)
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
    }
    row.active = record
    row.updatedAt = now
    this.#byRpcId.set(rpcId, routeKey)
    return row
  }

  /**
   * Settle one routed ask by its resolved frame: `answered` closes the card as
   * answered here, `cancelled` (the sender's withdrawal or a turn abort on the
   * asking side) propagates as withdrawn.
   * @param questionRpcId - the resolved frame's correlation rpcId.
   * @param outcome - the resolved frame's outcome.
   */
  handleResolved(questionRpcId: string, outcome: 'answered' | 'cancelled'): void {
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
  decline(questionRpcId: string): void {
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
  sessionOfRpc(rpcId: string): SessionId | undefined {
    const routeKey = this.#byRpcId.get(rpcId)
    return routeKey === undefined ? undefined : this.#rows.get(routeKey)?.sessionId
  }

  /**
   * Countdown sweep: flip every active card whose `expiresAt` has passed to
   * the expired terminal state (both endpoints derive the same flip from the
   * same carried instant). Idempotent; called before every delivery and
   * observable through the manager's snapshot rebuilds.
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
    if (row === undefined) return
    if (row.active === record) row.active = undefined
    if (!row.records.includes(record)) row.records = [...row.records, record]
    row.updatedAt = at
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
