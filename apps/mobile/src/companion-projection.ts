/** JSON wire projection and the sole adapter into shared Web presentation carriers. */

import {
  EMPTY_CHAT_SNAPSHOT,
  EMPTY_CONVERSATION_VIEWS,
  PendingWait,
  conversationContextKey,
  type ChatConversationViewNode,
  type ConversationNode,
  type ConversationSnapshot,
  type PendingPayloads,
  type QueuedMessage,
  type RunningToolCall,
  type SessionId,
  type SessionListState,
  type SessionSummary,
  type WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Values admitted by the authenticated Companion projection decoder. */
type CompanionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CompanionJsonValue[]
  | { readonly [key: string]: CompanionJsonValue }

type JsonProjection<Value> =
  unknown extends Value ? CompanionJsonValue
    : Value extends null | boolean | number | string ? Value
      : Value extends undefined ? never
        : Value extends readonly (infer Item)[] ? readonly JsonProjection<Item>[]
          : Value extends object ? { readonly [Key in keyof Value]: JsonProjection<Value[Key]> }
            : never

/** JSON Session row consumed by the local shared-presentation adapter. */
interface MobileSessionSummaryDto {
  readonly id: string
  readonly title?: string
  readonly displayTitle: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly running: boolean
  readonly pendingInteraction?: SessionSummary['pendingInteraction']
  readonly completed?: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly projectionValues?: CompanionJsonValue
}

/** JSON Session list; nullable wire fields replace JavaScript `undefined`. */
interface MobileSessionListDto {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, MobileSessionSummaryDto>>
  readonly current: string | null
  readonly phase: SessionListState['phase']
  readonly subagentsByParent: JsonProjection<SessionListState['subagentsByParent']>
  readonly jobsBySession: JsonProjection<SessionListState['jobsBySession']>
  readonly currentAddress: JsonProjection<NonNullable<SessionListState['currentAddress']>> | null
}

/** JSON Workspace row used by shared Desktop grouping. */
interface MobileWorkspaceDto {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Pending interaction data carries identity and domain payload, never a responder. */
type MobilePendingInteractionDto = {
  [Kind in keyof PendingPayloads]: {
    readonly kind: Kind
    readonly interactionId: string
    readonly sessionId: string
    readonly payload: JsonProjection<PendingPayloads[Kind]>
  }
}[keyof PendingPayloads]

type MobileConversationJsonFields = JsonProjection<Pick<ConversationSnapshot,
  | 'nodes'
  | 'partial'
  | 'runningCalls'
  | 'queue'
  | 'running'
  | 'subagent'
  | 'composerPhase'
  | 'removed'
  | 'openState'
  | 'openError'
  | 'hasMore'
  | 'loadingOlder'
  | 'promptError'
  | 'blank'
  | 'lastAgentError'
>>

type MobileToolCallCard = NonNullable<RunningToolCall['callView']>['card']
type MobileToolResultCard = NonNullable<Extract<ConversationNode, { kind: 'tool-result' }>['resultView']>['card']
type PresentationRecordParser = (view: Record<string, CompanionJsonValue>) => void

/** JSON conversation state needed by the shared narrow presentation. */
export type MobileConversationProjectionDto = MobileConversationJsonFields & {
  readonly sessionId: string
  readonly turnTimings: readonly (readonly [number, {
    readonly startTime: number
    readonly endTime?: number
  }])[]
  readonly turnEnds: readonly (readonly [number, number])[]
  readonly pending: readonly MobilePendingInteractionDto[]
}

/** Authenticated Desktop state transferred over the encrypted Companion channel. */
export interface MobileCompanionProjectionDto {
  readonly type: 'desktop-resync'
  readonly version: 1
  readonly authenticated: true
  readonly desktopName: string
  readonly sessions: MobileSessionListDto
  readonly workspaces: readonly MobileWorkspaceDto[]
  readonly conversations: readonly MobileConversationProjectionDto[]
}

/** Result encoded by the shared Approval or Ask User owner. */
type MobilePendingSettlementResult = Parameters<PendingWait['respond']>[0]

/** Carrier receipt returned to the shared interaction owner. */
export type MobilePendingSettlementReceipt = Awaited<ReturnType<PendingWait['respond']>>

/** Generation-bound interaction response sent to the Paired Desktop. */
export interface MobilePendingSettlement {
  readonly kind: keyof PendingPayloads
  readonly sessionId: SessionId
  readonly interactionId: string
  readonly result: MobilePendingSettlementResult
}

/** Local presentation projection created from one authenticated JSON message. */
export interface AdaptedMobileCompanionProjection {
  readonly desktopName: string
  readonly sessions: SessionListState
  readonly workspaces: readonly WorkspaceView[]
  readonly conversations: Readonly<Partial<Record<SessionId, ConversationSnapshot>>>
}

/**
 * Reject values that cannot cross a JSON wire without changing identity or behavior.
 * @param value - decoded authenticated projection candidate.
 */
export function assertCompanionJsonProjection(value: unknown): asserts value is MobileCompanionProjectionDto {
  const visiting = new Set<object>()
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return
    if (typeof candidate === 'number') {
      if (Number.isFinite(candidate)) return
      throw new TypeError('Companion projection must contain only JSON-compatible values')
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('Companion projection must contain only JSON-compatible values')
    }
    if (visiting.has(candidate)) {
      throw new TypeError('Companion projection must contain only JSON-compatible values')
    }
    visiting.add(candidate)
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
    } else {
      const prototype = Object.getPrototypeOf(candidate) as unknown
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Companion projection must contain only JSON-compatible values')
      }
      for (const item of Object.values(candidate)) visit(item)
    }
    visiting.delete(candidate)
  }
  visit(value)
}

