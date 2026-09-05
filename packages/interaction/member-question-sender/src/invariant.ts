/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-member-question-sender`.
 * @module @deepseek-ai/dsh-member-question-sender/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { MemberQuestionId } from '@deepseek-ai/dsh-remote-protocol'
import type { MemberQuestionLifetimeOutcome } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-member-question-sender'
const LIFETIME_OUTCOMES: readonly MemberQuestionLifetimeOutcome[] = [
  'answered',
  'declined',
  'expired',
  'withdrawn',
  'superseded',
  'offline',
  'revoked',
]

/** Cordis companion plugin name. */
export const name = 'member-question-sender-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

type MemberQuestionTransition =
  | { kind: 'asked'; id: MemberQuestionId }
  | { kind: 'outcome'; id: MemberQuestionId }

interface MemberQuestionTrace {
  pending: Set<MemberQuestionId>
}

/** Validate one member-question event against unmatched asked records. */
function validateMemberQuestionEvent(
  trace: MemberQuestionTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): MemberQuestionTransition | undefined {
  if (event.type === 'member-question/asked') {
    if (event.data.questionId.length === 0) fail('member-question/asked questionId must be non-empty')
    if (trace.pending.has(event.data.questionId)) {
      fail(`member-question/asked repeated open id ${JSON.stringify(event.data.questionId)}`)
    }
    return { kind: 'asked', id: event.data.questionId }
  }
  if (event.type === 'member-question/outcome') {
    if (!trace.pending.has(event.data.questionId)) {
      fail(`member-question/outcome has no matching member-question/asked for id ${JSON.stringify(event.data.questionId)}`)
    }
    if (!LIFETIME_OUTCOMES.includes(event.data.outcome)) {
      fail(`member-question/outcome carries unknown outcome ${JSON.stringify(event.data.outcome)}`)
    }
    return { kind: 'outcome', id: event.data.questionId }
  }
  return undefined
}

/** Apply one accepted ask/outcome transition. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
function applyMemberQuestionTransition(
  pending: Set<MemberQuestionId>,
  transition: MemberQuestionTransition,
): void {
  if (transition.kind === 'asked') pending.add(transition.id)
  else pending.delete(transition.id)
}

/** Install ask/outcome pairing and closed-vocabulary checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, MemberQuestionTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: MemberQuestionTransition }>()
  const seed = (session: Session): MemberQuestionTrace => {
    const trace: MemberQuestionTrace = { pending: new Set() }
    traces.set(session, trace)
    for (const event of session.snapshotEvents()) {
      const transition = validateMemberQuestionEvent(trace, event, fail)
      if (transition === undefined) continue
      applyMemberQuestionTransition(trace.pending, transition)
    }
    return trace
  }
  const traceFor = (session: Session): MemberQuestionTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'member-question/asked' && event.type !== 'member-question/outcome') return
    const candidate = staged.get(event)
    /* v8 ignore next 3 -- internal/dispatch stages every package-owned pair event */
    if (candidate === undefined || candidate.session !== session) {
      return fail('member-question audit event published without pre-commit validation')
    }
    staged.delete(event)
    applyMemberQuestionTransition(traceFor(session).pending, candidate.transition)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const transition = validateMemberQuestionEvent(traceFor(session), event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
