import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import UserQuestionService, {
  UserQuestionError,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import {
  decodeCompanionMessage,
  parseCompanionSessionId,
  parseMemberQuestionProjectId,
  type CompanionMemberQuestionOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import CompanionMemberQuestionSender, {
  CompanionMemberQuestionSender as Sender,
  createMemberQuestionProtocol,
  encodeMemberQuestion,
  MemberQuestionSenderError,
  MemoryMemberQuestionDelivery,
  type MemberQuestionSendOptions,
  type MemberQuestionSendPayload,
  type MemberQuestionSendResult,
  type MemberQuestionSettlement,
} from '../src/index.ts'

const SETTLED_AT = 1_788_089_400_000

function declinedSettlement(): MemberQuestionSettlement {
  return {
    outcome: 'declined',
    settledByInstallationId: 'installation-studio' as never,
    settledByDeviceName: 'Ada Studio',
    settledAt: SETTLED_AT,
  }
}

function answeredSettlement(
  answers: Extract<MemberQuestionSettlement, { outcome: 'answered' }>['answers'],
): MemberQuestionSettlement {
  return {
    outcome: 'answered',
    answers,
    settledByInstallationId: 'installation-studio' as never,
    settledByDeviceName: 'Ada Studio',
    settledAt: SETTLED_AT,
  }
}

function payload(overrides: Partial<MemberQuestionSendPayload> = {}): MemberQuestionSendPayload {
  return {
    toProjectMember: 'account-peer' as PlatformAccountId,
    projectId: parseMemberQuestionProjectId('project-atlas'),
    background: 'The ingest pipeline fails under load; pick a rollback window.',
    questions: [
      {
        id: 'q-1',
        question: 'Which rollback window do we pick?',
        header: 'Rollback',
        options: [
          { label: '24 hours' },
          { label: '72 hours', description: 'Safer for locked accounts' },
        ],
        multiSelect: false,
      },
    ],
    references: [{ path: 'plans/rollout.md', reason: 'Current rollout plan' }],
    origin: {
      projectName: 'Atlas',
      originSessionTitle: 'Refactor the ingest pipeline',
      askerAccountId: 'account-asker' as PlatformAccountId,
      askerRole: 'admin',
      askerDisplayName: 'Ada',
      askerAvatarUrl: 'https://example.test/ada.png',
    },
    originSessionId: parseCompanionSessionId('session-origin'),
    ...overrides,
  }
}

function session(): ReturnType<typeof Session.create> {
  return Session.create(SessionId('session-origin'))
}

function stubAgent(id: string): Agent {
  const agentId = SessionId(id)
  const asking = Session.create(agentId)
  return {
    id: agentId,
    options: {},
    session: asking,
    inbox: new Inbox(asking, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function memberRoute() {
  return {
    projectId: parseMemberQuestionProjectId('project-atlas'),
    toProjectMember: 'account-peer' as PlatformAccountId,
    background: payload().background,
    references: [],
    origin: payload().origin,
    originSessionId: parseCompanionSessionId('session-origin'),
  } as const
}

async function startSend(
  ctx: Context,
  sendPayload: MemberQuestionSendPayload = payload(),
  options?: MemberQuestionSendOptions,
): Promise<{ pending: Promise<MemberQuestionSendResult> }> {
  const pending = ctx.memberQuestionSender.send(sendPayload, options)
  await Promise.resolve()
  return { pending }
}

describe('member-question sender', () => {
  it('delegates an ordinary request exactly once to a Remote-like answerer registered first', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const delivery = new MemoryMemberQuestionDelivery()
    const remoteAnswerer = vi.fn((request: AskUserQuestionRequest) => Promise.resolve({
      answers: request.questions.map(question => ({ id: question.id, selected: ['local'] })),
    }))
    ctx.on('user-questions/request', remoteAnswerer)
    await ctx.plugin(Sender, { delivery })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'q-1', question: 'Local?' }],
    })).resolves.toEqual({ answers: [{ id: 'q-1', selected: ['local'] }] })
    expect(remoteAnswerer).toHaveBeenCalledOnce()
    expect(delivery.delivered).toEqual([])
  })

  it('prepends member routing ahead of a Remote-like answerer registered first', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const delivery = new MemoryMemberQuestionDelivery()
    const remoteAnswerer = vi.fn(() => Promise.resolve({ answers: [{ id: 'q-1', selected: ['local'] }] }))
    ctx.on('user-questions/request', remoteAnswerer)
    await ctx.plugin(Sender, { delivery })
    const agent = stubAgent('asking-root')
    ctx.agents.enter(agent, undefined)

    const answer = ctx.userQuestions.ask({
      questions: payload().questions.map(question => ({
        ...question,
        ...question.options === undefined ? {} : { options: question.options.map(option => ({ ...option })) },
      })),
      agent,
      memberRoute: memberRoute(),
    })
    await Promise.resolve()
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(
      questionId!,
      answeredSettlement([{ id: 'q-1', selected: ['24 hours'] }]),
    )

    await expect(answer).resolves.toEqual({ answers: [{ id: 'q-1', selected: ['24 hours'] }] })
    expect(remoteAnswerer).not.toHaveBeenCalled()
  })

  it('removes the global answerer when the Sender fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const delivery = new MemoryMemberQuestionDelivery()
    const fallback = vi.fn(() => Promise.resolve({ answers: [{ id: 'q-1', selected: ['fallback'] }] }))
    ctx.on('user-questions/request', fallback)
    const fiber = await ctx.plugin(Sender, { delivery })

    await fiber.dispose()

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'q-1', question: 'Which rollback window?' }],
      memberRoute: memberRoute(),
    })).resolves.toEqual({ answers: [{ id: 'q-1', selected: ['fallback'] }] })
    expect(fallback).toHaveBeenCalledOnce()
    expect(delivery.delivered).toEqual([])
  })

  it('answers after UserQuestionService mounts when Sender registered first', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    await ctx.plugin(UserQuestionService)
    const fallback = vi.fn(() => Promise.resolve({ answers: [{ id: 'q-1', selected: ['fallback'] }] }))
    ctx.on('user-questions/request', fallback)

    const answer = ctx.userQuestions.ask({
      questions: [{ id: 'q-1', question: 'Which rollback window?' }],
      memberRoute: memberRoute(),
    })
    await Promise.resolve()
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(
      questionId!,
      answeredSettlement([{ id: 'q-1', selected: ['24 hours'] }]),
    )

    await expect(answer).resolves.toEqual({ answers: [{ id: 'q-1', selected: ['24 hours'] }] })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('preserves the sender stable error through the user-questions waterfall', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const local = vi.fn(() => Promise.resolve({ answers: [] }))
    ctx.on('user-questions/request', local)
    await ctx.plugin(Sender)

    const failure = await ctx.userQuestions.ask({
      questions: payload().questions.map(question => ({
        ...question,
        ...question.options === undefined ? {} : { options: question.options.map(option => ({ ...option })) },
      })),
      memberRoute: memberRoute(),
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(MemberQuestionSenderError)
    expect(failure).toMatchObject({ code: 'DELIVERY_UNAVAILABLE' })
    expect(failure).not.toBeInstanceOf(UserQuestionError)
    expect(local).not.toHaveBeenCalled()
  })

  it('encodes a member-question operation that round-trips the T4 codec', () => {
    const protocol = createMemberQuestionProtocol()
    const encoded = encodeMemberQuestion(protocol, payload(), 1_788_089_400_000)
    const decoded = decodeCompanionMessage(protocol, encoded.encoded)
    expect(decoded).toEqual(encoded.message)
    expect(decoded.type).toBe('operation')
    if (decoded.type !== 'operation') throw new Error('expected operation')
    const operation = decoded.operation as CompanionMemberQuestionOperation
    expect(operation.type).toBe('member-question')
    expect(operation.background).toBe(payload().background)
    expect(operation.questions).toEqual(payload().questions)
    expect(operation.references).toEqual(payload().references)
    expect(operation.origin).toEqual(payload().origin)
    expect(operation.questionId).toBe(encoded.questionId)
    expect(operation.projectId).toBe(payload().projectId)
    expect(operation.originSessionId).toBe(payload().originSessionId)
    expect(operation.expiresAt).toBe(1_788_089_400_000)
  })

  it('delivers the encoded operation through an injected memory stub and settles answered', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const asking = session()
    const { pending } = await startSend(ctx, payload(), { session: asking })
    expect(delivery.delivered).toHaveLength(1)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(
      questionId!,
      answeredSettlement([{ id: 'q-1', selected: ['24 hours'] }]),
    )
    const result = await pending
    expect(result).toMatchObject({
      questionId,
      outcome: 'answered',
      answers: [{ id: 'q-1', selected: ['24 hours'] }],
    })
    const events = asking.snapshotEvents()
    expect(events.map(event => event.type)).toEqual([
      'member-question/asked',
      'member-question/outcome',
    ])
    expect(events.map(event => event.ignorable)).toEqual([true, true])
    expect(events[0]?.data).toMatchObject({
      questionId,
      toProjectMember: 'account-peer' as PlatformAccountId,
      projectId: parseMemberQuestionProjectId('project-atlas'),
      background: payload().background,
      originSessionId: parseCompanionSessionId('session-origin'),
    })
    expect(events[1]?.data).toMatchObject({
      questionId,
      outcome: 'answered',
      answers: [{ id: 'q-1', selected: ['24 hours'] }],
    })
    await expect(ctx.memberQuestionSender.queryTerminal(questionId!)).resolves.toMatchObject({
      questionId,
      outcome: 'answered',
      settledByInstallationId: 'installation-studio',
      settledByDeviceName: 'Ada Studio',
      settledAt: SETTLED_AT,
    })
  })

  it('rejects with DELIVERY_UNAVAILABLE when the adapter throws', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    vi.spyOn(delivery, 'deliver').mockRejectedValue(new Error('route closed'))
    await ctx.plugin(Sender, { delivery })
    await expect(ctx.memberQuestionSender.send(payload())).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'DELIVERY_UNAVAILABLE',
    })
  })

  it('fails closed without a delivery adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(Sender)
    await expect(ctx.memberQuestionSender.send(payload())).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'DELIVERY_UNAVAILABLE',
    })
    await expect(ctx.memberQuestionSender.queryTerminal('mqmissing' as never)).resolves.toBeUndefined()
  })

  it('applies an authoritative transport terminal to a pending ask', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending } = await startSend(ctx)
    const questionId = delivery.delivered[0]?.questionId
    const operationId = delivery.delivered[0]?.operationId
    expect(questionId).toBeDefined()
    expect(operationId).toBeDefined()
    await ctx.memberQuestionSender.applyTerminal({
      type: 'member-question-settled',
      operationId: operationId!,
      questionId: questionId!,
      outcome: 'expired',
      settledAt: SETTLED_AT,
    })
    await expect(pending).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' })
  })

  it('ignores an unknown authoritative terminal and rejects a mismatched operation', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending } = await startSend(ctx)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await expect(ctx.memberQuestionSender.applyTerminal({
      type: 'member-question-settled',
      operationId: 'op-other' as never,
      questionId: 'mq-unknown' as never,
      outcome: 'expired',
      settledAt: SETTLED_AT,
    })).resolves.toBeUndefined()
    await expect(ctx.memberQuestionSender.applyTerminal({
      type: 'member-question-settled',
      operationId: 'op-other' as never,
      questionId: questionId!,
      outcome: 'expired',
      settledAt: SETTLED_AT,
    })).rejects.toThrow('different operation')
    await ctx.memberQuestionSender.settle(questionId!, declinedSettlement())
    await expect(pending).resolves.toMatchObject({ outcome: 'declined' })
  })

  it('wraps a rejecting grant lookup as GRANT_UNAVAILABLE', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, {
      delivery,
      lookupGrant: () => Promise.reject(new Error('no grant')),
    })
    await expect(ctx.memberQuestionSender.send(payload())).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'GRANT_UNAVAILABLE',
    })
    expect(delivery.delivered).toHaveLength(0)
  })

  it('rejects document bytes that do not align with references', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    await expect(ctx.memberQuestionSender.send(payload({
      documents: [{ path: 'other.bin', bytes: Uint8Array.of(1) }],
    }))).rejects.toMatchObject({ code: 'ENCODE_FAILED' })
  })

  it('wraps a codec rejection as ENCODE_FAILED', () => {
    const protocol = createMemberQuestionProtocol()
    expect(() => encodeMemberQuestion(protocol, payload({
      questions: Array.from({ length: 300 }, (_, index) => ({
        id: `q-${String(index)}`,
        question: 'x'.repeat(400),
      })),
    }), 1_788_089_400_000)).toThrow(
      expect.objectContaining<Partial<MemberQuestionSenderError>>({ code: 'ENCODE_FAILED' }),
    )
  })

  it('accepts an empty reference list and still round-trips', () => {
    const protocol = createMemberQuestionProtocol()
    const encoded = encodeMemberQuestion(protocol, payload({ references: [] }), 1_788_089_400_000)
    const decoded = decodeCompanionMessage(protocol, encoded.encoded)
    expect(decoded).toEqual(encoded.message)
  })

  it('unregisters the service when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    const fiber = await ctx.plugin(CompanionMemberQuestionSender, { delivery })
    expect(ctx.memberQuestionSender).toBeDefined()
    const abort = new AbortController()
    const { pending } = await startSend(ctx, payload(), { signal: abort.signal })
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('memberQuestionSender')).toBeUndefined()
    await expect(pending).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'QUESTION_WITHDRAWN',
    })
    await expect(delivery.queryTerminal(questionId!)).resolves.toMatchObject({
      questionId,
      outcome: 'withdrawn',
    })
  })

  it('defaults ttlMs when the Config field is omitted', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    const sender = new Sender(ctx, { delivery })
    const pending = sender.send(payload())
    await Promise.resolve()
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await sender.settle(questionId!, declinedSettlement())
    await expect(pending).resolves.toMatchObject({ outcome: 'declined' })
  })

  it('fails fast with MEMBER_OFFLINE when presence is offline', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, {
      delivery,
      presenceLookup: () => Promise.resolve('offline'),
    })
    await expect(ctx.memberQuestionSender.send(payload())).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'MEMBER_OFFLINE',
    })
    expect(delivery.delivered).toHaveLength(0)
  })

  it('fails fast with MEMBER_OFFLINE when presence lookup rejects', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, {
      delivery,
      presenceLookup: () => Promise.reject(new Error('directory down')),
    })
    await expect(ctx.memberQuestionSender.send(payload())).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'MEMBER_OFFLINE',
    })
    expect(delivery.delivered).toHaveLength(0)
  })

  it('rejects with QUESTION_EXPIRED when the configured TTL elapses', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const delivery = new MemoryMemberQuestionDelivery()
      const asking = session()
      await ctx.plugin(Sender, { delivery, ttlMs: 50 })
      const { pending } = await startSend(ctx, payload(), { session: asking })
      const questionId = delivery.delivered[0]?.questionId
      expect(questionId).toBeDefined()
      const expired = expect(pending).rejects.toMatchObject({
        name: 'MemberQuestionSenderError',
        code: 'QUESTION_EXPIRED',
      })
      await vi.advanceTimersByTimeAsync(50)
      await expired
      expect(asking.snapshotEvents()[1]?.data).toMatchObject({ outcome: 'expired' })
      await expect(delivery.queryTerminal(questionId!)).resolves.toMatchObject({
        questionId,
        outcome: 'expired',
      })
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('rejects with QUESTION_WITHDRAWN when the initiator cancels the turn', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    const asking = session()
    await ctx.plugin(Sender, { delivery })
    const abort = new AbortController()
    const { pending } = await startSend(ctx, payload(), { session: asking, signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'QUESTION_WITHDRAWN',
    })
    expect(asking.snapshotEvents()[1]?.data).toMatchObject({ outcome: 'withdrawn' })
  })

  it('rejects with QUESTION_WITHDRAWN when withdraw() is called', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending } = await startSend(ctx)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.withdraw(questionId!)
    await expect(pending).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'QUESTION_WITHDRAWN',
    })
    await expect(delivery.queryTerminal(questionId!)).resolves.toMatchObject({
      questionId,
      outcome: 'withdrawn',
    })
  })

  it('rejects the first same-route ask with QUESTION_SUPERSEDED when a second ask arrives', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    const asking = session()
    await ctx.plugin(Sender, { delivery })
    const { pending: first } = await startSend(ctx, payload(), { session: asking })
    const { pending: second } = await startSend(ctx, payload({
      background: 'A newer question on the same route.',
    }), { session: asking })
    await expect(first).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'QUESTION_SUPERSEDED',
    })
    const firstId = delivery.delivered[0]?.questionId
    expect(firstId).toBeDefined()
    await expect(delivery.queryTerminal(firstId!)).resolves.toMatchObject({
      questionId: firstId,
      outcome: 'superseded',
    })
    expect(delivery.delivered).toHaveLength(2)
    const secondId = delivery.delivered[1]?.questionId
    expect(secondId).toBeDefined()
    await ctx.memberQuestionSender.settle(secondId!, declinedSettlement())
    await expect(second).resolves.toMatchObject({ outcome: 'declined', questionId: secondId })
    const outcomes = asking.snapshotEvents().filter(event => event.type === 'member-question/outcome')
    expect(outcomes.map(event => event.data.outcome)).toEqual(['superseded', 'declined'])
  })

  it('rejects with REVOKED_DURING_FLIGHT when membership is withdrawn in flight', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    const asking = session()
    let revoke!: () => void
    await ctx.plugin(Sender, {
      delivery,
      watchMembership: () => new Promise<void>((resolve) => { revoke = resolve }),
    })
    const { pending } = await startSend(ctx, payload(), { session: asking })
    expect(typeof revoke).toBe('function')
    revoke()
    await expect(pending).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'REVOKED_DURING_FLIGHT',
    })
    expect(asking.snapshotEvents()[1]?.data).toMatchObject({ outcome: 'revoked' })
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await expect(delivery.queryTerminal(questionId!)).resolves.toMatchObject({
      questionId,
      outcome: 'withdrawn',
    })
  })

  it('rejects a pre-aborted signal as QUESTION_WITHDRAWN before delivery', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const abort = new AbortController()
    abort.abort()
    await expect(ctx.memberQuestionSender.send(payload(), { signal: abort.signal })).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'QUESTION_WITHDRAWN',
    })
    expect(delivery.delivered).toHaveLength(0)
  })

  it('ignores settle() and withdraw() for an unknown question id', async () => {
    const ctx = new Context()
    await ctx.plugin(Sender, { delivery: new MemoryMemberQuestionDelivery() })
    await expect(ctx.memberQuestionSender.settle('mqmissing' as never, declinedSettlement()))
      .resolves.toBeUndefined()
    await expect(ctx.memberQuestionSender.withdraw('mqmissing' as never)).resolves.toBeUndefined()
  })

  it('rejects a non-function injected face at construction', () => {
    expect(() => new Sender(new Context(), { lookupGrant: {} as never })).toThrow(/lookupGrant must be a function/)
    expect(() => new Sender(new Context(), { presenceLookup: {} as never })).toThrow(/presenceLookup must be a function/)
    expect(() => new Sender(new Context(), { watchMembership: {} as never })).toThrow(/watchMembership must be a function/)
    expect(() => new Sender(new Context(), { delivery: {} as never })).toThrow(/delivery must implement deliver/)
    expect(() => new Sender(new Context(), { ttlMs: 0 })).toThrow(/ttlMs must be a positive finite number/)
    expect(() => new Sender(new Context(), { ttlMs: Number.POSITIVE_INFINITY })).toThrow(/ttlMs must be a positive finite number/)
  })

  it('ignores a membership-watch resolution after the ask has already settled', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, {
      delivery,
      watchMembership: ({ signal }) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      }),
    })
    const { pending } = await startSend(ctx)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(questionId!, declinedSettlement())
    await expect(pending).resolves.toMatchObject({ outcome: 'declined' })
    await Promise.resolve()
  })

  it('sends when presence lookup reports online', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, {
      delivery,
      presenceLookup: () => Promise.resolve('online'),
    })
    const { pending } = await startSend(ctx)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(questionId!, declinedSettlement())
    await expect(pending).resolves.toMatchObject({ outcome: 'declined' })
  })

  it('ignores a membership-watch rejection after the ask has already settled', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    let rejectWatch!: (error: Error) => void
    await ctx.plugin(Sender, {
      delivery,
      watchMembership: ({ signal }) => new Promise<void>((_resolve, reject) => {
        rejectWatch = reject
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const { pending } = await startSend(ctx)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(questionId!, declinedSettlement())
    await expect(pending).resolves.toMatchObject({ outcome: 'declined' })
    rejectWatch(new Error('late'))
    await Promise.resolve()
  })

  it('keeps independent route keys pending without superseding', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending: first } = await startSend(ctx)
    const { pending: second } = await startSend(ctx, payload({
      toProjectMember: 'account-other' as PlatformAccountId,
      originSessionId: parseCompanionSessionId('session-other'),
    }))
    expect(delivery.delivered).toHaveLength(2)
    const firstId = delivery.delivered[0]?.questionId
    const secondId = delivery.delivered[1]?.questionId
    expect(firstId).toBeDefined()
    expect(secondId).toBeDefined()
    await ctx.memberQuestionSender.settle(firstId!, declinedSettlement())
    await ctx.memberQuestionSender.settle(
      secondId!,
      answeredSettlement([{ id: 'q-1', selected: ['72 hours'] }]),
    )
    await expect(first).resolves.toMatchObject({ outcome: 'declined', questionId: firstId })
    await expect(second).resolves.toMatchObject({ outcome: 'answered', questionId: secondId })
  })

  it('rejects with REVOKED_DURING_FLIGHT when the membership watch fails', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, {
      delivery,
      watchMembership: () => Promise.reject(new Error('roster down')),
    })
    await expect(ctx.memberQuestionSender.send(payload())).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'REVOKED_DURING_FLIGHT',
    })
  })

  it('records a declined outcome without answers', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    const asking = session()
    await ctx.plugin(Sender, { delivery })
    const { pending } = await startSend(ctx, payload(), { session: asking })
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(questionId!, declinedSettlement())
    await expect(pending).resolves.toMatchObject({ outcome: 'declined', questionId })
    expect(asking.snapshotEvents()[1]?.data).toEqual({ questionId, outcome: 'declined' })
    await expect(delivery.queryTerminal(questionId!)).resolves.toMatchObject({
      questionId,
      outcome: 'declined',
      settledByInstallationId: 'installation-studio',
      settledByDeviceName: 'Ada Studio',
      settledAt: SETTLED_AT,
    })
  })

  it('uses the retained first terminal when a later local answer loses the claim', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending } = await startSend(ctx)
    const delivered = delivery.delivered[0]
    expect(delivered).toBeDefined()
    await delivery.publishTerminal({
      type: 'member-question-settled',
      operationId: delivered!.operationId,
      questionId: delivered!.questionId,
      outcome: 'expired',
      settledAt: SETTLED_AT,
    })

    await ctx.memberQuestionSender.settle(
      delivered!.questionId,
      answeredSettlement([{ id: 'q-1', selected: ['24 hours'] }]),
    )

    await expect(pending).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' })
    await expect(ctx.memberQuestionSender.queryTerminal(delivered!.questionId)).resolves.toEqual({
      type: 'member-question-settled',
      operationId: delivered!.operationId,
      questionId: delivered!.questionId,
      outcome: 'expired',
      settledAt: SETTLED_AT,
    })
  })

  it.each([
    ['withdrawn', 'QUESTION_WITHDRAWN'],
    ['superseded', 'QUESTION_SUPERSEDED'],
  ] as const)('maps a retained %s terminal onto the local stable error', async (outcome, code) => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending } = await startSend(ctx)
    const delivered = delivery.delivered[0]
    expect(delivered).toBeDefined()
    await delivery.publishTerminal({
      type: 'member-question-settled',
      operationId: delivered!.operationId,
      questionId: delivered!.questionId,
      outcome,
      settledAt: SETTLED_AT,
    })

    await ctx.memberQuestionSender.settle(delivered!.questionId, declinedSettlement())

    await expect(pending).rejects.toMatchObject({ code })
  })

  it('fails closed when the delivery port rejects terminal publication', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const asking = session()
    const { pending } = await startSend(ctx, payload(), { session: asking })
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    vi.spyOn(delivery, 'publishTerminal').mockRejectedValue(new Error('terminal store unavailable'))

    await ctx.memberQuestionSender.settle(questionId!, declinedSettlement())

    await expect(pending).rejects.toMatchObject({ code: 'DELIVERY_UNAVAILABLE' })
    expect(asking.snapshotEvents()).toHaveLength(1)
    await expect(delivery.queryTerminal(questionId!)).resolves.toBeUndefined()
  })

  it('publishes supersession before delivering the replacement question', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending: first } = await startSend(ctx)
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'QUESTION_SUPERSEDED' })
    const publish = vi.spyOn(delivery, 'publishTerminal')
    let release!: () => void
    publish.mockImplementationOnce(terminal => new Promise((resolve) => {
      release = () => { resolve({ claimed: true, terminal }) }
    }))

    const second = ctx.memberQuestionSender.send(payload({ background: 'Replacement question.' }))
    await Promise.resolve()
    expect(delivery.delivered).toHaveLength(1)
    release()
    await firstRejected
    await vi.waitFor(() => { expect(delivery.delivered).toHaveLength(2) })
    const secondId = delivery.delivered[1]?.questionId
    expect(secondId).toBeDefined()
    await ctx.memberQuestionSender.settle(secondId!, declinedSettlement())
    await expect(second).resolves.toMatchObject({ outcome: 'declined' })
  })

  it('does not deliver a replacement when supersession publication fails', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending: first } = await startSend(ctx)
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'DELIVERY_UNAVAILABLE' })
    vi.spyOn(delivery, 'publishTerminal').mockRejectedValueOnce(new Error('terminal store unavailable'))

    await expect(ctx.memberQuestionSender.send(payload({ background: 'Replacement question.' })))
      .rejects.toMatchObject({ code: 'DELIVERY_UNAVAILABLE' })
    await firstRejected
    expect(delivery.delivered).toHaveLength(1)
  })

  it('does not deliver a replacement cancelled while supersession publishes', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const { pending: first } = await startSend(ctx)
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'QUESTION_SUPERSEDED' })
    let release!: () => void
    vi.spyOn(delivery, 'publishTerminal').mockImplementationOnce(terminal => new Promise((resolve) => {
      release = () => { resolve({ claimed: true, terminal }) }
    }))
    const abort = new AbortController()

    const second = ctx.memberQuestionSender.send(payload({ background: 'Cancelled replacement.' }), {
      signal: abort.signal,
    })
    await Promise.resolve()
    abort.abort()
    release()

    await firstRejected
    await expect(second).rejects.toMatchObject({ code: 'QUESTION_WITHDRAWN' })
    expect(delivery.delivered).toHaveLength(1)
  })
})
