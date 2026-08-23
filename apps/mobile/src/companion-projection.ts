/** JSON wire projection and the sole adapter into shared Web presentation carriers. */

import {
  EMPTY_CHAT_SNAPSHOT,
  EMPTY_CONVERSATION_VIEWS,
  PendingWait,
  conversationContextKey,
  type ChatConversationViewNode,
  type ConversationNode,
  type ConversationSnapshot,
  type PartialAssistant,
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
export interface MobileSessionSummaryDto {
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
export interface MobileSessionListDto {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, MobileSessionSummaryDto>>
  readonly current: string | null
  readonly phase: SessionListState['phase']
  readonly subagentsByParent: JsonProjection<SessionListState['subagentsByParent']>
  readonly jobsBySession: JsonProjection<SessionListState['jobsBySession']>
  readonly currentAddress: JsonProjection<NonNullable<SessionListState['currentAddress']>> | null
}

/** JSON Workspace row used by shared Desktop grouping. */
export interface MobileWorkspaceDto {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Pending interaction data carries identity and domain payload, never a responder. */
export type MobilePendingInteractionDto = {
  [Kind in keyof PendingPayloads]: {
    readonly kind: Kind
    readonly interactionId: string
    readonly sessionId: string
    readonly payload: JsonProjection<PendingPayloads[Kind]>
  }
}[keyof PendingPayloads]

/** JSON conversation state needed by the shared narrow presentation. */
export interface MobileConversationProjectionDto {
  readonly sessionId: string
  readonly nodes: JsonProjection<readonly ConversationNode[]>
  readonly turnTimings: readonly (readonly [number, {
    readonly startTime: number
    readonly endTime?: number
  }])[]
  readonly turnEnds: readonly (readonly [number, number])[]
  readonly partial: JsonProjection<PartialAssistant> | null
  readonly runningCalls: JsonProjection<readonly RunningToolCall[]>
  readonly pending: readonly MobilePendingInteractionDto[]
  readonly queue: JsonProjection<readonly QueuedMessage[]>
  readonly running: boolean
  readonly subagent: JsonProjection<ConversationSnapshot['subagent']>
  readonly composerPhase: ConversationSnapshot['composerPhase']
  readonly removed: boolean
  readonly openState: ConversationSnapshot['openState']
  readonly openError: JsonProjection<ConversationSnapshot['openError']>
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly promptError: JsonProjection<ConversationSnapshot['promptError']>
  readonly blank: boolean
  readonly lastAgentError: string | null
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
  readonly sessionId: string
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
  for (const conversation of dto.conversations) {
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
      sessionId: wait.sessionId,
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
