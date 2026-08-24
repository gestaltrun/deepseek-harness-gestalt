/** Desktop authority for product Companion attachments and Session search. */

import { createHash } from 'node:crypto'
import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  encodeProtocolBase64Url,
  parseCompanionInteractionId,
  parseCompanionSessionId,
  parseCompanionWorkspaceId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionAttachmentRejectedResult,
  type CompanionHostFailure,
  type CompanionOfferAttachmentOperation,
  type CompanionOperationFailedResult,
  type CompanionResult,
  type CompanionProjection,
  type CompanionLiveSessionProjection,
  type CompanionOperation,
  type CompanionOperationId,
  type CompanionSearchSessionsOperation,
  type CompanionSessionSearchResult,
  type CompanionSessionId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  CompanionAttachmentReceiveError,
  receiveCompanionAttachment,
} from './companion-attachments.ts'
import {
  createDesktopHostRpc,
  type DesktopHostRpc,
  type DesktopHostRpcOptions,
  type DesktopHostRpcResult,
} from './host-rpc.ts'
import type { DesktopCompanionOperationLedger } from './companion-operation-ledger.ts'
import { DesktopCompanionInteractionRegistry } from './companion-interactions.ts'
import {
  DesktopCompanionLiveProjectionSource,
  type DesktopCompanionLiveProjectionChange,
} from './companion-live-projection.ts'

/** Operations owned by the attachment and authoritative-search product bridge. */
export type CompanionProductOperation = Exclude<CompanionOperation, { type: 'query-operation-status' }>

/** One exact Host pending request retained only by Desktop endpoint memory. */
export interface DesktopPendingCompanionInteraction {
  rpcId: string
  kind: 'approval' | 'question'
  sessionId: CompanionSessionId
  approvalId?: string
}

/** One or more encrypted outputs produced by an allowlisted product operation. */
export type DesktopCompanionOperationOutput = CompanionResult | CompanionProjection | readonly CompanionResult[]

/** Live Session data before the current Snow attachment assigns generation and revision. */
export type DesktopCompanionLiveProjectionPayload = CompanionLiveSessionProjection extends infer Projection
  ? Projection extends CompanionLiveSessionProjection
    ? Omit<Projection, 'type' | 'generation' | 'desktopRevision'>
    : never
  : never

/** Desktop product dependencies scoped to one authenticated Personal Pairing. */
export interface CompanionProductOperationDependencies {
  /** Current Web Host unary RPC. */
  host: DesktopHostRpc
  /** Personal Pairing authenticated by the reviewed Companion channel. */
  pairingId: PersonalPairingId
  /** Independent key material for that exact Personal Pairing. */
  attachmentKey: Uint8Array
  /** Product clock used for capability expiry and confirmations. */
  now(): number
  /** Download ciphertext through the pairing-scoped remote-attachments capability. */
  downloadAttachment(
    offer: CompanionOfferAttachmentOperation,
    pairingId: PersonalPairingId,
  ): Promise<Uint8Array>
  /** Submit decrypted bytes into the Desktop-owned Session attachment path. */
  submitAttachment(input: {
    sessionId: CompanionOfferAttachmentOperation['sessionId']
    operationId: CompanionOfferAttachmentOperation['operationId']
    fileName: string
    mediaType: string
    plaintext: Uint8Array
  }): Promise<DesktopHostRpcResult>
  /** Physical Snow generation owning every emitted projection. */
  generation: number
  /** Current Desktop projection revision. */
  desktopRevision: number
  /** Platform-authenticated Desktop Installation presentation. */
  desktopName: string
  /** Resolve a pairing-private interaction id to one current Host request. */
  resolveInteraction(interactionId: ReturnType<typeof parseCompanionInteractionId>):
  DesktopPendingCompanionInteraction | undefined
  /** Current Host waits projected to this pairing's private ids. */
  pendingInteractions(sessionId: CompanionSessionId): readonly unknown[]
}

/** Per-pairing dependencies supplied by the reviewed Desktop channel owner. */
export type DesktopCompanionPairingDependencies = Omit<CompanionProductOperationDependencies, 'host'>

/** Shipped Desktop owner that follows Web Host replacement and executes decoded product operations. */
export class DesktopCompanionProductOwner {
  private installed: {
    readonly rpc: DesktopHostRpc
    readonly cancellation: AbortController
    streams?: { readonly cancellation: AbortController; readonly task: Promise<void> }
  } | undefined
  private ledger: DesktopCompanionOperationLedger | undefined
  private readonly interactions = new DesktopCompanionInteractionRegistry()
  private readonly surfaceDiscovery = new DesktopCompanionSurfaceDiscovery()
  private readonly liveProjection = new DesktopCompanionLiveProjectionSource()

  /** @param hostOptions - response bound and request deadline for every Web Host generation. */
  constructor(private readonly hostOptions: DesktopHostRpcOptions) {}

  /** @param ledger - durable pairing-scoped mutation idempotency owner. */
  installLedger(ledger: DesktopCompanionOperationLedger): void { this.ledger = ledger }

  /** Register one authenticated Snow connection for active Host projection. */
  connectLiveProjection(
    pairingId: PersonalPairingId,
    changed: (change: DesktopCompanionLiveProjectionChange) => void,
    disconnect: (error: Error) => void,
  ): () => void {
    const dispose = this.liveProjection.connect(pairingId, changed, disconnect)
    const installed = this.installed
    if (installed !== undefined) this.ensureHostStreams(installed)
    return () => {
      dispose()
      const current = this.installed
      if (!this.liveProjection.hasConnections() && current !== undefined) this.stopHostStreams(current)
    }
  }

  /** Whether one projected conversation still belongs to the pairing's current observation epoch. */
  retainsLiveConversation(
    pairingId: PersonalPairingId,
    change: DesktopCompanionLiveProjectionChange,
  ): boolean {
    return this.liveProjection.retainsConversation(pairingId, change)
  }

  /** Build one live replacement from the current Web Host for an authenticated pairing. */
  async projectLiveSession(
    change: DesktopCompanionLiveProjectionChange,
    attachmentKey: Uint8Array,
    signal: AbortSignal,
  ): Promise<DesktopCompanionLiveProjectionPayload> {
    if (change.type !== 'session') throw new Error('Desktop surface synchronization does not project one Session')
    const host = this.installed?.rpc
    if (host === undefined) throw new Error('Desktop Web Host is not available')
    return await projectDesktopCompanionLiveSession(change.sessionId, change.includeConversation, {
      host,
      pendingInteractions: sessionId => this.pendingInteractions(sessionId, attachmentKey),
    }, signal)
  }

