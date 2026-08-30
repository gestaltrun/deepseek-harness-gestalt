/**
 * Receiving sessions: the receiver-side member-question book — route keys,
 * the single-active-card invariant, expiry and withdrawal propagation — plus
 * the SessionManager wiring that surfaces receiving rows in the list without
 * ever touching a host session (zero local model output).
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  briefSourceLine, memberQuestionIntentOf, receivingSessionId, ReceivingQuestionBook,
} from '../src/client/sessions/receiving.ts'
import type { SessionFace } from '../src/client/contract/session.ts'
import { SessionRuntime } from '../src/client/sessions/service.ts'
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

const rid = (value: string) => value as never

function memberQuestion(over: Partial<typeof intent> = {}): AskUserQuestionItem {
  return {
    id: 'member-q', question: 'Remove this member?',
    options: [{ label: 'Remove' }, { label: 'Keep' }],
    intent: { ...intent, ...over },
  }
}

/** A fake clock and timeout seat that executes every deadline reached by advance(). */
function fakeClock() {
  let now = 0
  let nextHandle = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    get now() { return now },
    get timerCount() { return timers.size },
    timer: {
      set(callback: () => void, delayMs: number) {
        const handle = ++nextHandle
        timers.set(handle, { at: now + delayMs, callback })
        return handle
      },
      clear(handle: unknown) { timers.delete(handle as number) },
    },
    advance(to: number) {
      now = to
      for (;;) {
        const due = [...timers].sort((a, b) => a[1].at - b[1].at)
          .find(([, timer]) => timer.at <= now)
        if (due === undefined) return
        timers.delete(due[0])
        due[1].callback()
      }
    },
  }
}

function questionBook(clock = fakeClock(), receiverMemberId = 'member-b') {
  return {
    book: new ReceivingQuestionBook(
      () => Promise.resolve({ accepted: true }),
      { receiverMemberId, clock: () => clock.now, timer: clock.timer },
    ),
    clock,
  }
}

function deliver(
  book: ReceivingQuestionBook,
  rpcId: string,
  question: AskUserQuestionItem = memberQuestion(),
) {
  return book.handleRequested(
    rid(rpcId),
    'remote-session-1' as SessionId,
    [question],
  )
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
    const { book } = questionBook()
    const row = deliver(book, 'r1')!
    expect(row.sessionId).toBe(receivingSessionId('remote-session-1::member-b'))
    expect(row.routeKey).toBe('remote-session-1::member-b')
    expect(row.title).toBe('Atlas — Offboard planning')
    expect(row.active?.state).toBe('pending')
    // The same remote ask locates the same session again (no duplicate rows).
    const again = deliver(book, 'r2', memberQuestion({ questionId: 'mq-2' }))
    expect(again!.sessionId).toBe(row.sessionId)
    expect(book.rows()).toHaveLength(1)
  })

  it('keeps a single active card: a new ask supersedes the still-pending predecessor', () => {
    const { book, clock } = questionBook()
    const row = deliver(book, 'r1')!
    clock.advance(50)
    deliver(book, 'r2', memberQuestion({ questionId: 'mq-2' }))
    expect(row.active?.rpcId).toBe('r2')
    expect(row.records.map(record => [record.rpcId, record.state])).toEqual([['r1', 'superseded']])
    expect(row.records[0]?.terminalAt).toBe(50)
  })

  it('does not supersede a predecessor that already reached a terminal state', () => {
    const { book, clock } = questionBook()
    const row = deliver(book, 'r1')!
    book.handleResolved(rid('r1'), 'answered')
    clock.advance(10)
    deliver(book, 'r2', memberQuestion({ questionId: 'mq-2' }))
    expect(row.records.map(record => record.state)).toEqual(['answered'])
    expect(row.active?.rpcId).toBe('r2')
  })

  it('propagates a sender cancellation as withdrawn and a decline as declined', () => {
    const { book } = questionBook()
    const row = deliver(book, 'r1')!
    book.handleResolved(rid('r1'), 'cancelled')
    expect(row.active).toBeUndefined()
    expect(row.records[0]?.state).toBe('withdrawn')
    deliver(book, 'r2', memberQuestion({ questionId: 'mq-2' }))
    book.decline(rid('r2'))
    expect(row.active).toBeUndefined()
    expect(row.records[1]?.state).toBe('declined')
  })

  it('records a cross-device settlement as answered-elsewhere', () => {
    const { book } = questionBook()
    const row = deliver(book, 'r1')!
    book.markAnsweredElsewhere('mq-1')
    expect(row.active).toBeUndefined()
    expect(row.records[0]?.state).toBe('answered-elsewhere')
  })

  it('expires the pending card when the countdown passes, on both sweeps and arrivals', () => {
    const { book, clock } = questionBook()
    const row = deliver(book, 'r1')!
    // Before the instant nothing flips.
    clock.advance(999)
    expect(book.sweep()).toBe(false)
    expect(row.active?.state).toBe('pending')
    clock.advance(1_000)
    expect(book.sweep()).toBe(false)
    expect(row.active).toBeUndefined()
    expect(row.records[0]?.state).toBe('expired')
    // An arrival after the pass records the new ask as the only pending card.
    deliver(book, 'r2', memberQuestion({ questionId: 'mq-2', expiresAt: 2_000 }))
    expect(row.records.map(record => record.state)).toEqual(['expired'])
    expect(row.active?.rpcId).toBe('r2')
  })

  it('expires before superseding: a passed ask records expired, not superseded', () => {
    const { book, clock } = questionBook()
    const row = deliver(book, 'r1')!
    clock.advance(1_500)
    deliver(book, 'r2', memberQuestion({ questionId: 'mq-2', expiresAt: 2_500 }))
    expect(row.records.map(record => [record.rpcId, record.state])).toEqual([['r1', 'expired']])
  })

  it('routes different receiving members to different receiving sessions', () => {
    const { book, clock } = questionBook()
    const forB = deliver(book, 'r1')!
    const forC = deliver(book, 'r2', memberQuestion({
      questionId: 'mq-2', toProjectMember: 'member-c', expiresAt: 5_000,
    }))!
    expect(forB.sessionId).not.toBe(forC.sessionId)
    expect(book.rows()).toHaveLength(2)
    expect(clock.timerCount).toBe(1)
  })
})

