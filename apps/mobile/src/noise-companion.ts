/** Mobile projection of authenticated Companion messages from one Snow IK attachment. */

import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'
import type {
  CompanionConversationSnapshotProjection,
  CompanionResult,
  CompanionSurfaceSnapshotProjection,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime } from './companion-lifecycle.ts'
import type {
  MobileCompanionProjectionDto, MobileConversationProjectionDto,
} from './companion-projection.ts'

interface MobileCompanionResultReceiver {
  /** @param result - decoded result authenticated by this physical channel. */
  acceptValidatedCompanionResult(result: CompanionResult): void
}

interface MobileCompanionSurfaceReceiver {
  /** @param message - authenticated Desktop surface baseline for this physical channel. */
  acceptValidatedDesktopResync(message: MobileCompanionProjectionDto): void
  /** @param projection - authenticated projection correlation checked before aggregate state changes. */
  acceptValidatedCompanionProjection(
    projection: CompanionConversationSnapshotProjection | CompanionSurfaceSnapshotProjection,
  ): boolean
}

/** Decrypts one physical connection's Companion frames before granting foreground synchronization. */
export class MobileNoiseCompanionReceiver {
  private activeSurface: MobileCompanionSurfaceReceiver | undefined
  private desktopName: string | undefined
  private desktopRevision: number | undefined
  private sessions: MobileCompanionProjectionDto['sessions'] = emptySessions()
  private workspaces: MobileCompanionProjectionDto['workspaces'] = []
  private readonly conversations = new Map<string, MobileConversationProjectionDto>()
  /**
   * @param channel - completed attachment-bound IK and Companion codec.
   * @param generation - physical connection generation bound into the IK prologue.
   * @param runtime - foreground authority owner.
   */
  constructor(
    private readonly channel: Pick<SnowCompanionProtocolChannel, 'open'>,
    private readonly generation: number,
    private readonly runtime: CompanionForegroundRuntime,
    private readonly resultReceiver?: () => MobileCompanionResultReceiver | undefined,
    private readonly surfaceReceiver?: () => MobileCompanionSurfaceReceiver | undefined,
    private readonly refreshSurface?: (offset: number) => void,
    private readonly reconcileOperations?: () => void,
  ) {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new TypeError('Mobile Noise Companion generation must be a positive safe integer')
    }
  }

  /**
   * Open and validate the next ordered Companion ciphertext.
   * @param ciphertext - next Snow transport message from the bound Desktop attachment.
   * @returns decoded message; a matching foreground sync also updates mutation authority.
   */
  receive(ciphertext: Uint8Array): ReturnType<SnowCompanionProtocolChannel['open']> {
    const message = this.channel.open(ciphertext)
    if (message.type === 'result') {
      const receiver = this.resultReceiver?.()
      if (receiver === undefined) throw new Error('Authenticated Companion result has no active Mobile surface')
      receiver.acceptValidatedCompanionResult(message.result)
      return message
    }
    if (message.type !== 'projection') return message
    if (message.projection.type === 'surface-snapshot') {
      this.acceptSurface(message.projection)
      return message
    }
    if (message.projection.type === 'conversation-snapshot') {
      this.acceptConversation(message.projection)
      return message
    }
    if (message.projection.type !== 'foreground-sync') return message
    if (message.projection.generation !== this.generation) {
      throw new Error('Authenticated foreground synchronization belongs to another connection generation')
    }
    if (this.surfaceReceiver !== undefined) {
      const surface = this.surfaceReceiver()
      if (surface === undefined) throw new Error('Authenticated foreground synchronization has no Mobile surface')
      this.activeSurface = surface
      this.desktopName = message.projection.desktopName
      this.desktopRevision = message.projection.desktopRevision
      surface.acceptValidatedDesktopResync({
        type: 'desktop-resync', version: 1, authenticated: true,
        desktopName: message.projection.desktopName,
        sessions: this.sessions,
        workspaces: [],
        conversations: [],
      })
      this.reconcileOperations?.()
      this.refreshSurface?.(0)
      return message
    }
    const receiver = this.runtime.bindValidatedDesktopResync()
    if (receiver === undefined || !receiver.acceptValidatedDesktopResync({
      type: 'desktop-resync',
      version: 1,
      authenticated: true,
    })) {
      throw new Error('Authenticated foreground synchronization has no active connection owner')
    }
    return message
  }

  private acceptSurface(projection: CompanionSurfaceSnapshotProjection): void {
    this.requireProjectionGeneration(projection.generation, projection.desktopRevision)
    if (this.activeSurface?.acceptValidatedCompanionProjection(projection) !== true) return
    this.desktopName = projection.desktopName
    if (projection.offset !== this.sessions.ids.length && projection.offset !== 0) {
      throw new Error('Authenticated Companion surface page is not contiguous')
    }
    const pageById = Object.fromEntries(projection.sessions.map(session => [session.sessionId, {
      id: session.sessionId,
      displayTitle: session.displayTitle,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      running: session.running,
      ...(session.pendingInteraction === undefined ? {} : { pendingInteraction: session.pendingInteraction }),
      blank: session.blank,
      updatedAt: session.updatedAt,
    }]))
    const pageIds = projection.sessions.map(session => session.sessionId)
    if (projection.offset !== 0 && pageIds.some(id => this.sessions.byId[id] !== undefined)) {
      throw new Error('Authenticated Companion surface page repeated a Session id')
    }
    this.sessions = {
      ids: projection.offset === 0 ? pageIds : [...this.sessions.ids, ...pageIds],
      byId: projection.offset === 0 ? pageById : { ...this.sessions.byId, ...pageById },
      current: null, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: null,
    }
    this.workspaces = projection.offset === 0
      ? projection.workspaces.map(workspace => ({ ...workspace }))
      : mergeWorkspacePage(this.workspaces, projection.workspaces)
    this.publishSurface()
    if (projection.hasMore) this.refreshSurface?.(this.sessions.ids.length)
  }

  private acceptConversation(projection: CompanionConversationSnapshotProjection): void {
    this.requireProjectionGeneration(projection.generation, projection.desktopRevision)
    if (this.activeSurface?.acceptValidatedCompanionProjection(projection) !== true) return
    if (!isRecord(projection.conversation) || projection.conversation.sessionId !== projection.sessionId) {
      throw new Error('Authenticated Companion conversation projection is invalid')
    }
    const conversation = projection.conversation as unknown as MobileConversationProjectionDto
    if (projection.beforeSeq === undefined) {
      this.conversations.set(projection.sessionId, conversation)
    } else {
      const current = this.conversations.get(projection.sessionId)
      if (current === undefined) throw new Error('Authenticated older Companion page has no current conversation')
      this.conversations.set(projection.sessionId, prependConversationPage(current, conversation, projection.beforeSeq))
    }
    this.publishSurface()
  }

  private requireProjectionGeneration(generation: number, desktopRevision: number): void {
    if (generation !== this.generation) throw new Error('Authenticated Companion projection belongs to another connection generation')
    if (this.activeSurface === undefined || this.desktopRevision === undefined) {
      throw new Error('Authenticated Companion projection arrived before foreground synchronization')
    }
    if (desktopRevision < this.desktopRevision) throw new Error('Authenticated Companion projection has a stale Desktop revision')
    this.desktopRevision = desktopRevision
  }

  private publishSurface(): void {
    if (this.activeSurface === undefined || this.desktopName === undefined) {
      throw new Error('Authenticated Companion projection has no active Mobile surface')
    }
    this.activeSurface.acceptValidatedDesktopResync({
      type: 'desktop-resync', version: 1, authenticated: true,
      desktopName: this.desktopName, sessions: this.sessions, workspaces: this.workspaces,
      conversations: [...this.conversations.values()],
    })
  }
}