const CONVERSATION_FIELDS = [
  'sessionId', 'nodes', 'turnTimings', 'turnEnds', 'partial', 'runningCalls', 'pending', 'queue',
  'running', 'subagent', 'composerPhase', 'removed', 'openState', 'openError', 'hasMore',
  'loadingOlder', 'promptError', 'blank', 'lastAgentError',
] as const

/**
 * Parse one authenticated conversation projection before it enters Mobile surface state.
 * Unknown node discriminants degrade to the shared unknown-node presentation; malformed known data is rejected.
 * @param value - decoded JSON value from the encrypted Companion codec.
 * @param expectedSessionId - Session identity carried by the enclosing protocol projection.
 * @returns normalized JSON projection accepted by the shared presentation adapter.
 */
export function parseMobileConversationProjection(
  value: unknown,
  expectedSessionId?: string,
): MobileConversationProjectionDto {
  assertCompanionJsonProjection(value)
  const record = projectionRecord(value)
  requireProjectionFields(record, CONVERSATION_FIELDS)
  const sessionId = projectionString(record.sessionId)
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) invalidConversationProjection()
  const nodes = projectionArray(record.nodes).map(parseConversationNode)
  const turnTimings = projectionArray(record.turnTimings).map((entry) => {
    const pair = projectionPair(entry)
    const timing = projectionRecord(pair[1])
    requireProjectionFields(timing, ['startTime'])
    const startTime = projectionFiniteNumber(timing.startTime)
    const endTime = timing.endTime === undefined ? undefined : projectionFiniteNumber(timing.endTime)
    return [projectionNonNegativeInteger(pair[0]), { startTime, ...(endTime === undefined ? {} : { endTime }) }] as const
  })
  const turnEnds = projectionArray(record.turnEnds).map((entry) => {
    const pair = projectionPair(entry)
    return [projectionNonNegativeInteger(pair[0]), projectionNonNegativeInteger(pair[1])] as const
  })
  const partial = record.partial === null ? null : parsePartialAssistant(record.partial)
  const runningCalls = projectionArray(record.runningCalls).map(parseRunningToolCall)
  const pending = projectionArray(record.pending).map(parsePendingInteraction)
  const queue = projectionArray(record.queue).map(parseQueuedMessage)
  const subagent = record.subagent === null ? null : parseSubagent(record.subagent)
  const openError = record.openError === null ? null : parseRpcError(record.openError)
  const promptError = record.promptError === null ? null : parsePromptError(record.promptError)
  const lastAgentError = record.lastAgentError === null ? null : projectionString(record.lastAgentError)
  return {
    sessionId,
    nodes: nodes as unknown as MobileConversationProjectionDto['nodes'],
    turnTimings,
    turnEnds,
    partial: partial as MobileConversationProjectionDto['partial'],
    runningCalls: runningCalls as unknown as MobileConversationProjectionDto['runningCalls'],
    pending,
    queue: queue as unknown as MobileConversationProjectionDto['queue'],
    running: projectionBoolean(record.running),
    subagent: subagent as MobileConversationProjectionDto['subagent'],
    composerPhase: projectionEnum(record.composerPhase, ['blank', 'engaging', 'active']),
    removed: projectionBoolean(record.removed),
    openState: projectionEnum(record.openState, ['cold', 'loading', 'open', 'error']),
    openError: openError as MobileConversationProjectionDto['openError'],
    hasMore: projectionBoolean(record.hasMore),
    loadingOlder: projectionBoolean(record.loadingOlder),
    promptError: promptError as MobileConversationProjectionDto['promptError'],
    blank: projectionBoolean(record.blank),
    lastAgentError,
  }
}