describe('SessionRuntime receiving wiring', () => {
  function envelope(rpcId: string, payload: unknown) {
    return { rpcId: rpcId as never, payload: payload as never }
  }

  function bench() {
    const ctx = new Context()
    const api = new FakeApiClient()
    const clock = fakeClock()
    const runtime = new SessionRuntime(ctx, api, fakeRemote(), undefined, {
      receiverMemberId: 'member-b',
      clock: () => clock.now,
      timer: clock.timer,
    })
    return { api, clock, runtime }
  }

  function request(
    runtime: SessionRuntime,
    rpcId: string,
    question: AskUserQuestionItem = memberQuestion(),
  ): void {
    runtime.handleMuxEnvelope(envelope(rpcId, {
      type: 'question/requested',
      sessionId: 'remote-session-1',
      questions: [question],
    }))
  }

  function currentFace(runtime: SessionRuntime): SessionFace {
    return runtime.currentProvideInfo.getSnapshot().hooks['session'] as SessionFace
  }

  it('opens a receiving row through the outward SessionFace with one identity-stable wait', async () => {
    const { api, runtime } = bench()
    request(runtime, 'r1')
    await Promise.resolve()
    const receivingId = receivingSessionId('remote-session-1::member-b')
    expect(runtime.list.getSnapshot().byId[receivingId]).toMatchObject({
      title: 'Atlas — Offboard planning', pendingInteraction: 'question',
    })

    runtime.open(receivingId)
    const face = currentFace(runtime)
    const first = face.getSnapshot()
    expect(first.pending).toHaveLength(1)
    expect(first.pending[0]?.sessionId).toBe('remote-session-1')
    expect(face.getSnapshot().pending[0]).toBe(first.pending[0])
    request(runtime, 'r1')
    expect(face.getSnapshot().pending[0]).toBe(first.pending[0])
    await expect(first.pending[0]!.respond({ ok: true, value: { answers: [] } } as never))
      .resolves.toEqual({ accepted: true })
    expect(api.callsOf('respond')).toMatchObject([{ rpcId: 'r1' }])
    expect(api.callsOf('session.create')).toEqual([])
    expect(api.callsOf('session.history')).toEqual([])
    expect(api.callsOf('subagent.list')).toEqual([])
    expect(runtime.modelRoute(receivingId)).toBeUndefined()
    expect(runtime.commandCatalogSessionId(receivingId)).toBeUndefined()
    expect(runtime.skillCatalogSessionId(receivingId)).toBeUndefined()
    await expect(face.prompt([{ type: 'text', text: 'not routed' }], 'queue'))
      .rejects.toThrow(/no prompt route/)
    runtime.handleConnected()
    await Promise.resolve()
    expect(api.callsOf('session.models')).toEqual([])
    expect(api.callsOf('session.prompt')).toEqual([])
    expect(api.callsOf('skill.list')).toEqual([])
    expect(api.callsOf('subagent.list')).toEqual([])
  })

  it('replaces and resolves the real pending wait through the same outward face', async () => {
    const { runtime } = bench()
    request(runtime, 'r1')
    await Promise.resolve()
    const receivingId = receivingSessionId('remote-session-1::member-b')
    runtime.open(receivingId)
    const face = currentFace(runtime)
    const firstWait = face.getSnapshot().pending[0]!

    request(runtime, 'r2', memberQuestion({ questionId: 'mq-2', expiresAt: 2_000 }))
    const secondWait = face.getSnapshot().pending[0]!
    expect(secondWait).not.toBe(firstWait)
    expect(face.getSnapshot().pending[0]).toBe(secondWait)
    expect(() => firstWait.respond({ ok: true, value: { answers: [] } } as never)).toThrow(/already settled/)

    runtime.handleMuxEnvelope(envelope('resolved', {
      type: 'question/resolved',
      sessionId: 'remote-session-1',
      questionRpcId: 'r2',
      outcome: 'answered',
    }))
    expect(face.getSnapshot().pending).toEqual([])
    expect(() => secondWait.respond({ ok: true, value: { answers: [] } } as never)).toThrow(/already settled/)
    await Promise.resolve()
    expect(runtime.list.getSnapshot().byId[receivingId]?.pendingInteraction).toBeUndefined()
  })

  it('expires the outward wait from one injected earliest-deadline timer', async () => {
    const { clock, runtime } = bench()
    request(runtime, 'r1')
    await Promise.resolve()
    const receivingId = receivingSessionId('remote-session-1::member-b')
    runtime.open(receivingId)
    const face = currentFace(runtime)
    const wait = face.getSnapshot().pending[0]!
    expect(clock.timerCount).toBe(1)

    clock.advance(1_000)
    expect(face.getSnapshot().pending).toEqual([])
    expect(() => wait.respond({ ok: true, value: { answers: [] } } as never)).toThrow(/already settled/)
    expect(clock.timerCount).toBe(0)
    await Promise.resolve()
    expect(runtime.list.getSnapshot().byId[receivingId]?.pendingInteraction).toBeUndefined()
  })

  it('settles the generation wait on disconnect and remints it from replay', async () => {
    const { clock, runtime } = bench()
    request(runtime, 'r1')
    await Promise.resolve()
    const receivingId = receivingSessionId('remote-session-1::member-b')
    runtime.open(receivingId)
    const face = currentFace(runtime)
    const generationWait = face.getSnapshot().pending[0]!

    runtime.handleDisconnected()
    expect(face.getSnapshot().pending).toEqual([])
    expect(clock.timerCount).toBe(0)
    expect(() => generationWait.respond({ ok: true, value: { answers: [] } } as never))
      .toThrow(/already settled/)

    request(runtime, 'r1')
    const replayedWait = face.getSnapshot().pending[0]!
    expect(replayedWait).not.toBe(generationWait)
    expect(replayedWait.sessionId).toBe('remote-session-1')
    expect(clock.timerCount).toBe(1)
  })

  it('keeps generic question batches on the host-session flow', async () => {
    const { runtime } = bench()
    runtime.handleHostEnvelope(envelope('h1', { type: 'host/session-added', sessionId: 'fk-m1', blank: false }))
    runtime.handleMuxEnvelope(envelope('r1', {
      type: 'question/requested',
      sessionId: 'fk-m1',
      questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A' }] }],
    }))
    await Promise.resolve()
    expect(runtime.list.getSnapshot().byId['fk-m1' as SessionId]?.pendingInteraction).toBe('question')
  })
})