  /** Return the exact pairing-scoped durable outcome for reconnect reconciliation. */
  async queryOperationStatus(
    pairingId: PersonalPairingId,
    operationId: CompanionOperationId,
  ): Promise<CompanionResult> {
    const original = await this.ledger?.query(pairingId, operationId)
    return original === undefined
      ? { type: 'status', operationId, absent: true }
      : { type: 'status', operationId, committed: requireMutationResult(original) }
  }

  /**
   * Install the current Web Host loopback RPC.
   * @param baseUrl - loopback origin emitted by the shipped Web Host.
   * @returns disposer that cannot remove a replacement installation.
   */
  installHost(baseUrl: string): () => void {
    const rpc = createDesktopHostRpc(baseUrl, this.hostOptions)
    const cancellation = new AbortController()
    const installed: NonNullable<DesktopCompanionProductOwner['installed']> = { rpc, cancellation }
    this.interactions.clear()
    this.surfaceDiscovery.clear()
    this.installed = installed
    if (this.liveProjection.hasConnections()) this.ensureHostStreams(installed)
    return () => {
      cancellation.abort()
      installed.streams?.cancellation.abort()
      if (this.installed === installed) {
        this.installed = undefined
        this.interactions.clear()
        this.surfaceDiscovery.clear()
        this.liveProjection.fail(new Error('Desktop Web Host is not available'))
      }
    }
  }

  /** Resolve one pairing-private interaction id against current Host pending state. */
  resolveInteraction(
    interactionId: ReturnType<typeof parseCompanionInteractionId>,
    attachmentKey: Uint8Array,
  ): DesktopPendingCompanionInteraction | undefined {
    return this.interactions.resolve(interactionId, attachmentKey)
  }

  /** Project current Host waits for one Session under this pairing's private ids. */
  pendingInteractions(sessionId: CompanionSessionId, attachmentKey: Uint8Array): readonly unknown[] {
    return this.interactions.project(sessionId, attachmentKey)
  }

  /**
   * Execute one operation decoded by the reviewed channel against the current Web Host.
   * @param operation - validated Companion operation.
   * @param dependencies - exact Personal Pairing identity, key, and attachment adapters.
   * @returns correlated product result; absent Web Host becomes a stable wire failure.
   */
  async handle(
    operation: CompanionProductOperation,
    dependencies: DesktopCompanionPairingDependencies,
  ): Promise<DesktopCompanionOperationOutput> {
    const host = this.installed?.rpc
    if (host === undefined) {
      return operationFailed(operation, {
        kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Web Host is not available',
      })
    }
    if (operation.type === 'observe-session') {
      this.liveProjection.observe(dependencies.pairingId, operation.sessionId)
      return {
        type: 'confirmed', operationId: operation.operationId,
        committedAt: dependencies.now(), outcome: 'accepted',
      }
    }
    const execute = async () => operation.type === 'refresh-surface'
      ? await this.surfaceDiscovery.refresh(operation, { ...dependencies, host })
      : await handleCompanionProductOperation(operation, { ...dependencies, host })
    if (!isLedgerMutation(operation)) return await execute()
    if (this.ledger === undefined) return operationFailed(operation, {
      kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Companion operation ledger is unavailable',
    })
    return await this.ledger.execute(dependencies.pairingId, operation, async () => {
      const output = await execute()
      if (isCompanionResultList(output) || isCompanionProjectionOutput(output)) {
        throw new Error('Desktop Companion mutation produced a projection')
      }
      return output
    })
  }

  private ensureHostStreams(installed: NonNullable<DesktopCompanionProductOwner['installed']>): void {
    if (installed.streams !== undefined || installed.cancellation.signal.aborted) return
    if (installed.rpc.watchMux === undefined || installed.rpc.watchHost === undefined) {
      this.liveProjection.fail(new Error('Desktop Web Host event streams are unavailable'))
      return
    }
    const cancellation = new AbortController()
    const abort = (): void => { cancellation.abort() }
    installed.cancellation.signal.addEventListener('abort', abort, { once: true })
    const task = Promise.all([
      installed.rpc.watchMux(cancellation.signal, (envelope) => { this.acceptMuxEnvelope(envelope) }),
      installed.rpc.watchHost(cancellation.signal, (envelope) => { this.acceptHostEnvelope(envelope) }),
    ]).then(() => undefined)
    const streams = { cancellation, task }
    installed.streams = streams
    void task.then(
      () => { this.finishHostStreams(installed, streams, undefined) },
      (error: unknown) => { this.finishHostStreams(installed, streams, error) },
    ).finally(() => { installed.cancellation.signal.removeEventListener('abort', abort) })
  }

  private stopHostStreams(installed: NonNullable<DesktopCompanionProductOwner['installed']>): void {
    const streams = installed.streams
    if (streams === undefined) return
    delete installed.streams
    streams.cancellation.abort()
  }

  private finishHostStreams(
    installed: NonNullable<DesktopCompanionProductOwner['installed']>,
    streams: NonNullable<NonNullable<DesktopCompanionProductOwner['installed']>['streams']>,
    failure: unknown,
  ): void {
    if (installed.streams !== streams) return
    delete installed.streams
    streams.cancellation.abort()
    if (installed.cancellation.signal.aborted || this.installed !== installed) return
    this.interactions.clear()
    const error = failure instanceof Error ? failure : new Error('Desktop Web Host event streams ended', { cause: failure })
    console.error('[desktop-companion] Host event streams failed:', error)
    this.liveProjection.fail(error)
  }

  private acceptMuxEnvelope(envelope: { rpcId: string; payload: unknown }): void {
    this.interactions.accept(envelope)
    const sessionId = hostEventSessionId(envelope.payload)
    if (sessionId !== undefined) this.liveProjection.changed(sessionId)
  }

  private acceptHostEnvelope(envelope: { rpcId: string; payload: unknown }): void {
    if (isHostSurfaceAuthorityEvent(envelope.payload)) {
      this.liveProjection.surfaceChanged()
      return
    }
    const sessionId = hostEventSessionId(envelope.payload)
    if (sessionId !== undefined) this.liveProjection.changed(sessionId)
  }

