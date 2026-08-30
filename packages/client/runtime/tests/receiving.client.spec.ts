/**
 * Receiving sessions: the receiver-side member-question book — route keys,
 * the single-active-card invariant, expiry and withdrawal propagation — plus
 * the SessionManager wiring that surfaces receiving rows in the list without
 * ever touching a host session (zero local model output).
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  briefSourceLine, memberQuestionIntentOf, receivingSessionId, ReceivingQuestionBook,
} from '../src/client/sessions/receiving.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, fakeRemote } from './fake-api.client.ts'

const intent = {
  kind: 'member-question' as const,
  questionId: 'mq-1',
  originSessionId: 'remote-session-1',
  toProjectMember: 'member-b',
  origin: {
    projectName: 'Atlas',
    originSessionTitle: 'Offboard planning',
    askerAccountId: 'member-a',
    askerRole: 'member' as const,
    askerDisplayName: 'Alice',
    askerAvatarUrl: 'https://example.com/a.png',
  },
  background: 'We are offboarding this member.',
  references: [{ path: 'docs/subsystems/project-membership.md', reason: 'Checklist' }],
  expiresAt: 1_000,
}

function memberQuestion(over: Partial<typeof intent> = {}): AskUserQuestionItem {
  return {
    id: 'member-q', question: 'Remove this member?',
    options: [{ label: 'Remove' }, { label: 'Keep' }],
    intent: { ...intent, ...over },
  }
}

/** A fake clock: a mutable instant the tests advance by hand. */
function fakeClock() {
  let now = 0
  return {
    get now() { return now },
    advance(to: number) { now = to },
  }
}

describe('intent narrowing', () => {
  it('claims a batch only when every question carries the same member-question brief', () => {
    expect(memberQuestionIntentOf([memberQuestion()])).toEqual(intent)
    expect(memberQuestionIntentOf([memberQuestion(), memberQuestion()])).toEqual(intent)
    expect(memberQuestionIntentOf([])).toBeUndefined()
    expect(memberQuestionIntentOf([{ id: 'q', question: 'Q?' }])).toBeUndefined()
    // A conflicting brief (different question identity) stays with the generic flow.
    expect(memberQuestionIntentOf([memberQuestion(), memberQuestion({ questionId: 'mq-2' })])).toBeUndefined()
  })

  it('derives the title source line and the deterministic session id from the brief', () => {
    expect(briefSourceLine(intent.origin)).toBe('Atlas — Offboard planning')
    expect(receivingSessionId('remote-session-1::member-b')).toBe(
      'mq-recv:remote-session-1::member-b' as SessionId,
    )
  })
})

describe('ReceivingQuestionBook', () => {
  it('locates one receiving session per route key with the brief source line as its title', () => {
    const clock = fakeClock()
    const book = new ReceivingQuestionBook('member-b', () => clock.now)
    const row = book.handleRequested('r1', [memberQuestion()])!
    expect(row.sessionId).toBe(receivingSessionId('remote-session-1::member-b'))
    expect(row.routeKey).toBe('remote-session-1::member-b')
    expect(row.title).toBe('Atlas — Offboard planning')
    expect(row.active?.state).toBe('pending')
    // The same remote ask locates the same session again (no duplicate rows).
    const again = book.handleRequested('r2', [memberQuestion({ questionId: 'mq-2' })])
    expect(again!.sessionId).toBe(row.sessionId)
    expect(book.rows()).toHaveLength(1)
  })

  it('keeps a single active card: a new ask supersedes the still-pending predecessor', () => {
    const clock = fakeClock()
    const book = new ReceivingQuestionBook('member-b', () => clock.now)
    const row = book.handleRequested('r1', [memberQuestion()])!
    clock.advance(50)
    book.handleRequested('r2', [memberQuestion({ questionId: 'mq-2' })])
    expect(row.active?.rpcId).toBe('r2')
    expect(row.records.map(record => [record.rpcId, record.state])).toEqual([['r1', 'superseded']])
    expect(row.records[0]?.terminalAt).toBe(50)
  })

  it('does not supersede a predecessor that already reached a terminal state', () => {
    const clock = fakeClock()
    const book = new ReceivingQuestionBook('member-b', () => clock.now)
    const row = book.handleRequested('r1', [memberQuestion()])!
    book.handleResolved('r1', 'answered')
    clock.advance(10)
    book.handleRequested('r2', [memberQuestion({ questionId: 'mq-2' })])
    expect(row.records.map(record => record.state)).toEqual(['answered'])
    expect(row.active?.rpcId).toBe('r2')
  })

  it('propagates a sender cancellation as withdrawn and a decline as declined', () => {
    const clock = fakeClock()
    const book = new ReceivingQuestionBook('member-b', () => clock.now)
    const row = book.handleRequested('r1', [memberQuestion()])!
    book.handleResolved('r1', 'cancelled')
    expect(row.active).toBeUndefined()
    expect(row.records[0]?.state).toBe('withdrawn')
    book.handleRequested('r2', [memberQuestion({ questionId: 'mq-2' })])
    book.decline('r2')
    expect(row.active).toBeUndefined()
    expect(row.records[1]?.state).toBe('declined')
  })

  it('records a cross-device settlement as answered-elsewhere', () => {
    const clock = fakeClock()
    const book = new ReceivingQuestionBook('member-b', () => clock.now)
    const row = book.handleRequested('r1', [memberQuestion()])!
    book.markAnsweredElsewhere('mq-1')
    expect(row.active).toBeUndefined()
    expect(row.records[0]?.state).toBe('answered-elsewhere')
  })

  it('expires the pending card when the countdown passes, on both sweeps and arrivals', () => {
    const clock = fakeClock()
    const book = new ReceivingQuestionBook('member-b', () => clock.now)
    const row = book.handleRequested('r1', [memberQuestion()])!
    // Before the instant nothing flips.
    clock.advance(999)
    expect(book.sweep()).toBe(false)
    expect(row.active?.state).toBe('pending')
    clock.advance(1_000)
    expect(book.sweep()).toBe(true)
    expect(row.active).toBeUndefined()
    expect(row.records[0]?.state).toBe('expired')
    // An arrival after the pass records the new ask as the only pending card.
    book.handleRequested('r2', [memberQuestion({ questionId: 'mq-2', expiresAt: 2_000 })])
    expect(row.records.map(record => record.state)).toEqual(['expired'])
    expect(row.active?.rpcId).toBe('r2')
  })

  it('expires before superseding: a passed ask records expired, not superseded', () => {
    const clock = fakeClock()
    const book = new ReceivingQuestionBook('member-b', () => clock.now)
    const row = book.handleRequested('r1', [memberQuestion()])!
    clock.advance(1_500)
    book.handleRequested('r2', [memberQuestion({ questionId: 'mq-2', expiresAt: 2_500 })])
    expect(row.records.map(record => [record.rpcId, record.state])).toEqual([['r1', 'expired']])
  })

  it('routes different receiving members to different receiving sessions', () => {
    const book = new ReceivingQuestionBook('member-b', () => 0)
    const forB = book.handleRequested('r1', [memberQuestion()])!
    const forC = book.handleRequested('r2', [memberQuestion({
      questionId: 'mq-2', toProjectMember: 'member-c', expiresAt: 5_000,
    })])!
    expect(forB.sessionId).not.toBe(forC.sessionId)
    expect(book.rows()).toHaveLength(2)
  })
})

