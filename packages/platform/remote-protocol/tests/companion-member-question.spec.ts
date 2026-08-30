import { describe, expect, it } from 'vitest'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseMemberQuestionId,
  parseMemberQuestionProjectId,
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
  type CompanionMemberQuestionOperation,
  type CompanionMemberQuestionOrigin,
  type ProjectId,
} from '../src/index.ts'

describe('Encrypted Companion Protocol member-question carriers', () => {
  it('admits the project, origin session, and absolute expiry needed to rebuild a receiving session', () => {
    const protocol = currentProtocol()
    const operation = rawMemberQuestionOperation()
    operation.projectId = 'project-atlas'
    operation.originSessionId = 'session-ingest'
    operation.expiresAt = 1_788_089_400_000

    expect(() => decodeCompanionMessage(protocol, json({
      applicationVersion: 4,
      type: 'operation',
      operation,
    }))).not.toThrow()
  })

  it('admits typed human-settlement metadata and an epoch on terminal results', () => {
    const protocol = currentProtocol()
    const result = rawSettledResult()
    result.settledByInstallationId = 'installation-studio'
    result.settledByDeviceName = 'Ada Studio'
    result.settledAt = 1_788_089_400_000

    expect(() => decodeCompanionMessage(protocol, json({
      applicationVersion: 4,
      type: 'result',
      result,
    }))).not.toThrow()
  })

  it('round-trips a complete member-question operation including an empty reference list', () => {
    const protocol = currentProtocol()
    const message = memberQuestionMessage()
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)

    const minimal = {
      type: 'operation' as const,
      operation: {
        type: 'member-question' as const,
        operationId: parseCompanionOperationId('operation-member-question'),
        questionId: parseMemberQuestionId('member-question-1'),
        projectId: 'project-atlas' as ProjectId,
        originSessionId: parseCompanionSessionId('session-ingest'),
        expiresAt: 1_788_089_400_000,
        origin: questionOrigin(),
        background: 'Pick one.',
        questions: [{ id: 'q-1', question: 'Proceed?' }],
        references: [],
      },
    }
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, minimal))).toEqual(minimal)

    const multibyte = memberQuestionMessage()
    multibyte.operation.background = '文'.repeat(REMOTE_PROTOCOL_LIMITS.memberQuestionBackgroundCodePoints)
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, multibyte))).toEqual(multibyte)
  })

  it('round-trips every settled outcome with answers admitted only when answered', () => {
    const protocol = currentProtocol()
    const operationId = parseCompanionOperationId('operation-member-question')
    const questionId = parseMemberQuestionId('member-question-1')
    const answered = {
      type: 'result' as const,
      result: {
        type: 'member-question-settled' as const,
        operationId,
        questionId,
        outcome: 'answered' as const,
        answers: [
          { id: 'q-1', selected: ['72 hours'], custom: 'Extend the account locks first' },
          { id: 'q-2', selected: [] },
        ],
        settledByInstallationId: 'installation-studio' as never,
        settledByDeviceName: 'Ada Studio',
        settledAt: 1_788_089_400_000,
      },
    }
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, answered))).toEqual(answered)

    const declined = {
      type: 'result' as const,
      result: {
        type: 'member-question-settled' as const,
        operationId,
        questionId,
        outcome: 'declined' as const,
        settledByInstallationId: 'installation-studio' as never,
        settledByDeviceName: 'Ada Studio',
        settledAt: 1_788_089_400_000,
      },
    }
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, declined))).toEqual(declined)

    for (const outcome of ['expired', 'withdrawn', 'superseded'] as const) {
      const settled = {
        type: 'result' as const,
        result: {
          type: 'member-question-settled' as const,
          operationId,
          questionId,
          outcome,
          settledAt: 1_788_089_400_000,
        },
      }
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, settled))).toEqual(settled)
    }

    const replay = {
      type: 'result' as const,
      result: {
        type: 'status' as const,
        operationId,
        committed: {
          type: 'member-question-settled' as const,
          operationId,
          questionId,
          outcome: 'answered' as const,
          answers: [{ id: 'q-1', selected: ['24 hours'] }],
          settledByInstallationId: 'installation-studio' as never,
          settledByDeviceName: 'Ada Studio',
          settledAt: 1_788_089_400_000,
        },
      },
    }
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, replay))).toEqual(replay)
  })

  it('round-trips derived state projections for the receiver status bar', () => {
    const protocol = currentProtocol()
    const pending = {
      type: 'projection' as const,
      projection: {
        type: 'member-question-state' as const,
        questionId: parseMemberQuestionId('member-question-1'),
        state: 'pending' as const,
      },
    }
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, pending))).toEqual(pending)
    for (const state of ['answered', 'declined'] as const) {
      const projection = {
        type: 'projection' as const,
        projection: {
          type: 'member-question-state' as const,
          questionId: parseMemberQuestionId('member-question-1'),
          state,
          settledByInstallationId: 'installation-studio' as never,
          settledByDeviceName: 'Ada Studio',
          settledAt: 1_788_089_400_000,
        },
      }
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, projection))).toEqual(projection)
    }
    for (const state of ['expired', 'withdrawn', 'superseded'] as const) {
      const projection = {
        type: 'projection' as const,
        projection: {
          type: 'member-question-state' as const,
          questionId: parseMemberQuestionId('member-question-1'),
          state,
          settledAt: 1_788_089_400_000,
        },
      }
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, projection))).toEqual(projection)
    }
  })

  it('rejects unknown fields, unknown vocabularies, and outcome-answer mismatches', () => {
    const protocol = currentProtocol()
    const invalidMessages: Uint8Array[] = [
      wireOperation((operation) => { operation.extra = true }),
      wireOperation((operation) => { delete operation.projectId }),
      wireOperation((operation) => { delete operation.originSessionId }),
      wireOperation((operation) => { delete operation.expiresAt }),
      wireOperation((operation) => { operation.expiresAt = 0 }),
      wireOperation((operation) => { operation.expiresAt = 'tomorrow' }),
      wireOperation((operation) => { (operation.origin as Record<string, unknown>).extra = true }),
      wireOperation((operation) => {
        const first = (operation.questions as Record<string, unknown>[])[0]!
        first.extra = true
      }),
      wireOperation((operation) => {
        const first = (operation.questions as Record<string, unknown>[])[0]!
        const options = first.options as Record<string, unknown>[]
        options[0]!.extra = true
      }),
      wireOperation((operation) => {
        const reference = (operation.references as Record<string, unknown>[])[0]!
        reference.extra = true
      }),
      wireResult((result) => { result.extra = true }),
      wireResult((result) => {
        const answer = (result.answers as Record<string, unknown>[])[0]!
        answer.extra = true
      }),
      wireProjection((projection) => { projection.extra = true }),
      wireOperation((operation) => { (operation.origin as Record<string, unknown>).askerRole = 'builder' }),
      wireResult((result) => { result.outcome = 'postponed' }),
      wireProjection((projection) => { projection.state = 'queued' }),
      wireResult((result) => { result.outcome = 'declined'; result.answers = [{ id: 'q-1', selected: [] }] }),
      wireResult((result) => { result.outcome = 'answered'; delete result.answers }),
      wireResult((result) => { delete result.settledByInstallationId }),
      wireResult((result) => { delete result.settledByDeviceName }),
      wireResult((result) => { delete result.settledAt }),
      wireResult((result) => { result.outcome = 'expired' }),
      wireResult((result) => { result.outcome = 'expired'; delete result.answers }),
      wireResult((result) => { result.settledAt = 0 }),
      wireResult((result) => { result.settledAt = 'now' }),
      wireResult((result) => { result.settledByDeviceId = 'legacy-device' }),
      wireResult((result) => { result.settledAtMoment = '2026-08-30T00:00:00.000Z' }),
      wireOperation((operation) => { operation.background = '' }),
      wireOperation((operation) => {
        const first = (operation.questions as Record<string, unknown>[])[0]!
        first.multiSelect = 1
      }),
      wireOperation((operation) => {
        operation.questions = [
          { id: 'q-1', question: 'First?' },
          { id: 'q-1', question: 'Again?' },
        ]
      }),
      wireResult((result) => {
        result.answers = [
          { id: 'q-1', selected: [] },
          { id: 'q-1', selected: [] },
        ]
      }),
      wireOperation((operation) => {
        operation.type = 'member-question-broadcast'
      }),
      wireOperation((operation) => { operation.questions = 'batch' }),
      wireProjection((projection) => { projection.state = 7 }),
      wireProjection((projection) => { projection.state = 'answered' }),
      wireProjection((projection) => { projection.state = 'expired' }),
      wireProjection((projection) => { projection.settledAt = 1_788_089_400_000 }),
    ]
    for (const wire of invalidMessages) {
      expect(() => decodeCompanionMessage(protocol, wire)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }
  })

  it('enforces every member-question string ceiling on Unicode code points', () => {
    const protocol = currentProtocol()
    const ceilingCases: { cap: number; build: (value: string) => Uint8Array }[] = [
      {
        cap: REMOTE_PROTOCOL_LIMITS.memberQuestionOriginSessionTitleCodePoints,
        build: value => wireOperation((operation) => { (operation.origin as Record<string, unknown>).originSessionTitle = value }),
      },
      {
        cap: REMOTE_PROTOCOL_LIMITS.memberQuestionAskerDisplayNameCodePoints,
        build: value => wireOperation((operation) => { (operation.origin as Record<string, unknown>).askerDisplayName = value }),
      },
      {
        cap: REMOTE_PROTOCOL_LIMITS.memberQuestionAskerAvatarUrlCodePoints,
        build: value => wireOperation((operation) => { (operation.origin as Record<string, unknown>).askerAvatarUrl = value }),
      },
      {
        cap: REMOTE_PROTOCOL_LIMITS.memberQuestionBackgroundCodePoints,
        build: value => wireOperation((operation) => { operation.background = value }),
      },
      {
        cap: REMOTE_PROTOCOL_LIMITS.memberQuestionReferencePathCodePoints,
        build: value => wireOperation((operation) => {
          const reference = (operation.references as Record<string, unknown>[])[0]!
          reference.path = value
        }),
      },
      {
        cap: REMOTE_PROTOCOL_LIMITS.memberQuestionReferenceReasonCodePoints,
        build: value => wireOperation((operation) => {
          const reference = (operation.references as Record<string, unknown>[])[0]!
          reference.reason = value
        }),
      },
      {
        cap: REMOTE_PROTOCOL_LIMITS.memberQuestionSettledByDeviceNameCodePoints,
        build: value => wireResult((result) => { result.settledByDeviceName = value }),
      },
    ]
    for (const { cap, build } of ceilingCases) {
      expect(() => decodeCompanionMessage(protocol, build('x'.repeat(cap)))).not.toThrow()
      expect(() => decodeCompanionMessage(protocol, build(`${'x'.repeat(cap)}x`))).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }

    const emojiName = '\u{1F600}'.repeat(REMOTE_PROTOCOL_LIMITS.memberQuestionAskerDisplayNameCodePoints)
    expect(() => decodeCompanionMessage(protocol, wireOperation((operation) => {
      (operation.origin as Record<string, unknown>).askerDisplayName = emojiName
    }))).not.toThrow()
    expect(() => decodeCompanionMessage(protocol, wireOperation((operation) => {
      (operation.origin as Record<string, unknown>).askerDisplayName = `${emojiName}\u{1F600}`
    }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
  })

  it('enforces every member-question array ceiling', () => {
    const protocol = currentProtocol()
    const batchCeiling = REMOTE_PROTOCOL_LIMITS.interactionQuestions
    const questionBatch = Array.from({ length: batchCeiling + 1 }, (_, index) => ({
      id: `q-${String(index)}`,
      question: 'Proceed?',
    }))
    const answerBatch = Array.from({ length: batchCeiling + 1 }, (_, index) => ({
      id: `q-${String(index)}`,
      selected: [],
    }))

    const invalidWires = [
      wireOperation((operation) => { operation.questions = questionBatch }),
      wireOperation((operation) => { operation.questions = [] }),
      wireOperation((operation) => {
        operation.references = Array.from({ length: REMOTE_PROTOCOL_LIMITS.memberQuestionReferences + 1 }, () => ({
          path: 'plans/rollout.md',
          reason: 'Rollout plan',
        }))
      }),
      wireOperation((operation) => {
        const first = (operation.questions as Record<string, unknown>[])[0]!
        first.options = Array.from(
          { length: REMOTE_PROTOCOL_LIMITS.memberQuestionOptions + 1 },
          (_, index) => ({ label: `Option ${String(index)}` }),
        )
      }),
      wireResult((result) => { result.answers = answerBatch }),
      wireResult((result) => {
        result.answers = [{ id: 'q-1', selected: Array.from({ length: REMOTE_PROTOCOL_LIMITS.interactionSelections + 1 }, () => 'one') }]
      }),
    ]
    for (const wire of invalidWires) {
      expect(() => decodeCompanionMessage(protocol, wire)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }
  })

  it('requires application major 4 for member-question carriers and rejects unknown operations', () => {
    const protocol = currentProtocol()
    const stale = negotiateFresh(createCompanionVersionOffer('mobile', [3]), createCompanionVersionOffer('desktop', [3]))
    expect(stale.major).toBe(3)
    const settled = {
      type: 'result' as const,
      result: {
        type: 'member-question-settled' as const,
        operationId: parseCompanionOperationId('operation-member-question'),
        questionId: parseMemberQuestionId('member-question-1'),
        outcome: 'declined' as const,
        settledByInstallationId: 'installation-studio' as never,
        settledByDeviceName: 'Ada Studio',
        settledAt: 1_788_089_400_000,
      },
    }
    const projection = {
      type: 'projection' as const,
      projection: {
        type: 'member-question-state' as const,
        questionId: parseMemberQuestionId('member-question-1'),
        state: 'pending' as const,
      },
    }
    for (const message of [memberQuestionMessage(), settled, projection]) {
      expect(() => encodeCompanionMessage(stale, message)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'COMPANION_UPDATE_REQUIRED' }),
      )
      expect(() => decodeCompanionMessage(stale, json({
        applicationVersion: 3,
        ...message,
      }))).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }

    expect(() => decodeCompanionMessage(protocol, json({
      applicationVersion: 4,
      type: 'operation',
      operation: { type: 'member-question-broadcast', operationId: 'operation-x' },
    }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
    expect(() => parseMemberQuestionId('not valid')).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
    expect(() => parseMemberQuestionProjectId('not valid')).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
  })
})

function questionOrigin(): CompanionMemberQuestionOrigin {
  return {
    projectName: 'Atlas',
    originSessionTitle: 'Refactor the ingest pipeline',
    askerAccountId: 'account-asker',
    askerRole: 'admin',
    askerDisplayName: 'Ada',
    askerAvatarUrl: 'https://example.test/ada.png',
  }
}

function memberQuestionMessage(): { type: 'operation'; operation: CompanionMemberQuestionOperation } {
  return {
    type: 'operation',
    operation: {
      type: 'member-question',
      operationId: parseCompanionOperationId('operation-member-question'),
      questionId: parseMemberQuestionId('member-question-1'),
      projectId: 'project-atlas' as ProjectId,
      originSessionId: parseCompanionSessionId('session-ingest'),
      expiresAt: 1_788_089_400_000,
      origin: questionOrigin(),
      background: 'The ingest pipeline fails under load; we must pick a rollback window before the Friday freeze.',
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
    },
  }
}

function rawMemberQuestionOperation(): Record<string, unknown> {
  const operation = structuredClone(memberQuestionMessage().operation)
  return {
    type: operation.type,
    operationId: operation.operationId,
    questionId: operation.questionId,
    projectId: operation.projectId,
    originSessionId: operation.originSessionId,
    expiresAt: operation.expiresAt,
    origin: operation.origin,
    background: operation.background,
    questions: operation.questions,
    references: operation.references,
  }
}

function rawSettledResult(): Record<string, unknown> {
  return {
    type: 'member-question-settled',
    operationId: 'operation-member-question',
    questionId: 'member-question-1',
    outcome: 'answered',
    answers: [{ id: 'q-1', selected: ['72 hours'] }],
    settledByInstallationId: 'installation-studio',
    settledByDeviceName: 'Ada Studio',
    settledAt: 1_788_089_400_000,
  }
}

function rawStateProjection(): Record<string, unknown> {
  return { type: 'member-question-state', questionId: 'member-question-1', state: 'pending' }
}

function wireOperation(mutate: (operation: Record<string, unknown>) => void): Uint8Array {
  return json({
    applicationVersion: 4,
    type: 'operation',
    operation: mutateOnClone(rawMemberQuestionOperation(), mutate),
  })
}

function wireResult(mutate: (result: Record<string, unknown>) => void): Uint8Array {
  return json({
    applicationVersion: 4,
    type: 'result',
    result: mutateOnClone(rawSettledResult(), mutate),
  })
}

function wireProjection(mutate: (projection: Record<string, unknown>) => void): Uint8Array {
  return json({
    applicationVersion: 4,
    type: 'projection',
    projection: mutateOnClone(rawStateProjection(), mutate),
  })
}

function mutateOnClone<T>(value: T, mutate: (cloned: T) => void): T {
  const cloned = structuredClone(value)
  mutate(cloned)
  return cloned
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function negotiateFresh(
  mobile: Parameters<typeof negotiateCompanionProtocol>[1],
  desktop: Parameters<typeof negotiateCompanionProtocol>[2],
): ReturnType<typeof negotiateCompanionProtocol> {
  return negotiateCompanionProtocol(createCompanionNegotiationChannel(), mobile, desktop)
}

function currentProtocol(): ReturnType<typeof negotiateCompanionProtocol> {
  return negotiateFresh(createCompanionVersionOffer('mobile'), createCompanionVersionOffer('desktop'))
}