function parseConversationNode(value: unknown): CompanionJsonValue {
  const node = projectionRecord(value)
  const kind = projectionString(node.kind)
  const seq = projectionNonNegativeInteger(node.seq)
  const time = projectionFiniteNumber(node.time)
  switch (kind) {
    case 'user':
      parseContentBlocks(node.content)
      return { ...node, kind, seq, time }
    case 'steering':
      projectionString(node.messageId)
      parseContentBlocks(node.content)
      return { ...node, kind, seq, time }
    case 'assistant':
      projectionNonNegativeInteger(node.turn)
      projectionNonNegativeInteger(node.step)
      parseAssistantBlocks(node.blocks)
      if (node.messageId !== undefined) projectionString(node.messageId)
      if (node.interrupted !== undefined && node.interrupted !== true) invalidConversationProjection()
      return { ...node, kind, seq, time }
    case 'context': {
      parseContentBlocks(node.content)
      const provenance = projectionRecord(node.provenance)
      projectionEnum(provenance.role, ['inject', 'recall'])
      if (provenance.label !== null) projectionString(provenance.label)
      if (node.form !== null) projectionEnum(node.form, ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])
      return { ...node, kind, seq, time }
    }
    case 'model-retry':
      for (const field of ['retryId', 'provider', 'mode', 'policyKey', 'retryState'] as const) projectionString(node[field])
      for (const field of ['turn', 'step', 'retry', 'delayMs'] as const) projectionNonNegativeInteger(node[field])
      if (node.maxRetries !== undefined) projectionNonNegativeInteger(node.maxRetries)
      parseFailure(node.failure)
      return { ...node, kind, seq, time }
    case 'turn-error':
      projectionNonNegativeInteger(node.turn)
      projectionNonNegativeInteger(node.step)
      projectionString(node.message)
      if (node.code !== undefined) projectionString(node.code)
      return { ...node, kind, seq, time }
    case 'turn-max-tokens':
      projectionNonNegativeInteger(node.turn)
      projectionNonNegativeInteger(node.step)
      return { ...node, kind, seq, time }
    case 'tool-result':
      parseToolResultNode(node)
      return { ...node, kind, seq, time }
    case 'command':
      projectionString(node.commandId)
      if (node.name !== null) projectionString(node.name)
      if (node.args !== null) projectionString(node.args, true)
      if (node.outcome !== null) {
        const outcome = projectionRecord(node.outcome)
        projectionEnum(outcome.kind, ['success', 'error'])
        if (outcome.text !== undefined) projectionString(outcome.text, true)
        if (outcome.sourceEventSeq !== undefined) projectionNonNegativeInteger(outcome.sourceEventSeq)
      }
      return { ...node, kind, seq, time }
    case 'compaction':
      if (node.summary !== null) projectionString(node.summary, true)
      for (const field of ['summaryEventSeq', 'shadowedItemCount', 'shadowedTokenCount'] as const) {
        if (node[field] !== null) projectionNonNegativeInteger(node[field])
      }
      return { ...node, kind, seq, time }
    case 'unknown':
      projectionString(node.type)
      return { ...node, kind, seq, time }
    default:
      return { kind: 'unknown', seq, time, type: kind, data: node }
  }
}

function parseToolResultNode(node: Record<string, CompanionJsonValue>): void {
  projectionString(node.callId)
  if (node.call !== null) {
    const call = projectionRecord(node.call)
    projectionString(call.name)
    projectionString(call.argsRaw, true)
  }
  if (node.callTime !== null) projectionFiniteNumber(node.callTime)
  parseContentBlocks(node.content)
  projectionBoolean(node.isError)
  if (node.error !== undefined) {
    const error = projectionRecord(node.error)
    projectionString(error.name)
    projectionString(error.code)
  }
  parseToolCallView(node.callView)
  parseToolResultView(node.resultView)
  projectionArray(node.subCalls).forEach(parseToolCallBlock)
}