describe('SessionManager receiving wiring', () => {
  function envelope(rpcId: string, payload: unknown) {
    return { rpcId: rpcId as never, payload: payload as never }
  }

  it('routes a member-question frame into a receiving row and buffers nothing against the origin id', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api, fakeRemote())
    manager.handleMuxEnvelope(envelope('r1', {
      type: 'question/requested', sessionId: 'remote-session-1', questions: [memberQuestion({ expiresAt: Number.MAX_SAFE_INTEGER })],
    }))
    const row = manager.receiving.rows()[0]!
    const snapshot = manager.getListSnapshot()
    const entry = snapshot.items.find(item => item.sessionId === row.sessionId)
    expect(entry).toMatchObject({ title: 'Atlas — Offboard planning', pendingInteraction: 'question' })
    // Silence: no host session was created, instantiated, or listed for the ask.
    expect(api.callsOf('session.create')).toHaveLength(0)
    expect(snapshot.items.some(item => item.sessionId === 'remote-session-1')).toBe(false)
  })

  it('resolves the receiving card on a withdrawal frame and clears the pending dot', () => {
    const manager = new SessionManager(new FakeApiClient(), fakeRemote())
    manager.handleMuxEnvelope(envelope('r1', {
      type: 'question/requested', sessionId: 'remote-session-1', questions: [memberQuestion({ expiresAt: Number.MAX_SAFE_INTEGER })],
    }))
    const row = manager.receiving.rows()[0]!
    manager.handleMuxEnvelope(envelope('x1', {
      type: 'question/resolved', sessionId: 'remote-session-1', questionRpcId: 'r1', outcome: 'cancelled',
    }))
    expect(row.records[0]?.state).toBe('withdrawn')
    expect(manager.getListSnapshot().items.find(item => item.sessionId === row.sessionId)
      ?.pendingInteraction).toBeUndefined()
  })

  it('flips an expired card on the next snapshot read (fake clock, no timer)', () => {
    const clock = fakeClock()
    const clockSource = (): number => clock.now
    const manager = new SessionManager(
      new FakeApiClient(), fakeRemote(), undefined, undefined, undefined, undefined, { clock: clockSource })
    manager.handleMuxEnvelope(envelope('r1', {
      type: 'question/requested', sessionId: 'remote-session-1', questions: [memberQuestion()],
    }))
    const row = manager.receiving.rows()[0]!
    clock.advance(1_000)
    const entry = manager.getListSnapshot().items.find(item => item.sessionId === row.sessionId)
    expect(entry?.pendingInteraction).toBeUndefined()
    expect(row.records[0]?.state).toBe('expired')
  })

  it('keeps generic question batches on the host-session flow, not the receiving book', () => {
    const manager = new SessionManager(new FakeApiClient(), fakeRemote())
    manager.handleHostEnvelope(envelope('h1', { type: 'host/session-added', sessionId: 'fk-m1', blank: false }))
    manager.handleMuxEnvelope(envelope('r1', {
      type: 'question/requested',
      sessionId: 'fk-m1',
      questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A' }] }],
    }))
    expect(manager.receiving.rows()).toHaveLength(0)
    expect(manager.getListSnapshot().items[0]?.pendingInteraction).toBe('question')
  })
})