  /**
   * Submit decrypted bytes through the Desktop Web Host's Session attachment admission.
   * @param input - target Session, exact file name, and endpoint-decrypted bytes.
   * @returns Host result preserving HTTP, wire, business, and timeout failures.
   */
  async submitAttachment(input: {
    sessionId: CompanionOfferAttachmentOperation['sessionId']
    operationId: CompanionOfferAttachmentOperation['operationId']
    fileName: string
    mediaType: string
    plaintext: Uint8Array
  }): Promise<DesktopHostRpcResult> {
    const host = this.installed?.rpc
    if (host === undefined) {
      return { ok: false, failure: {
        kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Web Host is not available',
      } }
    }
    return await host.call('session.admitAttachment', {
      sessionId: input.sessionId,
      operationId: input.operationId,
      name: input.fileName,
      mediaType: input.mediaType,
      data: Buffer.from(input.plaintext).toString('base64'),
    }, this.hostOptions.attachmentTimeoutMs === undefined
      ? undefined
      : { timeoutMs: this.hostOptions.attachmentTimeoutMs })
  }
}

/**
 * Execute one attachment or search operation against the Paired Desktop authority.
 * @param operation - validated Encrypted Companion operation.
 * @param dependencies - pairing identity, attachment key, Web Host, and Session attachment path.
 * @returns correlated result that the encrypted channel can encode without loss.
 */
export async function handleCompanionProductOperation(
  operation: CompanionProductOperation,
  dependencies: CompanionProductOperationDependencies,
): Promise<DesktopCompanionOperationOutput> {
  switch (operation.type) {
    case 'create-session':
      return await createHostSession(operation, dependencies)
    case 'offer-attachment':
      return await receiveAttachment(operation, dependencies)
    case 'search-sessions':
      return await searchSessions(operation, dependencies.host)
    case 'refresh-surface':
      return await new DesktopCompanionSurfaceDiscovery().refresh(operation, dependencies)
    case 'load-history':
      return await loadHistory(operation, dependencies)
    case 'observe-session':
      return {
        type: 'confirmed', operationId: operation.operationId,
        committedAt: dependencies.now(), outcome: 'accepted',
      }
    case 'submit-prompt':
      return await acceptedHostMutation(operation, dependencies, 'session.prompt', {
        sessionId: operation.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: operation.text }],
      })
    case 'cancel-session':
      return await acceptedHostMutation(operation, dependencies, 'session.cancel', {
        sessionId: operation.sessionId,
      })
    case 'settle-interaction':
      return await settleInteraction(operation, dependencies)
    case 'read-image':
      return await readImage(operation, dependencies)
    default: {
      const never: never = operation
      return never
    }
  }
}

async function createHostSession(
  operation: Extract<CompanionProductOperation, { type: 'create-session' }>,
  dependencies: CompanionProductOperationDependencies,
): Promise<CompanionResult> {
  const response = await dependencies.host.call(
    'session.create',
    operation.workspaceId === undefined ? {} : { workspaceId: operation.workspaceId },
    { rpcId: operation.operationId },
  )
  if (!response.ok) return operationFailed(operation, normalizeFailure(response.failure))
  if (!isRecord(response.value)) return invalidHostResult(operation, 'session.create')
  let sessionId: ReturnType<typeof parseCompanionSessionId>
  try { sessionId = parseCompanionSessionId(response.value.sessionId) } catch { return invalidHostResult(operation, 'session.create') }
  return { type: 'session-created', operationId: operation.operationId, sessionId, committedAt: dependencies.now() }
}

interface DesktopSurfaceAuthoritySnapshot {
  readonly generation: number
  readonly sessionValue: unknown
  readonly workspaceValue: unknown
}

interface DesktopSurfaceDiscoveryState {
  readonly epoch: symbol
  readonly nextOffset: number
  readonly snapshot: DesktopSurfaceAuthoritySnapshot
}

/** Per-pairing stable authority snapshot for one complete paged Mobile discovery. */
export class DesktopCompanionSurfaceDiscovery {
  private readonly epochs = new Map<PersonalPairingId, symbol>()
  private readonly states = new Map<PersonalPairingId, DesktopSurfaceDiscoveryState>()

  /** Retire every incomplete discovery when the installed Host authority changes. */
  clear(): void {
    this.epochs.clear()
    this.states.clear()
  }

  /**
   * Project one page from a stable Session and Workspace authority snapshot.
   * @param operation - validated page offset and correlation.
   * @param dependencies - current pairing, Host, and physical generation.
   * @returns the correlated page or a fail-closed Host result.
   */
  async refresh(
    operation: Extract<CompanionProductOperation, { type: 'refresh-surface' }>,
    dependencies: CompanionProductOperationDependencies,
  ): Promise<CompanionProjection | CompanionOperationFailedResult> {
    if (operation.offset === 0) return await this.start(operation, dependencies)
    const state = this.states.get(dependencies.pairingId)
    if (state === undefined || state.nextOffset !== operation.offset
      || state.snapshot.generation !== dependencies.generation) {
      return invalidHostResult(operation, 'surface discovery cursor')
    }
    return this.project(operation, dependencies, state.epoch, state.snapshot)
  }

  private async start(
    operation: Extract<CompanionProductOperation, { type: 'refresh-surface' }>,
    dependencies: CompanionProductOperationDependencies,
  ): Promise<CompanionProjection | CompanionOperationFailedResult> {
    const epoch = Symbol('Desktop Companion surface discovery')
    this.epochs.set(dependencies.pairingId, epoch)
    this.states.delete(dependencies.pairingId)
    const [sessionResponse, workspaceResponse] = await Promise.all([
      dependencies.host.call('session.list', {}),
      dependencies.host.call('workspace.list', {}),
    ])
    if (!sessionResponse.ok) return operationFailed(operation, normalizeFailure(sessionResponse.failure))
    if (!workspaceResponse.ok) return operationFailed(operation, normalizeFailure(workspaceResponse.failure))
    const snapshot: DesktopSurfaceAuthoritySnapshot = {
      generation: dependencies.generation,
      sessionValue: sessionResponse.value,
      workspaceValue: workspaceResponse.value,
    }
    return this.project(operation, dependencies, epoch, snapshot)
  }