function parseToolCallBlock(value: unknown): void {
  const block = projectionRecord(value)
  if (block.kind === 'tool-result') {
    projectionNonNegativeInteger(block.seq)
    projectionFiniteNumber(block.time)
    parseToolResultNode(block)
    return
  }
  projectionString(block.callId)
  projectionString(block.name)
  projectionString(block.argsRaw, true)
  projectionNonNegativeInteger(block.turn)
  projectionNonNegativeInteger(block.step)
  projectionFiniteNumber(block.time)
  parseToolCallView(block.callView)
  projectionArray(block.subCalls).forEach(parseToolCallBlock)
}

function parseRunningToolCall(value: unknown): CompanionJsonValue {
  parseToolCallBlock(value)
  return projectionRecord(value)
}

function parseAssistantBlocks(value: unknown): void {
  for (const item of projectionArray(value)) {
    const block = projectionRecord(item)
    const kind = projectionString(block.kind)
    if (kind === 'text' || kind === 'reasoning') projectionString(block.text, true)
    else if (kind === 'image') parseImageAttachment(block.attachment)
    else if (kind === 'tool-call') {
      projectionString(block.callId)
      projectionString(block.name)
      projectionString(block.argsRaw, true)
    } else if (kind !== 'other') invalidConversationProjection()
  }
}

function parseContentBlocks(value: unknown): void {
  for (const item of projectionArray(value)) {
    const block = projectionRecord(item)
    const type = projectionString(block.type)
    if (type === 'text' || type === 'reasoning') projectionString(block.text, true)
    else if (type === 'image') parseImageAttachment(block.attachment)
    else if (type === 'tool-call') {
      projectionString(block.id)
      projectionString(block.name)
      projectionString(block.arguments, true)
    } else if (type === 'tool-result') {
      projectionString(block.toolCallId)
      parseContentBlocks(block.content)
      if (block.isError !== undefined) projectionBoolean(block.isError)
      if (block.loadedTools !== undefined) projectionArray(block.loadedTools)
    }
  }
}

