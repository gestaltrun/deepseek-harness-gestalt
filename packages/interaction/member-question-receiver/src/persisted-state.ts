import type {
  CompanionMemberQuestionOperation,
  CompanionMemberQuestionSettledResult,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  negotiateCompanionProtocol,
} from '@deepseek-ai/dsh-remote-protocol'

export const MEMBER_QUESTION_RECEIVER_FORMAT_VERSION = 0
const PERSISTED_PROTOCOL = negotiateCompanionProtocol(
  createCompanionNegotiationChannel(),
  createCompanionVersionOffer('mobile'),
  createCompanionVersionOffer('desktop'),
)

export interface PersistedReceivingSession {
  readonly id: string
  readonly receivingAccountId: string
  readonly originSessionId: string
  readonly revision: number
  readonly createdAt: number
  readonly materialized: boolean
}

export interface PersistedHumanTurnAdmission {
  readonly receivingSessionId: string
  readonly rpcId: string
  readonly expectedRevision: number
  readonly requestDigest: string
  readonly mode: 'queue' | 'steer'
  readonly state: 'reserved' | 'committed'
  readonly reservedAt: number
  readonly committedAt?: number
  readonly committedRevision?: number
}

export interface PersistedReceivingQuestion {
  readonly questionId: string
  readonly receivingSessionId: string
  readonly receivingAccountId: string
  readonly revision: number
  readonly arrivedAt: number
  readonly operation: CompanionMemberQuestionOperation
  readonly terminal?: CompanionMemberQuestionSettledResult
}

export interface PersistedReceiverState {
  readonly formatVersion: typeof MEMBER_QUESTION_RECEIVER_FORMAT_VERSION
  readonly revision: number
  readonly sessions: readonly PersistedReceivingSession[]
  readonly questions: readonly PersistedReceivingQuestion[]
  readonly admissions: readonly PersistedHumanTurnAdmission[]
}

export const EMPTY_PERSISTED_RECEIVER_STATE: PersistedReceiverState = {
  formatVersion: MEMBER_QUESTION_RECEIVER_FORMAT_VERSION,
  revision: 0,
  sessions: [],
  questions: [],
  admissions: [],
}

export function serializeReceiverState(state: PersistedReceiverState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

export function parseReceiverState(text: string): PersistedReceiverState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`member-question-receiver: durable state is not valid JSON: ${String(cause)}`)
  }
  if (!isRecord(value)) throw new Error('member-question-receiver: durable state must be an object')
  if (value.formatVersion !== MEMBER_QUESTION_RECEIVER_FORMAT_VERSION) {
    throw new Error(`member-question-receiver: durable state formatVersion ${JSON.stringify(value.formatVersion)} is unsupported`)
  }
  const revision = safeInteger(value.revision, 'revision')
  if (!Array.isArray(value.sessions) || !Array.isArray(value.questions) || !Array.isArray(value.admissions)) {
    throw new Error('member-question-receiver: durable state sessions, questions, and admissions must be arrays')
  }
  const sessions = value.sessions.map(parseSession)
  const sessionIds = new Set(sessions.map(session => session.id))
  if (sessionIds.size !== sessions.length) throw new Error('member-question-receiver: durable state contains duplicate receiving Session ids')
  const questions = value.questions.map((entry) => {
    if (!isRecord(entry)) throw new Error('member-question-receiver: durable question must be an object')
    const operation = parsePersistedOperation(entry.operation)
    const questionId = nonEmpty(entry.questionId, 'questionId')
    if (operation.questionId !== questionId) {
      throw new Error('member-question-receiver: durable questionId disagrees with its operation')
    }
    const receivingSessionId = nonEmpty(entry.receivingSessionId, 'receivingSessionId')
    if (!sessionIds.has(receivingSessionId)) {
      throw new Error(`member-question-receiver: durable question references unknown receiving Session ${receivingSessionId}`)
    }
    const terminal = entry.terminal === undefined ? undefined : parsePersistedTerminal(entry.terminal)
    if (terminal !== undefined && terminal.questionId !== questionId) {
      throw new Error('member-question-receiver: durable terminal must settle its question id')
    }
    return {
      questionId,
      receivingSessionId,
      receivingAccountId: nonEmpty(entry.receivingAccountId, 'receivingAccountId'),
      revision: safeInteger(entry.revision, 'question revision'),
      arrivedAt: safeInteger(entry.arrivedAt, 'arrivedAt'),
      operation,
      ...(terminal === undefined ? {} : {
        terminal,
      }),
    }
  })
  if (new Set(questions.map(question => question.questionId)).size !== questions.length) {
    throw new Error('member-question-receiver: durable state contains duplicate question ids')
  }
  const admissions = value.admissions.map(entry => parseAdmission(entry, sessionIds))
  if (new Set(admissions.map(entry => entry.rpcId)).size !== admissions.length) {
    throw new Error('member-question-receiver: durable state contains duplicate admission rpcIds')
  }
  return { formatVersion: MEMBER_QUESTION_RECEIVER_FORMAT_VERSION, revision, sessions, questions, admissions }
}