  private project(
    operation: Extract<CompanionProductOperation, { type: 'refresh-surface' }>,
    dependencies: CompanionProductOperationDependencies,
    epoch: symbol,
    snapshot: DesktopSurfaceAuthoritySnapshot,
  ): CompanionProjection | CompanionOperationFailedResult {
    if (this.epochs.get(dependencies.pairingId) !== epoch) {
      return invalidHostResult(operation, 'surface discovery owner')
    }
    const archived = parseArchivedSessionIds(snapshot.workspaceValue)
    if (archived === undefined) return invalidHostResult(operation, 'surface baseline')
    const visibleSessionValues = surfaceSessionValues(snapshot.sessionValue, archived)
    if (visibleSessionValues === undefined) return invalidHostResult(operation, 'surface baseline')
    const sessions = parseSurfaceSessions(visibleSessionValues, operation.offset)
    if (sessions === undefined) return invalidHostResult(operation, 'surface baseline')
    const workspaces = parseSurfaceWorkspaces(snapshot.workspaceValue, new Set(sessions.map(session => session.sessionId)))
    if (workspaces === undefined) return invalidHostResult(operation, 'surface baseline')
    const hasMore = visibleSessionValues.length > operation.offset + sessions.length
    if (hasMore) {
      this.states.set(dependencies.pairingId, {
        epoch,
        nextOffset: operation.offset + sessions.length,
        snapshot,
      })
    } else {
      this.states.delete(dependencies.pairingId)
    }
    return {
      type: 'surface-snapshot', operationId: operation.operationId,
      generation: dependencies.generation, desktopRevision: dependencies.desktopRevision,
      desktopName: dependencies.desktopName,
      offset: operation.offset,
      sessions,
      workspaces,
      hasMore,
    }
  }
}

async function loadHistory(
  operation: Extract<CompanionProductOperation, { type: 'load-history' }>,
  dependencies: CompanionProductOperationDependencies,
): Promise<CompanionProjection | CompanionOperationFailedResult> {
  const [response, sessionsResponse] = await Promise.all([
    dependencies.host.call('session.history', {
      sessionId: operation.sessionId,
      ...(operation.beforeSeq === undefined ? {} : { beforeSeq: operation.beforeSeq }),
      maxMessages: operation.maxMessages,
    }),
    dependencies.host.call('session.list', {}),
  ])
  if (!response.ok) return operationFailed(operation, normalizeFailure(response.failure))
  if (!sessionsResponse.ok) return operationFailed(operation, normalizeFailure(sessionsResponse.failure))
  const session = parseSurfaceSession(sessionsResponse.value, operation.sessionId)
  if (session === undefined) return invalidHostResult(operation, 'history Session status')
  const conversation = parseConversationHistory(
    response.value, operation.sessionId, dependencies.pendingInteractions(operation.sessionId), session.running,
  )
  if (conversation === undefined) return invalidHostResult(operation, 'history')
  return {
    type: 'conversation-snapshot', operationId: operation.operationId,
    generation: dependencies.generation, desktopRevision: dependencies.desktopRevision,
    sessionId: operation.sessionId,
    ...(operation.beforeSeq === undefined ? {} : { beforeSeq: operation.beforeSeq }),
    conversation,
  }
}

/**
 * Project one changed Session from current Host authority.
 * @param sessionId - Session named by a committed Host event.
 * @param includeConversation - whether this pairing currently displays the Session.
 * @param dependencies - current Host and pairing-private interaction projection.
 * @param signal - authenticated Snow attachment lifetime.
 * @returns one bounded replacement, or a removal when the Session left the authoritative list.
 */
export async function projectDesktopCompanionLiveSession(
  sessionId: CompanionSessionId,
  includeConversation: boolean,
  dependencies: Pick<CompanionProductOperationDependencies, 'host' | 'pendingInteractions'>,
  signal: AbortSignal,
): Promise<DesktopCompanionLiveProjectionPayload> {
  const requests = [
    dependencies.host.call('session.list', {}, { signal }),
    dependencies.host.call('workspace.list', {}, { signal }),
    ...(includeConversation
      ? [dependencies.host.call('session.history', {
        sessionId, maxMessages: REMOTE_PROTOCOL_LIMITS.historyPageMessages,
      }, { signal })]
      : []),
  ] as const
  const [sessionResponse, workspaceResponse, historyResponse] = await Promise.all(requests)
  if (!sessionResponse.ok) throw new Error(sessionResponse.failure.message)
  if (!workspaceResponse.ok) throw new Error(workspaceResponse.failure.message)
  if (!isRecord(sessionResponse.value) || !Array.isArray(sessionResponse.value.items)) {
    throw new Error('Desktop Host live Session list returned an invalid value')
  }
  const archived = parseArchivedSessionIds(workspaceResponse.value)
  if (archived === undefined) throw new Error('Desktop Host live Workspace projection returned an invalid value')
  if (archived.has(sessionId)) return { sessionId, removed: true }
  const visibleSessions = surfaceSessionValues(sessionResponse.value, archived)
  if (visibleSessions === undefined) throw new Error('Desktop Host live Session list returned an invalid value')
  const position = visibleSessions.findIndex(item => isRecord(item) && item.sessionId === sessionId)
  if (position === -1) return { sessionId, removed: true }
  const summary = parseSurfaceSessionRow(visibleSessions[position])
  if (summary === undefined || summary.sessionId !== sessionId) {
    throw new Error('Desktop Host live Session summary returned an invalid value')
  }
  const workspaces = parseSurfaceWorkspaces(workspaceResponse.value, new Set([sessionId]))
  if (workspaces === undefined) throw new Error('Desktop Host live Workspace projection returned an invalid value')
  if (!includeConversation) return { sessionId, position, summary, workspaces }
  if (historyResponse === undefined || !historyResponse.ok) {
    throw new Error(historyResponse === undefined
      ? 'Desktop Host live history response is unavailable'
      : historyResponse.failure.message)
  }
  const conversation = parseConversationHistory(
    historyResponse.value, sessionId, dependencies.pendingInteractions(sessionId), summary.running,
  )
  if (conversation === undefined) throw new Error('Desktop Host live conversation returned an invalid value')
  return { sessionId, position, summary, workspaces, conversation }
}

async function acceptedHostMutation(
  operation: Extract<CompanionProductOperation, { type: 'submit-prompt' | 'cancel-session' }>,
  dependencies: CompanionProductOperationDependencies,
  method: 'session.prompt' | 'session.cancel',
  payload: Record<string, unknown>,
): Promise<CompanionResult> {
  const response = await dependencies.host.call(method, payload, { rpcId: operation.operationId })
  if (!response.ok) return operationFailed(operation, normalizeFailure(response.failure))
  if (!isRecord(response.value) || response.value.accepted !== true) return invalidHostResult(operation, method)
  return { type: 'confirmed', operationId: operation.operationId, committedAt: dependencies.now(), outcome: 'accepted' }
}

