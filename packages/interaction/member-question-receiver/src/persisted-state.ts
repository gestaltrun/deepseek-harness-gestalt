import type {
  CompanionMemberQuestionOperation,
  CompanionMemberQuestionSettledResult,
} from '@deepseek-ai/dsh-remote-protocol'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createHash } from 'node:crypto'
import type { MemberQuestionHumanTurnContent } from './types.ts'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  decodeProtocolBase64Url,
  negotiateCompanionProtocol,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'

const MEMBER_QUESTION_RECEIVER_FORMAT_VERSION = 2
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
  readonly content: readonly MemberQuestionHumanTurnContent[]
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
  /** Base64url document bytes aligned to the operation references, or empty when no transfer was requested. */
  readonly documents: readonly PersistedMemberQuestionDocument[]
  readonly terminal?: CompanionMemberQuestionSettledResult
}

/** One durable reassembled document whose bytes remain opaque in JSON. */
interface PersistedMemberQuestionDocument {
  readonly path: string
  readonly bytes: string
}

/** Exact local Workspace selected by one member for one Cloud Project. */
interface PersistedMemberQuestionWorkspaceBinding {
  readonly receivingAccountId: string
  readonly projectId: string
  readonly workspaceId: string
}

export interface PersistedReceiverState {
  readonly formatVersion: typeof MEMBER_QUESTION_RECEIVER_FORMAT_VERSION
  readonly revision: number
  readonly sessions: readonly PersistedReceivingSession[]
  readonly questions: readonly PersistedReceivingQuestion[]
  readonly admissions: readonly PersistedHumanTurnAdmission[]
  readonly workspaceBindings: readonly PersistedMemberQuestionWorkspaceBinding[]
}

export const EMPTY_PERSISTED_RECEIVER_STATE: PersistedReceiverState = {
  formatVersion: MEMBER_QUESTION_RECEIVER_FORMAT_VERSION,
  revision: 0,
  sessions: [],
  questions: [],
  admissions: [],
  workspaceBindings: [],
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
  if (!Array.isArray(value.sessions) || !Array.isArray(value.questions) || !Array.isArray(value.admissions)
    || !Array.isArray(value.workspaceBindings)) {
    throw new Error('member-question-receiver: durable state sessions, questions, admissions, and workspaceBindings must be arrays')
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
      documents: parsePersistedDocuments(entry.documents, operation),
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
  const workspaceBindings = value.workspaceBindings.map(parseWorkspaceBinding)
  const bindingKeys = workspaceBindings.map(binding => `${binding.receivingAccountId}\0${binding.projectId}`)
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    throw new Error('member-question-receiver: durable state contains duplicate member Workspace bindings')
  }
  return {
    formatVersion: MEMBER_QUESTION_RECEIVER_FORMAT_VERSION,
    revision,
    sessions,
    questions,
    admissions,
    workspaceBindings,
  }
}

function parsePersistedDocuments(
  value: unknown,
  operation: CompanionMemberQuestionOperation,
): readonly PersistedMemberQuestionDocument[] {
  if (!Array.isArray(value)) {
    throw new Error('member-question-receiver: durable question documents must be an array')
  }
  if (value.length !== 0 && value.length !== operation.references.length) {
    throw new Error('member-question-receiver: durable question documents must align with operation references')
  }
  const byteLimit = Math.min(
    REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes,
    REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * REMOTE_PROTOCOL_LIMITS.documentTransferChunks,
  )
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error('member-question-receiver: durable question document must be an object')
    const path = nonEmpty(entry.path, 'document path')
    if (path !== operation.references[index]?.path) {
      throw new Error('member-question-receiver: durable question documents must align with operation references')
    }
    const bytes = stringValue(entry.bytes, 'document bytes')
    try {
      decodeProtocolBase64Url(bytes, byteLimit, 'member-question durable document bytes')
    } catch (cause) {
      throw new Error(`member-question-receiver: durable question document bytes are invalid: ${String(cause)}`)
    }
    return { path, bytes }
  })
}