function parseImageAttachment(value: unknown): void {
  const attachment = projectionRecord(value)
  projectionString(attachment.attachmentId)
  projectionEnum(attachment.mediaType, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  for (const field of ['bytes', 'width', 'height'] as const) projectionNonNegativeInteger(attachment[field])
  if (attachment.name !== undefined) projectionString(attachment.name, true)
  if (attachment.originalDimensions !== undefined) {
    const dimensions = projectionRecord(attachment.originalDimensions)
    projectionNonNegativeInteger(dimensions.width)
    projectionNonNegativeInteger(dimensions.height)
  }
}

function parsePendingInteraction(value: unknown): MobilePendingInteractionDto {
  const wait = projectionRecord(value)
  const kind = projectionEnum(wait.kind, ['approval', 'question'])
  const interactionId = projectionString(wait.interactionId)
  const sessionId = projectionString(wait.sessionId)
  const payload = projectionRecord(wait.payload)
  if (kind === 'approval') {
    projectionString(payload.approvalId)
    projectionString(payload.toolName)
    if (payload.callId !== undefined) projectionString(payload.callId)
    if (payload.reason !== undefined) projectionString(payload.reason, true)
  } else {
    const questions = projectionArray(payload.questions)
    if (questions.length === 0) invalidConversationProjection()
    for (const item of questions) parseQuestion(item)
  }
  return { kind, interactionId, sessionId, payload } as MobilePendingInteractionDto
}

function parseQuestion(value: unknown): void {
  const question = projectionRecord(value)
  projectionString(question.id)
  projectionString(question.question)
  for (const field of ['header', 'detail'] as const) {
    if (question[field] !== undefined) projectionString(question[field], true)
  }
  if (question.options !== undefined) {
    for (const item of projectionArray(question.options)) {
      const option = projectionRecord(item)
      projectionString(option.label)
      if (option.description !== undefined) projectionString(option.description, true)
    }
  }
  if (question.multiSelect !== undefined) projectionBoolean(question.multiSelect)
  if (question.intent !== undefined) {
    const intent = projectionRecord(question.intent)
    if (intent.kind !== 'plan-review') invalidConversationProjection()
    projectionString(intent.approve)
  }
}

function parsePartialAssistant(value: unknown): CompanionJsonValue {
  const partial = projectionRecord(value)
  projectionNonNegativeInteger(partial.turn)
  projectionNonNegativeInteger(partial.step)
  parseAssistantBlocks(partial.blocks)
  return partial
}

function parseQueuedMessage(value: unknown): CompanionJsonValue {
  const queued = projectionRecord(value)
  projectionString(queued.id)
  projectionString(queued.messageId)
  projectionEnum(queued.placement, ['queued', 'steering', 'context'])
  parseContentBlocks(queued.content)
  projectionString(queued.preview, true)
  if (queued.text !== null) projectionString(queued.text, true)
  return queued
}

function parseSubagent(value: unknown): CompanionJsonValue {
  const subagent = projectionRecord(value)
  projectionRecord(subagent.address)
  projectionBoolean(subagent.parentAvailable)
  return subagent
}

function parseRpcError(value: unknown): CompanionJsonValue {
  const error = projectionRecord(value)
  projectionString(error.code)
  projectionString(error.message, true)
  projectionRecord(error.details)
  return error
}

function parsePromptError(value: unknown): CompanionJsonValue {
  const prompt = projectionRecord(value)
  projectionEnum(prompt.op, ['send', 'stop'])
  parseRpcError(prompt.error)
  return prompt
}

function parseFailure(value: unknown): void {
  const failure = projectionRecord(value)
  projectionString(failure.code)
  projectionString(failure.message, true)
}

const TOOL_CALL_VIEW_PARSERS = {
  generic: parseGenericCallView,
  terminal: parseTerminalCallView,
  diff: parseDiffCallView,
} satisfies Record<MobileToolCallCard, PresentationRecordParser>

const TOOL_RESULT_VIEW_PARSERS = {
  generic: parseGenericResultView,
  terminal: parseTerminalResultView,
  diff: parseDiffResultView,
  search: parseSearchResultView,
  read: parseReadResultView,
  web: parseWebResultView,
} satisfies Record<MobileToolResultCard, PresentationRecordParser>

function parseToolCallView(value: unknown): void {
  parseToolView(value, TOOL_CALL_VIEW_PARSERS)
}

function parseToolResultView(value: unknown): void {
  parseToolView(value, TOOL_RESULT_VIEW_PARSERS)
}

function parseToolView(
  value: unknown,
  parsers: Readonly<Record<string, PresentationRecordParser>>,
): void {
  if (value === null) return
  const view = projectionRecord(value)
  const card = projectionString(view.card)
  const parser = parsers[card]
  if (Object.hasOwn(parsers, card) && parser !== undefined) parser(view)
}

function parseGenericCallView(view: Record<string, CompanionJsonValue>): void {
  projectionString(view.title)
  if (view.kind !== undefined) {
    projectionEnum(view.kind, ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])
  }
  if (view.content !== undefined) parseContentBlocks(view.content)
  if (view.locations !== undefined) parseFileLocations(view.locations)
}

function parseTerminalCallView(view: Record<string, CompanionJsonValue>): void {
  projectionString(view.title)
  for (const field of ['description', 'cwd'] as const) {
    if (view[field] !== undefined) projectionString(view[field], true)
  }
}

function parseDiffCallView(view: Record<string, CompanionJsonValue>): void {
  projectionString(view.title)
  parseFileDiffs(view.diffs)
  if (view.locations !== undefined) parseFileLocations(view.locations)
}

function parseGenericResultView(view: Record<string, CompanionJsonValue>): void {
  if (view.title !== undefined) projectionString(view.title, true)
  if (view.content !== undefined) parseContentBlocks(view.content)
}

function parseTerminalResultView(view: Record<string, CompanionJsonValue>): void {
  for (const field of ['title', 'output', 'signal'] as const) {
    if (view[field] !== undefined) projectionString(view[field], true)
  }
  if (view.exitCode !== undefined) projectionNonNegativeInteger(view.exitCode)
  if (view.exitCode !== undefined && view.signal !== undefined) invalidConversationProjection()
}

function parseDiffResultView(view: Record<string, CompanionJsonValue>): void {
  if (view.title !== undefined) projectionString(view.title, true)
  parseFileDiffs(view.diffs)
}

