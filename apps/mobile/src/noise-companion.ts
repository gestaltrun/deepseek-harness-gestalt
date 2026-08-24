/** Mobile projection of authenticated Companion messages from one Snow IK attachment. */

import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'
import type {
  CompanionConversationSnapshotProjection,
  CompanionLiveSessionProjection,
  CompanionResult,
  CompanionSurfaceSnapshotProjection,
} from '@deepseek-ai/dsh-remote-protocol'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime } from './companion-lifecycle.ts'
import type {
  MobileCompanionProjectionDto, MobileConversationProjectionDto,
} from './companion-projection.ts'
import { parseMobileConversationProjection } from './companion-projection.ts'

interface MobileCompanionResultReceiver {
  /** @param result - decoded result authenticated by this physical channel. */
  acceptValidatedCompanionResult(result: CompanionResult): void
}

interface MobileCompanionSurfaceReceiver {
  /** @param message - authenticated Desktop surface baseline for this physical channel. */
  acceptValidatedDesktopResync(message: MobileCompanionProjectionDto): void
  /** @param projection - authenticated projection correlation checked before aggregate state changes. */
  acceptValidatedCompanionProjection(
    projection: CompanionConversationSnapshotProjection | CompanionSurfaceSnapshotProjection | CompanionLiveSessionProjection,
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
  private readonly pendingLive = new Map<string, CompanionLiveSessionProjection>()
  private surfaceComplete = false
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
    private readonly authenticatedDesktop?: (desktopName: string) => void,
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
    if (message.projection.type === 'session-live') {
      this.acceptLiveSession(message.projection)
      return message
    }
    if (message.projection.type !== 'foreground-sync') return message
    if (message.projection.generation !== this.generation) {
      throw new Error('Authenticated foreground synchronization belongs to another connection generation')
    }
    this.authenticatedDesktop?.(message.projection.desktopName)
    if (this.surfaceReceiver !== undefined) {
      const surface = this.surfaceReceiver()
      if (surface === undefined) throw new Error('Authenticated foreground synchronization has no Mobile surface')
      this.activeSurface = surface
      this.desktopName = message.projection.desktopName
      this.desktopRevision = message.projection.desktopRevision
      this.surfaceComplete = false
      this.pendingLive.clear()
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
    if (!projection.hasMore) {
      const visible = new Set(this.sessions.ids)
      for (const sessionId of this.conversations.keys()) {
        if (!visible.has(sessionId)) this.conversations.delete(sessionId)
      }
    }
    this.publishSurface()
    if (projection.hasMore) {
      this.surfaceComplete = false
      this.refreshSurface?.(this.sessions.ids.length)
      return
    }
    this.surfaceComplete = true
    this.flushPendingLive()
  }

  private acceptConversation(projection: CompanionConversationSnapshotProjection): void {
    this.requireProjectionGeneration(projection.generation, projection.desktopRevision)
    if (this.activeSurface?.acceptValidatedCompanionProjection(projection) !== true) return
    const conversation = parseMobileConversationProjection(projection.conversation, projection.sessionId)
    if (projection.beforeSeq === undefined) {
      this.conversations.set(projection.sessionId, conversation)
    } else {
      const current = this.conversations.get(projection.sessionId)
      if (current === undefined) throw new Error('Authenticated older Companion page has no current conversation')
      this.conversations.set(projection.sessionId, prependConversationPage(current, conversation, projection.beforeSeq))
    }
    this.publishSurface()
  }

  private acceptLiveSession(projection: CompanionLiveSessionProjection): void {
    if (projection.generation !== this.generation) {
      throw new Error('Authenticated Companion projection belongs to another connection generation')
    }
    if (this.activeSurface === undefined || this.desktopRevision === undefined) {
      throw new Error('Authenticated Companion projection arrived before foreground synchronization')
    }
    const pendingRevision = this.pendingLive.get(projection.sessionId)?.desktopRevision ?? -1
    if (projection.desktopRevision <= Math.max(this.desktopRevision, pendingRevision)) return
    if (!this.activeSurface.acceptValidatedCompanionProjection(projection)) return
    if (!this.surfaceComplete) {
      this.pendingLive.set(projection.sessionId, projection)
      if (this.pendingLive.size > REMOTE_PROTOCOL_LIMITS.liveProjectionPendingSessions) {
        throw new Error('Authenticated Companion live projection exceeded its pending Session ceiling')
      }
      return
    }
    this.desktopRevision = projection.desktopRevision
    this.applyLiveSession(projection)
    this.publishSurface()
  }

  private applyLiveSession(projection: CompanionLiveSessionProjection): void {
    const currentIds = this.sessions.ids.filter(id => id !== projection.sessionId)
    const byId = Object.fromEntries(
      Object.entries(this.sessions.byId).filter(([id]) => id !== projection.sessionId),
    )
    const workspaces = this.workspaces
      .map(workspace => ({
        ...workspace,
        sessionIds: workspace.sessionIds.filter(id => id !== projection.sessionId),
      }))
      .filter(workspace => workspace.sessionIds.length > 0)
    if ('removed' in projection) {
      this.sessions = { ...this.sessions, ids: currentIds, byId }
      this.workspaces = workspaces
      this.conversations.delete(projection.sessionId)
      return
    }
    if (projection.position > currentIds.length) {
      throw new Error('Authenticated Companion live Session position exceeds the synchronized list')
    }
    currentIds.splice(projection.position, 0, projection.sessionId)
    byId[projection.sessionId] = {
      id: projection.sessionId,
      displayTitle: projection.summary.displayTitle,
      ...(projection.summary.cwd === undefined ? {} : { cwd: projection.summary.cwd }),
      running: projection.summary.running,
      ...(projection.summary.pendingInteraction === undefined
        ? {} : { pendingInteraction: projection.summary.pendingInteraction }),
      blank: projection.summary.blank,
      updatedAt: projection.summary.updatedAt,
    }
    for (const projected of projection.workspaces) {
      const existing = workspaces.find(workspace => workspace.workspaceId === projected.workspaceId)
      if (existing === undefined) workspaces.push({ ...projected, sessionIds: [projection.sessionId] })
      else existing.sessionIds.push(projection.sessionId)
    }
    this.sessions = { ...this.sessions, ids: currentIds, byId }
    this.workspaces = workspaces
    if (projection.conversation !== undefined) {
      this.conversations.set(
        projection.sessionId,
        parseMobileConversationProjection(projection.conversation, projection.sessionId),
      )
    }
  }

  private flushPendingLive(): void {
    const pending = [...this.pendingLive.values()].sort((left, right) => left.desktopRevision - right.desktopRevision)
    this.pendingLive.clear()
    for (const projection of pending) {
      this.desktopRevision = Math.max(this.desktopRevision ?? 0, projection.desktopRevision)
      this.applyLiveSession(projection)
      this.publishSurface()
    }
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
