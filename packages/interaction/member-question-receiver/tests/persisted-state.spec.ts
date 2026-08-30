import { describe, expect, it } from 'vitest'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseMemberQuestionId,
  parseMemberQuestionProjectId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  parseReceiverState,
  serializeReceiverState,
  type PersistedReceiverState,
} from '../src/persisted-state.ts'

function validState(): PersistedReceiverState {
  const operation = {
    type: 'member-question' as const,
    operationId: parseCompanionOperationId('operation-persisted'),
    questionId: parseMemberQuestionId('question-persisted'),
    projectId: parseMemberQuestionProjectId('project-persisted'),
    originSessionId: parseCompanionSessionId('origin-persisted'),
    expiresAt: 9_000,
    origin: {
      projectName: 'Persisted',
      originSessionTitle: 'Validation',
      askerAccountId: 'asker',
      askerRole: 'admin' as const,
      askerDisplayName: 'Ada',
      askerAvatarUrl: 'https://example.test/ada.png',
    },
    background: 'Validate every durable field.',
    questions: [{ id: 'q', question: 'Valid?' }],
    references: [],
  }
  return {
    formatVersion: 0,
    revision: 4,
    sessions: [{
      id: 'receiving-persisted',
      receivingAccountId: 'receiver',
      originSessionId: operation.originSessionId,
      revision: 4,
      createdAt: 1,
      materialized: true,
    }],
    questions: [
      {
        questionId: operation.questionId,
        receivingSessionId: 'receiving-persisted',
        receivingAccountId: 'receiver',
        revision: 2,
        arrivedAt: 2,
        operation,
      },
      {
        questionId: 'question-terminal',
        receivingSessionId: 'receiving-persisted',
        receivingAccountId: 'receiver',
        revision: 3,
        arrivedAt: 3,
        operation: {
          ...operation,
          operationId: parseCompanionOperationId('operation-terminal'),
          questionId: parseMemberQuestionId('question-terminal'),
        },
        terminal: {
          type: 'member-question-settled',
          operationId: parseCompanionOperationId('operation-terminal'),
          questionId: parseMemberQuestionId('question-terminal'),
          outcome: 'withdrawn',
          settledAt: 4,
        },
      },
    ],
    admissions: [
      {
        receivingSessionId: 'receiving-persisted',
        rpcId: 'rpc-reserved',
        expectedRevision: 2,
        requestDigest: 'digest-reserved',
        mode: 'queue',
        state: 'reserved',
        reservedAt: 5,
      },
      {
        receivingSessionId: 'receiving-persisted',
        rpcId: 'rpc-committed',
        expectedRevision: 2,
        requestDigest: 'digest-committed',
        mode: 'steer',
        state: 'committed',
        reservedAt: 6,
        committedAt: 7,
        committedRevision: 4,
      },
    ],
  }
}

function document(): Record<string, unknown> {
  return JSON.parse(serializeReceiverState(validState())) as Record<string, unknown>
}