function parseSearchResultView(view: Record<string, CompanionJsonValue>): void {
  const shape = projectionEnum(view.shape, ['matches', 'paths'])
  if (view.title !== undefined) projectionString(view.title, true)
  projectionBoolean(view.truncated)
  projectionNonNegativeInteger(view.total)
  if (shape === 'paths') {
    for (const path of projectionArray(view.paths)) projectionString(path)
    return
  }
  for (const item of projectionArray(view.files)) {
    const file = projectionRecord(item)
    projectionString(file.path)
    for (const candidate of projectionArray(file.matches)) {
      const match = projectionRecord(candidate)
      projectionPositiveInteger(match.lineNumber)
      projectionString(match.line, true)
    }
  }
}

function parseReadResultView(view: Record<string, CompanionJsonValue>): void {
  if (view.title !== undefined) projectionString(view.title, true)
  projectionString(view.path)
  projectionPositiveInteger(view.offset)
  for (const item of projectionArray(view.lines)) {
    const line = projectionRecord(item)
    projectionPositiveInteger(line.number)
    projectionString(line.text, true)
  }
  projectionNonNegativeInteger(view.totalLines)
  if (view.lang !== undefined) projectionString(view.lang)
  if (view.content !== undefined) parseContentBlocks(view.content)
}

function parseWebResultView(view: Record<string, CompanionJsonValue>): void {
  const kind = projectionEnum(view.kind, ['search', 'fetch'])
  if (view.title !== undefined) projectionString(view.title, true)
  projectionBoolean(view.truncated)
  if (kind === 'fetch') {
    projectionString(view.url)
    projectionNonNegativeInteger(view.statusCode)
    return
  }
  for (const item of projectionArray(view.sources)) {
    const source = projectionRecord(item)
    projectionString(source.url)
    for (const field of ['title', 'snippet', 'publishedAt'] as const) {
      if (source[field] !== undefined) projectionString(source[field], true)
    }
  }
  if (view.answer !== undefined) projectionString(view.answer, true)
}

function parseFileDiffs(value: unknown): void {
  for (const item of projectionArray(value)) {
    const diff = projectionRecord(item)
    projectionString(diff.path)
    if (diff.oldText !== null) projectionString(diff.oldText, true)
    projectionString(diff.newText, true)
  }
}

function parseFileLocations(value: unknown): void {
  for (const item of projectionArray(value)) {
    const location = projectionRecord(item)
    projectionString(location.path)
    if (location.line !== undefined) projectionPositiveInteger(location.line)
  }
}

function projectionRecord(value: unknown): Record<string, CompanionJsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidConversationProjection()
  return value as Record<string, CompanionJsonValue>
}

function projectionArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidConversationProjection()
  return value
}

function projectionPair(value: unknown): readonly [CompanionJsonValue, CompanionJsonValue] {
  const pair = projectionArray(value)
  if (pair.length !== 2) invalidConversationProjection()
  return [pair[0] as CompanionJsonValue, pair[1] as CompanionJsonValue]
}

function requireProjectionFields(
  record: Record<string, CompanionJsonValue>,
  fields: readonly string[],
): void {
  if (fields.some(field => !Object.hasOwn(record, field))) invalidConversationProjection()
}

function projectionString(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) invalidConversationProjection()
  return value
}

function projectionBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidConversationProjection()
  return value
}

function projectionFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidConversationProjection()
  return value
}

function projectionNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidConversationProjection()
  return value as number
}

function projectionPositiveInteger(value: unknown): number {
  const number = projectionNonNegativeInteger(value)
  if (number === 0) invalidConversationProjection()
  return number
}

function projectionEnum<const Value extends string>(value: unknown, values: readonly Value[]): Value {
  if (typeof value !== 'string' || !values.includes(value as Value)) invalidConversationProjection()
  return value as Value
}

function invalidConversationProjection(): never {
  throw new Error('Authenticated Companion conversation projection is invalid')
}

/**
 * Build local shared-presentation carriers from an authenticated JSON projection.
 * @param dto - validated wire projection.
 * @param settle - generation-bound response adapter for pending interactions.
 * @returns Desktop-authoritative local presentation values.
 */
export function adaptMobileCompanionProjection(
  dto: MobileCompanionProjectionDto,
  settle: (request: MobilePendingSettlement) => Promise<MobilePendingSettlementReceipt>,
): AdaptedMobileCompanionProjection {
  const sessions = adaptSessions(dto.sessions)
  const workspaces = dto.workspaces.map(workspace => ({
    ...workspace,
    workspaceId: workspace.workspaceId as WorkspaceView['workspaceId'],
    sessionIds: workspace.sessionIds as SessionId[],
  }))
  const conversations: Partial<Record<SessionId, ConversationSnapshot>> = {}
  for (const candidate of dto.conversations) {
    const conversation = parseMobileConversationProjection(candidate)
    const sessionId = conversation.sessionId as SessionId
    conversations[sessionId] = adaptConversation(conversation, settle)
  }
  return { desktopName: dto.desktopName, sessions, workspaces, conversations }
}

