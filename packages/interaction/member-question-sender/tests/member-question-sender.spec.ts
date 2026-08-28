import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  decodeCompanionMessage,
  type CompanionMemberQuestionOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import CompanionMemberQuestionSender, {
  CompanionMemberQuestionSender as Sender,
  createMemberQuestionProtocol,
  encodeMemberQuestion,
  MemberQuestionSenderError,
  MemoryMemberQuestionDelivery,
  type MemberQuestionSendPayload,
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
    ...overrides,
  }
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

  it('delivers the encoded operation through an injected memory stub', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(Sender, { delivery })
    const result = await ctx.memberQuestionSender.send(payload())
    expect(delivery.delivered).toHaveLength(1)
    expect(delivery.delivered[0]?.questionId).toBe(result.questionId)
    expect(delivery.delivered[0]?.encoded).toEqual(result.encoded)
    const decoded = decodeCompanionMessage(createMemberQuestionProtocol(), result.encoded)
    expect(decoded).toEqual(delivery.delivered[0]?.message)
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
    await fiber.dispose()
    expect(ctx.get('memberQuestionSender')).toBeUndefined()
  })
})