async function settleInteraction(
  operation: Extract<CompanionProductOperation, { type: 'settle-interaction' }>,
  dependencies: CompanionProductOperationDependencies,
): Promise<CompanionResult> {
  const pending = dependencies.resolveInteraction(operation.interactionId)
  if (pending === undefined || pending.sessionId !== operation.sessionId
    || (operation.settlement.kind === 'approval' ? pending.kind !== 'approval' : pending.kind !== 'question')) {
    return { type: 'interaction-receipt', operationId: operation.operationId, accepted: false, reason: 'not-pending' }
  }
  const respond = dependencies.host.respond?.bind(dependencies.host)
  if (respond === undefined) return operationFailed(operation, {
    kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host interaction response is unavailable',
  })
  let result: Record<string, unknown>
  if (operation.settlement.kind === 'approval') {
    if (pending.approvalId === undefined) return { type: 'interaction-receipt', operationId: operation.operationId, accepted: false, reason: 'bad-response' }
    result = { ok: true, value: {
      sessionId: operation.sessionId, approvalId: pending.approvalId, outcome: operation.settlement.outcome,
    } }
  } else if (operation.settlement.kind === 'question') {
    result = { ok: true, value: { sessionId: operation.sessionId, answer: { answers: operation.settlement.answers } } }
  } else {
    result = { ok: false, error: { code: 'cancelled', message: 'Mobile user cancelled Ask User', details: {} } }
  }
  const receipt = await respond(pending.rpcId, result)
  return { type: 'interaction-receipt', operationId: operation.operationId, ...receipt }
}

async function readImage(
  operation: Extract<CompanionProductOperation, { type: 'read-image' }>,
  dependencies: CompanionProductOperationDependencies,
): Promise<CompanionResult | readonly CompanionResult[]> {
  const response = await dependencies.host.call('session.attachment', {
    sessionId: operation.sessionId, attachmentId: operation.attachmentId,
  })
  if (!response.ok) return operationFailed(operation, normalizeFailure(response.failure))
  if (!isRecord(response.value) || !isRecord(response.value.attachment)
    || typeof response.value.data !== 'string' || typeof response.value.attachment.mediaType !== 'string') {
    return invalidHostResult(operation, 'image')
  }
  let bytes: Uint8Array
  try { bytes = new Uint8Array(Buffer.from(response.value.data, 'base64')) } catch { return invalidHostResult(operation, 'image') }
  if (Buffer.from(bytes).toString('base64') !== response.value.data) return invalidHostResult(operation, 'image')
  const chunks: CompanionResult[] = []
  const count = Math.max(1, Math.ceil(bytes.byteLength / REMOTE_PROTOCOL_LIMITS.imageChunkBytes))
  if (count > REMOTE_PROTOCOL_LIMITS.imageChunks) return operationFailed(operation, {
    kind: 'business', code: 'limit-exceeded', message: 'Desktop image exceeds the Companion byte ceiling',
  })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  for (let index = 0; index < count; index++) {
    const start = index * REMOTE_PROTOCOL_LIMITS.imageChunkBytes
    chunks.push({
      type: 'image-chunk', operationId: operation.operationId, sessionId: operation.sessionId,
      attachmentId: operation.attachmentId, mediaType: response.value.attachment.mediaType,
      index, count, sha256,
      data: encodeProtocolBase64Url(bytes.subarray(start, start + REMOTE_PROTOCOL_LIMITS.imageChunkBytes)),
    })
  }
  return chunks.length === 1 ? chunks[0] as CompanionResult : chunks
}

class HostSubmissionFailure extends Error {
  constructor(readonly failure: CompanionHostFailure) {
    super(failure.message)
    this.name = 'HostSubmissionFailure'
  }
}

async function receiveAttachment(
  operation: CompanionOfferAttachmentOperation,
  dependencies: CompanionProductOperationDependencies,
): Promise<CompanionResult> {
  try {
    await receiveCompanionAttachment(operation, {
      pairingId: dependencies.pairingId,
      attachmentKey: dependencies.attachmentKey,
      now: dependencies.now(),
      download: async (offer, pairingId) => await dependencies.downloadAttachment(offer, pairingId),
      submit: async ({ fileName, plaintext }) => {
        const submitted = await dependencies.submitAttachment({
          sessionId: operation.sessionId,
          operationId: operation.operationId,
          fileName,
          mediaType: operation.mediaType,
          plaintext,
        })
        if (!submitted.ok) throw new HostSubmissionFailure(normalizeFailure(submitted.failure))
      },
    })
    return {
      type: 'confirmed',
      operationId: operation.operationId,
      committedAt: dependencies.now(),
      outcome: 'accepted',
    }
  } catch (error) {
    if (error instanceof CompanionAttachmentReceiveError) {
      return attachmentRejected(operation, error.reason)
    }
    if (error instanceof HostSubmissionFailure) return operationFailed(operation, error.failure)
    return operationFailed(operation, {
      kind: 'business',
      code: 'host-error',
      message: 'Desktop Session attachment submission failed',
    })
  }
}

async function searchSessions(
  operation: CompanionSearchSessionsOperation,
  host: DesktopHostRpc,
): Promise<CompanionSessionSearchResult | CompanionOperationFailedResult> {
  const response = await host.call('session.search', { query: operation.query })
  if (!response.ok) return operationFailed(operation, normalizeFailure(response.failure))
  const parsed = parseSearchValue(response.value)
  if (parsed === undefined) {
    return operationFailed(operation, {
      kind: 'wire',
      code: 'HOST_WIRE_INVALID',
      message: 'Desktop Host session.search returned an invalid value',
    })
  }
  return { type: 'session-search', operationId: operation.operationId, ...parsed }
}