function adaptSessions(dto: MobileSessionListDto): SessionListState {
  const byId = Object.fromEntries(Object.entries(dto.byId).map(([id, row]) => [id, {
    ...row,
    id: row.id as SessionId,
    ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
    ...(row.projectionValues === undefined ? {} : { projectionValues: row.projectionValues }),
  }])) as unknown as Record<SessionId, SessionSummary>
  return {
    ids: dto.ids as SessionId[],
    byId,
    current: dto.current === null ? undefined : dto.current as SessionId,
    phase: dto.phase,
    subagentsByParent: dto.subagentsByParent as unknown as SessionListState['subagentsByParent'],
    jobsBySession: dto.jobsBySession,
    currentAddress: dto.currentAddress === null
      ? undefined
      : dto.currentAddress,
  }
}

function adaptConversation(
  dto: MobileConversationProjectionDto,
  settle: (request: MobilePendingSettlement) => Promise<MobilePendingSettlementReceipt>,
): ConversationSnapshot {
  const sessionId = dto.sessionId as SessionId
  const nodes = dto.nodes as readonly ConversationNode[]
  const runningCalls = dto.runningCalls as readonly RunningToolCall[]
  const turnTimings = new Map(dto.turnTimings)
  const turnEnds = new Map(dto.turnEnds)
  const toolRoots = [
    ...nodes.filter((node): node is Extract<ConversationNode, { kind: 'tool-result' }> => node.kind === 'tool-result'),
    ...runningCalls,
  ]
  const chatNodes = toolRoots.map((root): ChatConversationViewNode => ({
    key: conversationContextKey('tool-call', root.callId),
    kind: 'tool-call',
    id: root.callId,
    target: 'chat',
    data: { root },
    anchorSeq: 'seq' in root ? root.seq : Number.MAX_SAFE_INTEGER,
    location: { kind: 'session' },
    visibility: 'visible',
  }))
  const chatNodeMap = new Map(chatNodes.map(node => [node.key, node]))
  const pending = dto.pending.map((wait) => {
    const respond = (result: MobilePendingSettlementResult): Promise<MobilePendingSettlementReceipt> => settle({
      kind: wait.kind,
      sessionId: localSessionId(wait.sessionId),
      interactionId: wait.interactionId,
      result,
    })
    return wait.kind === 'approval'
      ? new PendingWait(
        'approval', pendingRpcId(wait.interactionId), localSessionId(wait.sessionId),
        wait.payload, message => respond(message.result),
      )
      : new PendingWait(
        'question', pendingRpcId(wait.interactionId), localSessionId(wait.sessionId),
        wait.payload as unknown as PendingPayloads['question'], message => respond(message.result),
      )
  })
  return {
    sessionId,
    views: EMPTY_CONVERSATION_VIEWS,
    chat: {
      ...EMPTY_CHAT_SNAPSHOT,
      order: chatNodes.map(node => node.key),
      nodes: {
        get: key => chatNodeMap.get(key),
        values: () => chatNodes,
      },
      legacy: {
        nodes,
        turnTimings,
        turnEnds,
        partial: dto.partial,
        runningCalls,
      },
    },
    nodes,
    turnTimings,
    turnEnds,
    partial: dto.partial,
    runningCalls,
    pending,
    queue: dto.queue as readonly QueuedMessage[],
    running: dto.running,
    subagent: dto.subagent,
    composerPhase: dto.composerPhase,
    removed: dto.removed,
    openState: dto.openState,
    openError: dto.openError as ConversationSnapshot['openError'],
    hasMore: dto.hasMore,
    loadingOlder: dto.loadingOlder,
    promptError: dto.promptError as ConversationSnapshot['promptError'],
    blank: dto.blank,
    lastAgentError: dto.lastAgentError,
  }
}

function pendingRpcId(value: string): ConstructorParameters<typeof PendingWait>[1] {
  return value as ConstructorParameters<typeof PendingWait>[1]
}

function localSessionId(value: string): SessionId {
  return value as SessionId
}
