import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  decodeCompanionMessage,
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
} from '../src/index.ts'

function payload(overrides: Partial<MemberQuestionSendPayload> = {}): MemberQuestionSendPayload {
  return {
    toProjectMember: 'account-peer',
    projectId: 'project-atlas',
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
      askerAccountId: 'account-asker',
      askerRole: 'admin',
      askerDisplayName: 'Ada',
      askerAvatarUrl: 'https://example.test/ada.png',
    },
    originSessionId: 'session-origin',
    ...overrides,
  }
}

function session(): ReturnType<typeof Session.create> {
  return Session.create(SessionId('session-origin'))
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
  it('encodes a member-question operation that round-trips the T4 codec', () => {
    const protocol = createMemberQuestionProtocol()
    const encoded = encodeMemberQuestion(protocol, payload())
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
    await ctx.memberQuestionSender.settle(questionId!, {
      outcome: 'answered',
      answers: [{ id: 'q-1', selected: ['24 hours'] }],
    })
    const result = await pending
    expect(result).toMatchObject({
      questionId,
      outcome: 'answered',
      answers: [{ id: 'q-1', selected: ['24 hours'] }],
    })
    expect(asking.events.map(event => event.type)).toEqual([
      'member-question/asked',
      'member-question/outcome',
    ])
    expect(asking.events[0]?.data).toMatchObject({
      questionId,
      toProjectMember: 'account-peer',
      projectId: 'project-atlas',
      background: payload().background,
      originSessionId: 'session-origin',
    })
    expect(asking.events[1]?.data).toMatchObject({
      questionId,
      outcome: 'answered',
      answers: [{ id: 'q-1', selected: ['24 hours'] }],
    })
  })

  it('rejects with DELIVERY_UNAVAILABLE when the adapter throws', async () => {
    const ctx = new Context()
    await ctx.plugin(Sender, {
      delivery: {
        deliver: () => Promise.reject(new Error('route closed')),
      },
    })
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

  it('wraps a codec rejection as ENCODE_FAILED', () => {
    const protocol = createMemberQuestionProtocol()
    expect(() => encodeMemberQuestion(protocol, payload({
      questions: Array.from({ length: 300 }, (_, index) => ({
        id: `q-${String(index)}`,
        question: 'x'.repeat(400),
      })),
    }))).toThrow(
      expect.objectContaining<Partial<MemberQuestionSenderError>>({ code: 'ENCODE_FAILED' }),
    )
  })

  it('accepts an empty reference list and still round-trips', () => {
    const protocol = createMemberQuestionProtocol()
    const encoded = encodeMemberQuestion(protocol, payload({ references: [] }))
    const decoded = decodeCompanionMessage(protocol, encoded.encoded)
    expect(decoded).toEqual(encoded.message)
  })

  it('unregisters the service when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(CompanionMemberQuestionSender, { delivery: new MemoryMemberQuestionDelivery() })
    expect(ctx.memberQuestionSender).toBeDefined()
    const abort = new AbortController()
    const { pending } = await startSend(ctx, payload(), { signal: abort.signal })
    await fiber.dispose()
    expect(ctx.get('memberQuestionSender')).toBeUndefined()
    await expect(pending).rejects.toMatchObject({
      name: 'MemberQuestionSenderError',
      code: 'QUESTION_WITHDRAWN',
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
    await sender.settle(questionId!, { outcome: 'declined' })
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
      const expired = expect(pending).rejects.toMatchObject({
        name: 'MemberQuestionSenderError',
        code: 'QUESTION_EXPIRED',
      })
      await vi.advanceTimersByTimeAsync(50)
      await expired
      expect(asking.events[1]?.data).toMatchObject({ outcome: 'expired' })
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
    expect(asking.events[1]?.data).toMatchObject({ outcome: 'withdrawn' })
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
    expect(delivery.delivered).toHaveLength(2)
    const secondId = delivery.delivered[1]?.questionId
    expect(secondId).toBeDefined()
    await ctx.memberQuestionSender.settle(secondId!, { outcome: 'declined' })
    await expect(second).resolves.toMatchObject({ outcome: 'declined', questionId: secondId })
    const outcomes = asking.events.filter(event => event.type === 'member-question/outcome')
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
    expect(asking.events[1]?.data).toMatchObject({ outcome: 'revoked' })
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
    await expect(ctx.memberQuestionSender.settle('mqmissing' as never, { outcome: 'declined' }))
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
    await ctx.memberQuestionSender.settle(questionId!, { outcome: 'declined' })
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
    await ctx.memberQuestionSender.settle(questionId!, { outcome: 'declined' })
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
    await ctx.memberQuestionSender.settle(questionId!, { outcome: 'declined' })
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
      toProjectMember: 'account-other',
      originSessionId: 'session-other',
    }))
    expect(delivery.delivered).toHaveLength(2)
    const firstId = delivery.delivered[0]?.questionId
    const secondId = delivery.delivered[1]?.questionId
    expect(firstId).toBeDefined()
    expect(secondId).toBeDefined()
    await ctx.memberQuestionSender.settle(firstId!, { outcome: 'declined' })
    await ctx.memberQuestionSender.settle(secondId!, {
      outcome: 'answered',
      answers: [{ id: 'q-1', selected: ['72 hours'] }],
    })
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
    await ctx.memberQuestionSender.settle(questionId!, { outcome: 'declined' })
    await expect(pending).resolves.toMatchObject({ outcome: 'declined', questionId })
    expect(asking.events[1]?.data).toEqual({ questionId, outcome: 'declined' })
  })
})