function parseWorkspaceBinding(value: unknown): PersistedMemberQuestionWorkspaceBinding {
  if (!isRecord(value)) throw new Error('member-question-receiver: durable Workspace binding must be an object')
  return {
    receivingAccountId: nonEmpty(value.receivingAccountId, 'binding receivingAccountId'),
    projectId: nonEmpty(value.projectId, 'binding projectId'),
    workspaceId: nonEmpty(value.workspaceId, 'binding workspaceId'),
  }
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
  const content = parseHumanTurnContent(value.content)
  const requestDigest = nonEmpty(value.requestDigest, 'admission requestDigest')
  if (requestDigest !== humanTurnDigest(content, value.mode)) {
    throw new Error('member-question-receiver: durable admission content digest does not match')
  }
  return {
    receivingSessionId,
    rpcId: nonEmpty(value.rpcId, 'admission rpcId'),
    expectedRevision: safeInteger(value.expectedRevision, 'admission expectedRevision'),
    requestDigest,
    content,
    mode: value.mode,
    state: value.state,
    reservedAt: safeInteger(value.reservedAt, 'reservedAt'),
    ...(committedAt === undefined ? {} : { committedAt }),
    ...(committedRevision === undefined ? {} : { committedRevision }),
  }
}

function parseHumanTurnContent(value: unknown): readonly MemberQuestionHumanTurnContent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('member-question-receiver: durable admission content must be a non-empty array')
  }
  return value.map((part): MemberQuestionHumanTurnContent => {
    if (!isRecord(part)) throw new Error('member-question-receiver: durable admission content part must be an object')
    if (part.type === 'text') return { type: 'text', text: stringValue(part.text, 'admission text') }
    if (part.type === 'image') {
      return {
        type: 'image',
        attachment: parseImageAttachment(part.attachment),
      }
    }
    throw new Error('member-question-receiver: durable admission content type must be text or image')
  })
}

function parseImageAttachment(value: unknown): ImageAttachmentRef {
  if (!isRecord(value)) {
    throw new Error('member-question-receiver: durable admission image attachment must be an object')
  }
  const mediaType = nonEmpty(value.mediaType, 'admission image mediaType')
  if (!isImageMediaType(mediaType)) {
    throw new Error(`member-question-receiver: durable admission image mediaType ${JSON.stringify(mediaType)} is unsupported`)
  }
  const originalDimensions = value.originalDimensions === undefined
    ? undefined
    : parseDimensions(value.originalDimensions, 'admission image originalDimensions')
  return {
    attachmentId: nonEmpty(value.attachmentId, 'admission image attachmentId') as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes: positiveSafeInteger(value.bytes, 'admission image bytes'),
    ...parseDimensions(value, 'admission image'),
    ...(value.name === undefined ? {} : { name: stringValue(value.name, 'admission image name') }),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  }
}

function parseDimensions(value: unknown, name: string): { width: number; height: number } {
  if (!isRecord(value)) throw new Error(`member-question-receiver: durable ${name} must be an object`)
  return {
    width: positiveSafeInteger(value.width, `${name} width`),
    height: positiveSafeInteger(value.height, `${name} height`),
  }
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

/**
 * Hash one human admission from canonical field order instead of JavaScript object insertion order.
 * @param content - Durable text and attachment-reference blocks.
 * @param mode - Requested queue or steer behavior.
 * @returns Stable digest used for idempotent replay validation.
 */
export function humanTurnDigest(
  content: readonly MemberQuestionHumanTurnContent[],
  mode: 'queue' | 'steer',
): string {
  const canonical = content.map(part => part.type === 'text'
    ? { type: 'text' as const, text: part.text }
    : {
      type: 'image' as const,
      attachment: {
        attachmentId: part.attachment.attachmentId,
        mediaType: part.attachment.mediaType,
        width: part.attachment.width,
        height: part.attachment.height,
        bytes: part.attachment.bytes,
        ...(part.attachment.name === undefined ? {} : { name: part.attachment.name }),
        ...(part.attachment.originalDimensions === undefined
          ? {}
          : { originalDimensions: part.attachment.originalDimensions }),
      },
    })
  return createHash('sha256').update(JSON.stringify({ content: canonical, mode })).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`member-question-receiver: durable ${name} must be a non-empty string`)
  return value
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`member-question-receiver: durable ${name} must be a string`)
  return value
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`member-question-receiver: durable ${name} must be a safe integer >= 0`)
  }
  return value
}

function positiveSafeInteger(value: unknown, name: string): number {
  const parsed = safeInteger(value, name)
  if (parsed < 1) throw new Error(`member-question-receiver: durable ${name} must be positive`)
  return parsed
}

function optionalSafeInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : safeInteger(value, name)
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`member-question-receiver: durable ${name} must be boolean`)
  return value
}