describe('member-question receiver durable state', () => {
  it('round-trips pending, terminal, reserved, and committed rows', () => {
    expect(parseReceiverState(serializeReceiverState(validState()))).toEqual(validState())
  })

  it('rejects invalid JSON, non-object roots, foreign versions, and missing collections', () => {
    expect(() => parseReceiverState('{')).toThrow('not valid JSON')
    expect(() => parseReceiverState('[]')).toThrow('must be an object')
    const foreign = document()
    foreign.formatVersion = 2
    expect(() => parseReceiverState(JSON.stringify(foreign))).toThrow('formatVersion 2 is unsupported')
    for (const key of ['sessions', 'questions', 'admissions']) {
      const missing = document()
      missing[key] = {}
      expect(() => parseReceiverState(JSON.stringify(missing))).toThrow('must be arrays')
    }
  })

  it('rejects malformed and duplicate receiving Sessions', () => {
    const rowCases: Array<[string, unknown]> = [
      ['row', null],
      ['id', ''],
      ['receivingAccountId', ''],
      ['originSessionId', ''],
      ['revision', -1],
      ['createdAt', 1.5],
      ['materialized', 'yes'],
    ]
    for (const [key, value] of rowCases) {
      const invalid = document()
      const sessions = invalid.sessions as Array<Record<string, unknown>>
      if (key === 'row') sessions[0] = value as never
      else sessions[0]![key] = value
      expect(() => parseReceiverState(JSON.stringify(invalid))).toThrow('durable')
    }
    const duplicate = document()
    const sessions = duplicate.sessions as unknown[]
    sessions.push(structuredClone(sessions[0]))
    expect(() => parseReceiverState(JSON.stringify(duplicate))).toThrow('duplicate receiving Session ids')
  })

  it('rejects malformed, dangling, conflicting, and duplicate questions', () => {
    const cases: Array<(question: Record<string, unknown>) => void> = [
      (question) => { question.operation = null },
      (question) => { (question.operation as Record<string, unknown>).type = 'other' },
      (question) => { question.questionId = 'different' },
      (question) => { question.receivingSessionId = 'missing' },
      (question) => { question.receivingAccountId = '' },
      (question) => { question.revision = -1 },
      (question) => { question.arrivedAt = 0.5 },
      (question) => { question.terminal = 'bad' },
      (question) => { question.terminal = { type: 'other', questionId: question.questionId } },
      (question) => { question.terminal = { type: 'member-question-settled', questionId: 'different' } },
    ]
    for (const mutate of cases) {
      const invalid = document()
      const questions = invalid.questions as Array<Record<string, unknown>>
      mutate(questions[0]!)
      expect(() => parseReceiverState(JSON.stringify(invalid))).toThrow('durable')
    }
    const otherOperation = document()
    ;(otherOperation.questions as Array<Record<string, unknown>>)[0]!.operation = {
      type: 'refresh-surface',
      operationId: 'operation-other',
      offset: 0,
    }
    expect(() => parseReceiverState(JSON.stringify(otherOperation))).toThrow('operation must be member-question')
    const otherTerminal = document()
    ;(otherTerminal.questions as Array<Record<string, unknown>>)[0]!.terminal = {
      type: 'confirmed',
      operationId: 'operation-other-terminal',
      committedAt: 1,
      outcome: 'accepted',
    }
    expect(() => parseReceiverState(JSON.stringify(otherTerminal))).toThrow('terminal must be member-question-settled')
    const mismatchedTerminal = document()
    const terminalQuestion = (mismatchedTerminal.questions as Array<Record<string, unknown>>)[1]!
    ;(terminalQuestion.terminal as Record<string, unknown>).questionId = 'question-persisted'
    expect(() => parseReceiverState(JSON.stringify(mismatchedTerminal))).toThrow('terminal must settle its question id')
    const nonObject = document()
    ;(nonObject.questions as unknown[])[0] = null
    expect(() => parseReceiverState(JSON.stringify(nonObject))).toThrow('durable question must be an object')
    const duplicate = document()
    const questions = duplicate.questions as unknown[]
    questions.push(structuredClone(questions[0]))
    expect(() => parseReceiverState(JSON.stringify(duplicate))).toThrow('duplicate question ids')
  })

  it('rejects malformed, dangling, inconsistent, and duplicate admissions', () => {
    const cases: Array<(admission: Record<string, unknown>) => void> = [
      (admission) => { admission.receivingSessionId = 'missing' },
      (admission) => { admission.rpcId = '' },
      (admission) => { admission.expectedRevision = -1 },
      (admission) => { admission.requestDigest = '' },
      (admission) => { admission.mode = 'later' },
      (admission) => { admission.state = 'unknown' },
      (admission) => { admission.reservedAt = 1.5 },
      (admission) => { admission.state = 'committed' },
      (admission) => { admission.committedAt = 1; admission.committedRevision = 2 },
      (admission) => { admission.committedAt = -1 },
      (admission) => { admission.committedRevision = 1.5 },
    ]
    for (const mutate of cases) {
      const invalid = document()
      const admissions = invalid.admissions as Array<Record<string, unknown>>
      mutate(admissions[0]!)
      expect(() => parseReceiverState(JSON.stringify(invalid))).toThrow('durable')
    }
    const nonObject = document()
    ;(nonObject.admissions as unknown[])[0] = null
    expect(() => parseReceiverState(JSON.stringify(nonObject))).toThrow('durable admission must be an object')
    const duplicate = document()
    const admissions = duplicate.admissions as unknown[]
    admissions.push(structuredClone(admissions[0]))
    expect(() => parseReceiverState(JSON.stringify(duplicate))).toThrow('duplicate admission rpcIds')
  })
})