function parseSearchValue(value: unknown): Omit<CompanionSessionSearchResult, 'type' | 'operationId'> | undefined {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.hasMore !== 'boolean'
    || value.items.length > REMOTE_PROTOCOL_LIMITS.sessionSearchResults) return undefined
  const items: CompanionSessionSearchResult['items'][number][] = []
  const sessionIds = new Set<string>()
  for (const valueItem of value.items) {
    if (!isRecord(valueItem) || typeof valueItem.sessionId !== 'string' || typeof valueItem.snippet !== 'string'
      || codePointCount(valueItem.snippet) > REMOTE_PROTOCOL_LIMITS.sessionSearchSnippetCodePoints) return undefined
    let sessionId
    try {
      sessionId = parseCompanionSessionId(valueItem.sessionId)
    } catch {
      return undefined
    }
    if (sessionIds.has(sessionId)) return undefined
    sessionIds.add(sessionId)
    items.push({ sessionId, snippet: valueItem.snippet })
  }
  return { items, hasMore: value.hasMore }
}

function parseSurfaceSessions(
  values: readonly unknown[],
  offset = 0,
): Array<{
  sessionId: CompanionSessionId
  displayTitle: string
  cwd?: string
  running: boolean
  blank: boolean
  updatedAt: number
}> | undefined {
  const sessions: Array<{
    sessionId: CompanionSessionId
    displayTitle: string
    cwd?: string
    running: boolean
    blank: boolean
    updatedAt: number
  }> = []
  for (const itemValue of values.slice(offset, offset + REMOTE_PROTOCOL_LIMITS.surfaceSessionRows)) {
    const session = parseSurfaceSessionRow(itemValue)
    if (session === undefined) return undefined
    sessions.push(session)
  }
  return sessions
}

function surfaceSessionValues(
  value: unknown,
  archived: ReadonlySet<CompanionSessionId>,
): unknown[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  const items: unknown[] = value.items
  return items.filter((item) => {
    if (!isRecord(item) || typeof item.sessionId !== 'string') return true
    try { return !archived.has(parseCompanionSessionId(item.sessionId)) } catch { return true }
  })
}

function parseArchivedSessionIds(value: unknown): Set<CompanionSessionId> | undefined {
  if (!isRecord(value) || !Array.isArray(value.archivedSessionIds)) return undefined
  const archived = new Set<CompanionSessionId>()
  try {
    for (const sessionId of value.archivedSessionIds) archived.add(parseCompanionSessionId(sessionId))
  } catch {
    return undefined
  }
  return archived
}

function parseSurfaceSession(
  value: unknown,
  target: CompanionSessionId,
): ReturnType<typeof parseSurfaceSessionRow> {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  const items = value.items as unknown[]
  const candidate = items.find(item => isRecord(item) && item.sessionId === target)
  return parseSurfaceSessionRow(candidate)
}

function parseSurfaceSessionRow(itemValue: unknown): {
  sessionId: CompanionSessionId
  displayTitle: string
  cwd?: string
  running: boolean
  blank: boolean
  updatedAt: number
} | undefined {
  if (!isRecord(itemValue) || typeof itemValue.sessionId !== 'string'
    || typeof itemValue.updatedAt !== 'number' || !Number.isSafeInteger(itemValue.updatedAt)
    || typeof itemValue.running !== 'boolean' || typeof itemValue.blank !== 'boolean') return undefined
  let sessionId: CompanionSessionId
  try { sessionId = parseCompanionSessionId(itemValue.sessionId) } catch { return undefined }
  const title = projectionTitle(itemValue.projections) ?? itemValue.sessionId
  if (typeof itemValue.cwd !== 'string' && itemValue.cwd !== undefined) return undefined
  return {
    sessionId, displayTitle: title,
    ...(itemValue.cwd === undefined ? {} : { cwd: itemValue.cwd }),
    running: itemValue.running, blank: itemValue.blank, updatedAt: itemValue.updatedAt,
  }
}

function projectionTitle(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.values)) return undefined
  const title = value.values.title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

function parseSurfaceWorkspaces(
  value: unknown,
  visible: ReadonlySet<CompanionSessionId>,
): Array<{
  workspaceId: ReturnType<typeof parseCompanionWorkspaceId>
  path: string
  title: string
  sessionIds: CompanionSessionId[]
  createdAt: string
  updatedAt: string
}> | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  const workspaces = []
  for (const itemValue of value.items) {
    if (!isRecord(itemValue) || typeof itemValue.workspaceId !== 'string' || typeof itemValue.path !== 'string'
      || typeof itemValue.title !== 'string' || !Array.isArray(itemValue.sessionIds)
      || typeof itemValue.createdAt !== 'string' || typeof itemValue.updatedAt !== 'string') return undefined
    const sessionIds: CompanionSessionId[] = []
    for (const id of itemValue.sessionIds) {
      let parsed: CompanionSessionId
      try { parsed = parseCompanionSessionId(id) } catch { return undefined }
      if (visible.has(parsed)) sessionIds.push(parsed)
    }
    if (sessionIds.length === 0) continue
    workspaces.push({
      workspaceId: parseCompanionWorkspaceId(itemValue.workspaceId), path: itemValue.path, title: itemValue.title,
      sessionIds, createdAt: itemValue.createdAt, updatedAt: itemValue.updatedAt,
    })
    if (workspaces.length > REMOTE_PROTOCOL_LIMITS.surfaceWorkspaceRows) return undefined
  }
  return workspaces
}