function parsePersistedOperation(value: unknown): CompanionMemberQuestionOperation {
  let message
  try {
    message = decodeCompanionMessage(PERSISTED_PROTOCOL, new TextEncoder().encode(JSON.stringify({
      applicationVersion: 4,
      type: 'operation',
      operation: value,
    })))
  } catch (cause) {
    throw new Error(`member-question-receiver: durable member-question operation is invalid: ${String(cause)}`)
  }
  if (message.type !== 'operation' || message.operation.type !== 'member-question') {
    throw new Error('member-question-receiver: durable question operation must be member-question')
  }
  return message.operation
}

function parsePersistedTerminal(value: unknown): CompanionMemberQuestionSettledResult {
  let message
  try {
    message = decodeCompanionMessage(PERSISTED_PROTOCOL, new TextEncoder().encode(JSON.stringify({
      applicationVersion: 4,
      type: 'result',
      result: value,
    })))
  } catch (cause) {
    throw new Error(`member-question-receiver: durable member-question terminal is invalid: ${String(cause)}`)
  }
  if (message.type !== 'result' || message.result.type !== 'member-question-settled') {
    throw new Error('member-question-receiver: durable terminal must be member-question-settled')
  }
  return message.result
}

function parseSession(value: unknown): PersistedReceivingSession {
  if (!isRecord(value)) throw new Error('member-question-receiver: durable receiving Session must be an object')
  return {
    id: nonEmpty(value.id, 'receiving Session id'),
    receivingAccountId: nonEmpty(value.receivingAccountId, 'receivingAccountId'),
    originSessionId: nonEmpty(value.originSessionId, 'originSessionId'),
    revision: safeInteger(value.revision, 'receiving Session revision'),
    createdAt: safeInteger(value.createdAt, 'createdAt'),
    materialized: boolean(value.materialized, 'materialized'),
  }
}

function parseAdmission(value: unknown, sessionIds: ReadonlySet<string>): PersistedHumanTurnAdmission {
  if (!isRecord(value)) throw new Error('member-question-receiver: durable admission must be an object')
  const receivingSessionId = nonEmpty(value.receivingSessionId, 'admission receivingSessionId')
  if (!sessionIds.has(receivingSessionId)) {
    throw new Error(`member-question-receiver: durable admission references unknown receiving Session ${receivingSessionId}`)
  }
  if (value.mode !== 'queue' && value.mode !== 'steer') {
    throw new Error('member-question-receiver: durable admission mode must be queue or steer')
  }
  if (value.state !== 'reserved' && value.state !== 'committed') {
    throw new Error('member-question-receiver: durable admission state must be reserved or committed')
  }
  const committedAt = optionalSafeInteger(value.committedAt, 'committedAt')
  const committedRevision = optionalSafeInteger(value.committedRevision, 'committedRevision')
  if ((value.state === 'committed') !== (committedAt !== undefined && committedRevision !== undefined)) {
    throw new Error('member-question-receiver: durable committed admission requires committedAt and committedRevision only')
  }
  return {
    receivingSessionId,
    rpcId: nonEmpty(value.rpcId, 'admission rpcId'),
    expectedRevision: safeInteger(value.expectedRevision, 'admission expectedRevision'),
    requestDigest: nonEmpty(value.requestDigest, 'admission requestDigest'),
    mode: value.mode,
    state: value.state,
    reservedAt: safeInteger(value.reservedAt, 'reservedAt'),
    ...(committedAt === undefined ? {} : { committedAt }),
    ...(committedRevision === undefined ? {} : { committedRevision }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`member-question-receiver: durable ${name} must be a non-empty string`)
  return value
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`member-question-receiver: durable ${name} must be a safe integer >= 0`)
  }
  return value
}

function optionalSafeInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : safeInteger(value, name)
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`member-question-receiver: durable ${name} must be boolean`)
  return value
}