function mergeWorkspacePage(
  current: MobileCompanionProjectionDto['workspaces'],
  page: CompanionSurfaceSnapshotProjection['workspaces'],
): MobileCompanionProjectionDto['workspaces'] {
  const merged = current.map(workspace => ({ ...workspace, sessionIds: [...workspace.sessionIds] }))
  for (const workspace of page) {
    const existing = merged.find(candidate => candidate.workspaceId === workspace.workspaceId)
    if (existing === undefined) {
      merged.push({ ...workspace, sessionIds: [...workspace.sessionIds] })
      continue
    }
    existing.sessionIds.push(...workspace.sessionIds)
  }
  return merged
}

function emptySessions(): MobileCompanionProjectionDto['sessions'] {
  return {
    ids: [], byId: {}, current: null, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function prependConversationPage(
  current: MobileConversationProjectionDto,
  older: MobileConversationProjectionDto,
  beforeSeq: number,
): MobileConversationProjectionDto {
  if (older.sessionId !== current.sessionId || older.nodes.some(node => nodeSeq(node) >= beforeSeq)) {
    throw new Error('Authenticated older Companion page is discontinuous')
  }
  const currentSeqs = new Set(current.nodes.map(nodeSeq))
  if (older.nodes.some(node => currentSeqs.has(nodeSeq(node)))) {
    throw new Error('Authenticated older Companion page repeats a current node')
  }
  return {
    ...current,
    nodes: [...older.nodes, ...current.nodes],
    hasMore: older.hasMore,
    pending: older.pending,
    running: older.running,
    composerPhase: older.composerPhase,
    promptError: older.promptError,
    lastAgentError: older.lastAgentError,
    loadingOlder: false,
  }
}

function nodeSeq(node: unknown): number {
  if (!isRecord(node) || !Number.isSafeInteger(node.seq) || (node.seq as number) < 0) {
    throw new Error('Authenticated Companion conversation node has an invalid seq')
  }
  return node.seq as number
}