function parseConversationHistory(
  value: unknown,
  sessionId: CompanionSessionId,
  pending: readonly unknown[],
  running: boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.events) || typeof value.hasMore !== 'boolean') return undefined
  const nodes: Array<Record<string, unknown>> = []
  const calls = new Map<string, { name: string; argsRaw: string; time: number; view: unknown }>()
  const steps = new Map<number, number>()
  const retryAttempts = new Map<string, number>()
  const retryTurns = new Set<number>()
  const closedTurns = new Set<number>()
  let partial: { turn: number; step: number; blocks: Array<Record<string, unknown> | undefined> } | undefined
  for (const entryValue of value.events) {
    if (!isRecord(entryValue) || !isRecord(entryValue.event)) return undefined
    const event = entryValue.event
    if (!isSafeInteger(event.seq) || typeof event.time !== 'number' || !isRecord(event.data)) return undefined
    if (event.type === 'assistant/chunk') {
      if (!isSafeInteger(event.data.turn) || !isSafeInteger(event.data.step) || !isRecord(event.data.chunk)) return undefined
      if (partial === undefined || partial.turn !== event.data.turn || partial.step !== event.data.step) {
        partial = { turn: event.data.turn, step: event.data.step, blocks: [] }
      }
      if (!applyLiveAssistantChunk(partial.blocks, event.data.chunk)) return undefined
    } else if (event.type === 'user/message') {
      if (!Array.isArray(event.data.content)) return undefined
      const source = event.data.source ?? {}
      const sourceKind = isRecord(source) ? source.kind : undefined
      if (sourceKind === 'user') {
        nodes.push({ kind: 'user', seq: event.seq, time: event.time, content: event.data.content, source })
      } else if (sourceKind === 'steering' && typeof event.data.id === 'string') {
        nodes.push({
          kind: 'steering', messageId: event.data.id, seq: event.seq, time: event.time,
          content: event.data.content, source,
        })
      } else {
        nodes.push({ kind: 'unknown', seq: event.seq, time: event.time, type: event.type, data: event.data })
      }
    } else if (event.type === 'assistant/message') {
      const message = event.data.message
      if (!isRecord(message) || !Array.isArray(message.content)) return undefined
      nodes.push({
        kind: 'assistant', seq: event.seq, time: event.time,
        messageId: typeof message.id === 'string' ? message.id : undefined,
        turn: numberOr(event.data.turn, 0), step: numberOr(event.data.step, 0),
        blocks: message.content.map(assistantBlock),
      })
      if (partial?.turn === numberOr(event.data.turn, 0) && partial.step === numberOr(event.data.step, 0)) {
        partial = undefined
      }
    } else if (event.type === 'tool/call') {
      const callId = event.data.callId
      if (typeof callId !== 'string') return undefined
      calls.set(callId, {
        name: typeof event.data.name === 'string' ? event.data.name : callId,
        argsRaw: typeof event.data.arguments === 'string' ? event.data.arguments : '{}',
        time: event.time,
        view: entryValue.view,
      })
    } else if (event.type === 'tool/result') {
      const message = event.data.message
      if (!isRecord(message) || !isRecord(message.source) || typeof message.source.callId !== 'string'
        || !Array.isArray(message.content)) return undefined
      const call = calls.get(message.source.callId)
      nodes.push({
        kind: 'tool-result', seq: event.seq, time: event.time, callId: message.source.callId,
        call: call === undefined ? null : { name: call.name, argsRaw: call.argsRaw },
        callTime: call?.time ?? null, content: message.content,
        isError: event.data.isError === true, callView: call?.view ?? null,
        ...(isRecord(event.data.error) && typeof event.data.error.name === 'string'
          && typeof event.data.error.code === 'string' ? { error: event.data.error } : {}),
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
        resultView: entryValue.view ?? null, subCalls: [],
      })
    } else if (event.type === 'step/start') {
      if (!isSafeInteger(event.data.turn) || !isSafeInteger(event.data.step)) return undefined
      steps.set(event.data.turn, event.data.step)
    } else if (event.type === 'llm/retry') {
      const retry = parseModelRetry(event.data, event.seq, event.time)
      if (retry === undefined) return undefined
      const retryKey = modelRetryKey(retry.retryId, retry.retry)
      if (retryAttempts.has(retryKey)) return undefined
      retryAttempts.set(retryKey, nodes.length)
      retryTurns.add(retry.turn)
      nodes.push(retry)
    } else if (event.type === 'llm/retry-started') {
      if (typeof event.data.retryId !== 'string' || event.data.retryId === ''
        || !isSafeInteger(event.data.turn) || !isSafeInteger(event.data.step)
        || !isSafeInteger(event.data.retry)) return undefined
      const index = retryAttempts.get(modelRetryKey(event.data.retryId, event.data.retry))
      if (index === undefined) return undefined
      const retry = nodes[index]
      if (retry?.kind !== 'model-retry' || retry.turn !== event.data.turn || retry.step !== event.data.step
        || retry.retryState !== 'scheduled') return undefined
      nodes[index] = { ...retry, retryState: 'started' }
    } else if (event.type === 'turn/end') {
      if (!isSafeInteger(event.data.turn) || !isRecord(event.data.reason)) return undefined
      const turn = event.data.turn
      if (partial?.turn === turn) partial = undefined
      closedTurns.add(turn)
      if (event.data.reason.kind === 'error') {
        const error = event.data.reason.error
        if (!isRecord(error) || typeof error.message !== 'string') return undefined
        nodes.push({
          kind: 'turn-error', seq: event.seq, time: event.time, turn, step: steps.get(turn) ?? 0,
          message: error.message,
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
        })
      } else if (event.data.reason.kind === 'max-tokens') {
        nodes.push({ kind: 'turn-max-tokens', seq: event.seq, time: event.time, turn, step: steps.get(turn) ?? 0 })
      }
    }
  }
  const visibleNodes = nodes.flatMap((node) => {
    if (node.kind === 'turn-error' && retryTurns.has(node.turn as number)) return []
    if (node.kind === 'model-retry' && node.retryState === 'scheduled' && closedTurns.has(node.turn as number)) {
      return [{ ...node, retryState: 'cancelled' }]
    }
    return [node]
  })
  return {
    sessionId,
    nodes: visibleNodes,
    turnTimings: [], turnEnds: [],
    partial: partial === undefined ? null : {
      turn: partial.turn, step: partial.step,
      blocks: partial.blocks.filter((block): block is Record<string, unknown> => block !== undefined),
    },
    runningCalls: [], pending, queue: [],
    running, subagent: null, composerPhase: nodes.length === 0 && !running ? 'pristine' : 'active',
    removed: false, openState: 'open', openError: null, hasMore: value.hasMore,
    loadingOlder: false, promptError: null, blank: nodes.length === 0, lastAgentError: null,
  }
}

function applyLiveAssistantChunk(
  blocks: Array<Record<string, unknown> | undefined>,
  chunk: Record<string, unknown>,
): boolean {
  if (!isSafeInteger(chunk.index)) {
    return chunk.type === 'usage' || chunk.type === 'finish'
  }
  const index = chunk.index
  if (chunk.type === 'block-start' && typeof chunk.blockType === 'string') {
    blocks[index] = chunk.blockType === 'text' || chunk.blockType === 'reasoning'
      ? { kind: chunk.blockType, text: '' }
      : chunk.blockType === 'tool-call'
        ? { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
        : { kind: 'other', block: null }
    return true
  }
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    const previous = blocks[index]
    blocks[index] = { kind: 'text', text: (previous?.kind === 'text' ? String(previous.text) : '') + chunk.text }
    return true
  }
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
    const previous = blocks[index]
    blocks[index] = { kind: 'reasoning', text: (previous?.kind === 'reasoning' ? String(previous.text) : '') + chunk.text }
    return true
  }
  if (chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string') {
    const previous = blocks[index]
    const chunkId = typeof chunk.id === 'string' ? chunk.id : ''
    blocks[index] = {
      kind: 'tool-call',
      callId: previous?.kind === 'tool-call' && typeof previous.callId === 'string'
        ? previous.callId || chunkId
        : chunkId,
      name: typeof chunk.name === 'string'
        ? chunk.name
        : previous?.kind === 'tool-call' && typeof previous.name === 'string' ? previous.name : '',
      argsRaw: (previous?.kind === 'tool-call' && typeof previous.argsRaw === 'string' ? previous.argsRaw : '')
        + chunk.argumentsDelta,
    }
    return true
  }
  if (chunk.type === 'block-end' && 'block' in chunk) {
    blocks[index] = assistantBlock(chunk.block)
    return true
  }
  return false
}

interface ProjectedModelRetry extends Record<string, unknown> {
  kind: 'model-retry'
  retryId: string
  turn: number
  step: number
  retry: number
  retryState: 'scheduled' | 'started' | 'cancelled'
}

function parseModelRetry(
  data: Record<string, unknown>,
  seq: number,
  time: number,
): ProjectedModelRetry | undefined {
  if (typeof data.retryId !== 'string' || data.retryId === ''
    || !isSafeInteger(data.turn) || !isSafeInteger(data.step)
    || typeof data.provider !== 'string' || data.provider === ''
    || (data.mode !== 'normal' && data.mode !== 'always')
    || typeof data.policyKey !== 'string' || data.policyKey === ''
    || !isSafeInteger(data.retry) || !isSafeInteger(data.delayMs)
    || !isRecord(data.failure) || typeof data.failure.code !== 'string'
    || typeof data.failure.message !== 'string') return undefined
  if (data.mode === 'normal' && !isSafeInteger(data.maxRetries)) return undefined
  return {
    kind: 'model-retry', seq, time, retryState: 'scheduled',
    retryId: data.retryId, turn: data.turn, step: data.step,
    provider: data.provider, mode: data.mode, policyKey: data.policyKey,
    retry: data.retry, ...(data.mode === 'normal' ? { maxRetries: data.maxRetries } : {}),
    delayMs: data.delayMs, failure: data.failure,
  }
}

function modelRetryKey(retryId: string, retry: number): string {
  return `${retryId}\0${String(retry)}`
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function assistantBlock(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.type !== 'string') return { kind: 'other', block: value }
  if (value.type === 'text' || value.type === 'reasoning') {
    return { kind: value.type, text: typeof value.text === 'string' ? value.text : '' }
  }
  if (value.type === 'image') return { kind: 'image', attachment: value.attachment }
  if (value.type === 'tool-call') return {
    kind: 'tool-call', callId: String(value.id), name: value.name, argsRaw: value.arguments,
  }
  return { kind: 'other', block: value }
}

function numberOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? value as number : fallback
}

function invalidHostResult(
  operation: CompanionProductOperation,
  subject: string,
): CompanionOperationFailedResult {
  return operationFailed(operation, {
    kind: 'wire', code: 'HOST_WIRE_INVALID', message: `Desktop Host ${subject} returned an invalid value`,
  })
}

function isLedgerMutation(operation: CompanionProductOperation): boolean {
  return operation.type === 'create-session' || operation.type === 'submit-prompt' || operation.type === 'cancel-session'
    || operation.type === 'settle-interaction' || operation.type === 'offer-attachment'
}

function isCompanionResultList(
  output: DesktopCompanionOperationOutput,
): output is readonly CompanionResult[] {
  return Array.isArray(output)
}

function requireMutationResult(result: CompanionResult): Exclude<CompanionResult, { type: 'status' | 'session-search' | 'image-chunk' }> {
  if (result.type === 'confirmed' || result.type === 'session-created' || result.type === 'attachment-rejected'
    || result.type === 'operation-failed' || result.type === 'interaction-receipt') return result
  throw new Error('Desktop Companion operation ledger contains a non-mutation result')
}

function isCompanionProjectionOutput(
  output: CompanionResult | CompanionProjection,
): output is CompanionProjection {
  return output.type === 'surface-snapshot' || output.type === 'conversation-snapshot'
    || output.type === 'transcript-page' || output.type === 'foreground-sync' || output.type === 'session-live'
}

function attachmentRejected(
  operation: CompanionOfferAttachmentOperation,
  reason: CompanionAttachmentRejectedResult['reason'],
): CompanionAttachmentRejectedResult {
  return { type: 'attachment-rejected', operationId: operation.operationId, reason }
}

function operationFailed(
  operation: CompanionProductOperation,
  failure: CompanionHostFailure,
): CompanionOperationFailedResult {
  return { type: 'operation-failed', operationId: operation.operationId, failure }
}

function normalizeFailure(failure: CompanionHostFailure): CompanionHostFailure {
  const messageBytes = new TextEncoder().encode(failure.message).byteLength
  if (messageBytes === 0 || messageBytes > REMOTE_PROTOCOL_LIMITS.hostFailureMessageBytes) {
    return { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host failure exceeded its wire contract' }
  }
  if (failure.kind !== 'business') return failure
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(failure.code)) {
    return { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host business error code was invalid' }
  }
  return failure
}

function codePointCount(value: string): number {
  let count = 0
  for (const _codePoint of value) count++
  return count
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hostEventSessionId(payload: unknown): CompanionSessionId | undefined {
  if (!isRecord(payload) || typeof payload.type !== 'string' || typeof payload.sessionId !== 'string') return undefined
  if (payload.type !== 'session/event' && payload.type !== 'session/subscribed'
    && payload.type !== 'approval/requested' && payload.type !== 'approval/resolved'
    && payload.type !== 'question/requested' && payload.type !== 'question/resolved'
    && payload.type !== 'session/queue' && payload.type !== 'session/jobs'
    && payload.type !== 'session/projection' && payload.type !== 'host/session-added'
    && payload.type !== 'host/session-removed' && payload.type !== 'host/session-status'
    && payload.type !== 'host/agent-error') return undefined
  return parseCompanionSessionId(payload.sessionId)
}

function isHostSurfaceAuthorityEvent(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  return payload.type === 'host/workspace-changed' || payload.type === 'host/workspace-removed'
    || payload.type === 'host/workspace-order-changed' || payload.type === 'host/archived-sessions-changed'
}
