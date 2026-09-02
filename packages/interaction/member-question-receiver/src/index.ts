import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { ProjectId } from '@deepseek-ai/dsh-project-membership'
import type {
  CompanionMemberQuestionSettledResult,
  MemberQuestionId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  EMPTY_PERSISTED_RECEIVER_STATE,
  humanTurnDigest,
  parseReceiverState,
  serializeReceiverState,
  type PersistedReceiverState,
  type PersistedHumanTurnAdmission,
  type PersistedReceivingQuestion,
  type PersistedReceivingSession,
} from './persisted-state.ts'
import type {
  AdmitMemberQuestionHumanTurnInput,
  AdmitMemberQuestionHumanTurnResult,
  AuthenticatedMemberQuestionIngress,
  AuthenticatedMemberQuestionEnvelope,
  MemberQuestionHumanTurnAdmitter,
  MemberQuestionHumanTurnAdmissionContext,
  MemberQuestionSessionMaterializer,
  MemberQuestionIngestResult,
  MemberQuestionWorkspaceBinding,
  MemberQuestionReceiverListener,
  MemberQuestionReceiverSnapshot,
  MemberQuestionReceiverSettlement,
  MemberQuestionTerminalAuthority,
  MemberQuestionReceiverStateWriter,
  MemberQuestionReceiverTimer,
  PendingMemberQuestionView,
  ReceivingSessionId,
  TerminalMemberQuestionView,
} from './types.ts'

export type {
  AdmitMemberQuestionHumanTurnInput,
  AdmitMemberQuestionHumanTurnResult,
  AuthenticatedMemberQuestionEnvelope,
  AuthenticatedMemberQuestionIngress,
  MemberQuestionHumanTurnAdmitter,
  MemberQuestionHumanTurnAdmissionContext,
  MemberQuestionSessionMaterializer,
  MaterializeMemberQuestionSessionInput,
  MemberQuestionWorkspaceBinding,
  MemberQuestionHumanTurnContent,
  MemberQuestionIngestResult,
  MemberQuestionReceiverChange,
  MemberQuestionReceiverListener,
  MemberQuestionReceiverAuthority,
  MemberQuestionReceiverSnapshot,
  MemberQuestionReceiverSettlement,
  MemberQuestionReceiverRpcId,
  MemberQuestionTerminalAuthority,
  MemberQuestionTerminalClaim,
  MemberQuestionReceiverStateWriter,
  MemberQuestionReceiverTimer,
  PendingMemberQuestionView,
  ReceivingSessionId,
  TerminalMemberQuestionView,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memberQuestionReceiver: MemberQuestionReceiverService
  }
}

/** File Provider configuration and injected Host authority adapters. */
export interface MemberQuestionReceiverConfig {
  /** Root directory whose environment child contains the receiver ledger. */
  readonly storagePath: string
  /** Deployment namespace isolating development from production state. */
  readonly environment: 'development' | 'production'
  /** Maximum durable question records retained before arrival fails loud. */
  readonly maxRecords: number
  /** Retry delay after authoritative expiry publication fails. */
  readonly terminalRetryMs: number
  /** First-claim authority shared by every receiving Installation. */
  readonly terminalAuthority?: MemberQuestionTerminalAuthority
  /** Explicit terminal provider selection; development-local is forbidden in production. */
  readonly terminalAuthorityMode?: 'deferred' | 'development-local'
  /** Authoritative wall clock; production uses Date.now. */
  readonly clock?: () => number
  /** High-level arrival adapter; absent keeps Host Session creation fail-closed. */
  readonly materializer?: MemberQuestionSessionMaterializer
  /** High-level human-turn adapter; absent keeps human turns fail-closed. */
  readonly admitter?: MemberQuestionHumanTurnAdmitter
  /** Injectable expiry scheduler; production uses platform timers. */
  readonly timer?: MemberQuestionReceiverTimer
  /** Atomic state writer override for storage-boundary verification. */
  readonly stateWriter?: MemberQuestionReceiverStateWriter
}

/** Loader-facing receiver Provider configuration. */
export type Config = MemberQuestionReceiverConfig

export const Config: z<Config> = z.object({
  storagePath: z.string(),
  environment: z.union(['development', 'production'] as const),
  maxRecords: z.natural().min(1),
  terminalRetryMs: z.natural().min(1),
  terminalAuthority: z.any(),
  terminalAuthorityMode: z.union(['deferred', 'development-local'] as const).default('deferred'),
  clock: z.any(),
  materializer: z.any(),
  admitter: z.any(),
  timer: z.any(),
  stateWriter: z.any(),
})

/**
 * Host authority for member-question arrival, Host Session materialization,
 * projection, settlement, expiry, and one-step explicit human admission.
 */
export abstract class MemberQuestionReceiverService extends Service implements MemberQuestionWorkspaceBinding {
  constructor(ctx: Context) {
    super(ctx, 'memberQuestionReceiver')
  }

  /**
   * Persist or replay one authenticated arrival.
   * @param envelope - endpoint authority beside the decoded operation.
   * @returns Host receiving identity and committed revision.
   */
  abstract ingest(envelope: AuthenticatedMemberQuestionEnvelope): Promise<MemberQuestionIngestResult>

  /**
   * Read one complete committed projection.
   * @returns the complete authoritative pending and terminal projection.
   */
  abstract snapshot(): Promise<MemberQuestionReceiverSnapshot>

  /**
   * Subscribe to complete projections published after durable commits.
   * @param listener - projection observer; its exceptions are contained.
   * @returns disposer that removes this exact observer.
   */
  abstract changes(listener: MemberQuestionReceiverListener): () => void

  /**
   * Apply an explicit decline or authoritative first terminal.
   * @param questionId - routed question identity.
   * @param settlement - local decline metadata or retained global claim.
   * @returns the canonical persisted terminal.
   */
  abstract settle(
    questionId: MemberQuestionId,
    settlement: MemberQuestionReceiverSettlement,
  ): Promise<CompanionMemberQuestionSettledResult>

  /**
   * Reserve and admit one explicit human turn under one rpc id.
   * @param input - Host receiving identity, observed revision, rpc id, content, and mode.
   * @returns the durable idempotent admission result.
   */
  abstract admitHumanTurn(
    input: AdmitMemberQuestionHumanTurnInput,
  ): Promise<AdmitMemberQuestionHumanTurnResult>

  /** Resume every durable human action left reserved by an interrupted Host. */
  abstract resumeReservedHumanTurns(): Promise<void>

  /** Resume every durable Host Session materialization left reserved by an interrupted Host. */
  abstract resumeReservedSessionMaterializations(): Promise<void>

  /**
   * Install the single Host arrival materializer.
   * @param materializer - high-level Host Session creation adapter.
   * @returns disposer for this exact registration.
   */
  abstract registerSessionMaterializer(materializer: MemberQuestionSessionMaterializer): () => void

  /**
   * Install the single Host human-turn adapter.
   * @param admitter - high-level Host transaction adapter.
   * @returns disposer for this exact registration.
   */
  abstract registerHumanTurnAdmitter(admitter: MemberQuestionHumanTurnAdmitter): () => void

  /**
   * Persist or replace one exact Account/Project to local Workspace association.
   * @param accountId - authenticated receiving Account.
   * @param projectId - Cloud Project being joined.
   * @param workspaceId - exact local Workspace selected or cloned.
   */
  abstract bind(
    accountId: PlatformAccountId,
    projectId: ProjectId,
    workspaceId: Branded<'WorkspaceId'>,
  ): Promise<void>

  /**
   * Read one exact association without requiring it to exist.
   * @param accountId - authenticated receiving Account.
   * @param projectId - Cloud Project whose local association is being inspected.
   * @returns persisted local Workspace identity, or undefined before binding.
   */
  abstract lookup(
    accountId: PlatformAccountId,
    projectId: ProjectId,
  ): Promise<Branded<'WorkspaceId'> | undefined>

  /**
   * Replace one association only if its current value matches an observation.
   * @param accountId - authenticated receiving Account.
   * @param projectId - Cloud Project whose association is being repaired.
   * @param expectedWorkspaceId - observed current Workspace id, including undefined.
   * @param workspaceId - exact live replacement Workspace id.
   * @returns whether the replacement committed.
   */
  abstract bindIfCurrent(
    accountId: PlatformAccountId,
    projectId: ProjectId,
    expectedWorkspaceId: Branded<'WorkspaceId'> | undefined,
    workspaceId: Branded<'WorkspaceId'>,
  ): Promise<boolean>

  /**
   * Resolve one exact Account/Project association.
   * @param accountId - authenticated receiving Account.
   * @param projectId - Cloud Project carried by the received question.
   * @returns persisted local Workspace identity.
   */
  abstract resolve(
    accountId: PlatformAccountId,
    projectId: ProjectId,
  ): Promise<Branded<'WorkspaceId'>>
}

/**
 * Bind the package's authenticated-endpoint Consumer to the receiver service.
 * The endpoint supplies receiver Account authority outside the encrypted
 * operation; this adapter never derives the addressee from payload fields.
 * @param receiver - Host receiver service that owns validation and durability.
 * @returns one endpoint callback forwarding only authenticated envelopes.
 */
export function createAuthenticatedMemberQuestionIngress(
  receiver: MemberQuestionReceiverService,
): AuthenticatedMemberQuestionIngress {
  return envelope => receiver.ingest(envelope)
}

/** File-backed Provider for the Host member-question receiver authority. */
export default class FileMemberQuestionReceiver extends MemberQuestionReceiverService {
  static Config = Config

  /** Absolute environment-namespaced ledger document path. */
  readonly storageFile: string
  private readonly maxRecords: number
  private readonly terminalAuthority: MemberQuestionTerminalAuthority | undefined
  private readonly clock: () => number
  private readonly materializer: MemberQuestionSessionMaterializer | undefined
  private runtimeMaterializer: MemberQuestionSessionMaterializer | undefined
  private runtimeMaterializerRevision = 0
  private readonly admitter: MemberQuestionHumanTurnAdmitter | undefined
  private runtimeAdmitter: MemberQuestionHumanTurnAdmitter | undefined
  private runtimeAdmitterRevision = 0
  private readonly timer: MemberQuestionReceiverTimer
  private readonly terminalRetryMs: number
  private readonly stateWriter: MemberQuestionReceiverStateWriter
  private readonly listeners = new Set<MemberQuestionReceiverListener>()
  private state: PersistedReceiverState = EMPTY_PERSISTED_RECEIVER_STATE
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false
  private loadFailure: Error | undefined
  private timerHandle: unknown
  private timerScheduled = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    ctx.provide('memberQuestionWorkspaceBinding', this)
    const resolved = resolveConfig(config)
    this.storageFile = join(resolve(resolved.storagePath), resolved.environment, 'member-question-receiver.json')
    this.maxRecords = resolved.maxRecords
    this.terminalAuthority = resolved.terminalAuthority
      ?? (resolved.terminalAuthorityMode === 'development-local' ? DEVELOPMENT_LOCAL_TERMINAL_AUTHORITY : undefined)
    this.clock = resolved.clock ?? Date.now
    this.materializer = resolved.materializer
    this.admitter = resolved.admitter
    this.timer = resolved.timer ?? SYSTEM_TIMER
    this.terminalRetryMs = resolved.terminalRetryMs
    this.stateWriter = resolved.stateWriter ?? ((path, content) =>
      writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 }))
    ctx.effect(async () => {
      await this.enqueue(() => this.load())
      this.scheduleExpiry()
      return async () => {
        this.disposed = true
        this.clearTimer()
        this.listeners.clear()
        await this.chain
      }
    }, 'member-question-receiver: durable ledger lifecycle')
  }

  override ingest(envelope: AuthenticatedMemberQuestionEnvelope): Promise<MemberQuestionIngestResult> {
    return this.enqueue(async () => {
      const existing = this.state.questions.find(question => question.questionId === envelope.operation.questionId)
      if (existing !== undefined) {
        if (existing.receivingAccountId !== envelope.authority.accountId
          || JSON.stringify(existing.operation) !== JSON.stringify(envelope.operation)) {
          throw new Error(`member-question-receiver: question ${envelope.operation.questionId} was replayed with different authority or content`)
        }
        await this.ensureSessionMaterialized(existing, 'replay')
        const current = this.state.questions.find(question => question.questionId === existing.questionId)
        /* v8 ignore next -- ingest already proved this question id exists. */
        if (current === undefined) throw new Error(`member-question-receiver: question ${existing.questionId} vanished during materialization`)
        return ingestResult(current)
      }
      if (this.state.questions.length >= this.maxRecords) {
        throw new Error(`member-question-receiver: maxRecords ${this.maxRecords} is exhausted`)
      }
      const routeSession = this.state.sessions.find(session =>
        session.receivingAccountId === envelope.authority.accountId
        && session.originSessionId === envelope.operation.originSessionId)
      const now = this.clock()
      const predecessor = this.state.questions.find(question =>
        question.receivingAccountId === envelope.authority.accountId
        && question.operation.originSessionId === envelope.operation.originSessionId
        && question.terminal === undefined)
      if (predecessor !== undefined) {
        await this.claimAndPersist(predecessor, now >= predecessor.operation.expiresAt ? 'expired' : 'superseded', now)
      }
      const revision = this.state.revision + 1
      const session: PersistedReceivingSession = routeSession ?? {
        id: `receiving-${randomUUID()}`,
        receivingAccountId: envelope.authority.accountId,
        originSessionId: envelope.operation.originSessionId,
        revision,
        createdAt: now,
        materialized: false,
      }
      const currentSession = routeSession === undefined ? session : { ...routeSession, revision }
      let terminal: CompanionMemberQuestionSettledResult | undefined
      if (now >= envelope.operation.expiresAt) {
        if (this.terminalAuthority === undefined) {
          throw new Error('member-question-receiver: terminalAuthority is required to persist an expired arrival')
        }
        terminal = (await this.terminalAuthority.claim({
          type: 'member-question-settled',
          operationId: envelope.operation.operationId,
          questionId: envelope.operation.questionId,
          outcome: 'expired',
          settledAt: now,
        })).terminal
      }
      const question: PersistedReceivingQuestion = {
        questionId: envelope.operation.questionId,
        receivingSessionId: session.id,
        receivingAccountId: envelope.authority.accountId,
        revision,
        arrivedAt: now,
        operation: structuredClone(envelope.operation),
        ...(terminal === undefined ? {} : { terminal: structuredClone(terminal) }),
      }
      const next: PersistedReceiverState = {
        ...this.state,
        revision,
        sessions: routeSession === undefined
          ? [...this.state.sessions, currentSession]
          : this.state.sessions.map(row => row.id === currentSession.id ? currentSession : row),
        questions: [...this.state.questions, question],
      }
      await this.commit(next)
      this.ctx.emit('member-question-receiver/changed', {
        revision,
        questionId: envelope.operation.questionId,
        state: terminal?.outcome ?? 'pending',
      })
      this.scheduleExpiry()
      await this.ensureSessionMaterialized(question, 'arrival')
      const current = this.state.questions.find(row => row.questionId === question.questionId)
      /* v8 ignore next -- ingest just committed this question id. */
      if (current === undefined) throw new Error(`member-question-receiver: question ${question.questionId} vanished during materialization`)
      return ingestResult(current)
    })
  }

  override bind(
    accountId: PlatformAccountId,
    projectId: ProjectId,
    workspaceId: Branded<'WorkspaceId'>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const replacement = {
        receivingAccountId: String(accountId),
        projectId: String(projectId),
        workspaceId: String(workspaceId),
      }
      await this.commit({
        ...this.state,
        revision: this.state.revision + 1,
        workspaceBindings: [
          ...this.state.workspaceBindings.filter(binding =>
            binding.receivingAccountId !== accountId || binding.projectId !== projectId),
          replacement,
        ],
      })
    })
  }

  override resolve(
    accountId: PlatformAccountId,
    projectId: ProjectId,
  ): Promise<Branded<'WorkspaceId'>> {
    return this.enqueue(() => {
      const binding = this.state.workspaceBindings.find(row =>
        row.receivingAccountId === accountId && row.projectId === projectId)
      if (binding === undefined) {
        return Promise.reject(new Error(
          `member-question-receiver: no local Workspace binding for account ${accountId} and project ${projectId}`,
        ))
      }
      return Promise.resolve(
        binding.workspaceId as Branded<'WorkspaceId'>,
      )
    })
  }

  override lookup(
    accountId: PlatformAccountId,
    projectId: ProjectId,
  ): Promise<Branded<'WorkspaceId'> | undefined> {
    return this.enqueue(() => Promise.resolve(
      this.state.workspaceBindings.find(row =>
        row.receivingAccountId === accountId && row.projectId === projectId)?.workspaceId as
        | Branded<'WorkspaceId'>
        | undefined,
    ))
  }

  override bindIfCurrent(
    accountId: PlatformAccountId,
    projectId: ProjectId,
    expectedWorkspaceId: Branded<'WorkspaceId'> | undefined,
    workspaceId: Branded<'WorkspaceId'>,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const current = this.state.workspaceBindings.find(row =>
        row.receivingAccountId === accountId && row.projectId === projectId)?.workspaceId
      if (current !== expectedWorkspaceId) return false
      if (current === workspaceId) return true
      await this.commit({
        ...this.state,
        revision: this.state.revision + 1,
        workspaceBindings: [
          ...this.state.workspaceBindings.filter(binding =>
            binding.receivingAccountId !== accountId || binding.projectId !== projectId),
          {
            receivingAccountId: String(accountId),
            projectId: String(projectId),
            workspaceId: String(workspaceId),
          },
        ],
      })
      return true
    })
  }

  override snapshot(): Promise<MemberQuestionReceiverSnapshot> {
    return this.enqueue(() => Promise.resolve(this.currentSnapshot()))
  }

  override changes(listener: MemberQuestionReceiverListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  override settle(
    questionId: MemberQuestionId,
    settlement: MemberQuestionReceiverSettlement,
  ): Promise<CompanionMemberQuestionSettledResult> {
    return this.enqueue(async () => {
      const question = this.state.questions.find(record => record.questionId === questionId)
      if (question === undefined) throw new Error(`member-question-receiver: unknown question ${questionId}`)
      if (question.terminal !== undefined) return structuredClone(question.terminal)
      let terminal: CompanionMemberQuestionSettledResult
      if (settlement.kind === 'authoritative') {
        terminal = settlement.claim.terminal
        assertTerminalMatches(question, terminal)
      } else {
        if (this.terminalAuthority === undefined) {
          throw new Error('member-question-receiver: terminalAuthority is required to decline a pending question')
        }
        const candidate: CompanionMemberQuestionSettledResult = this.clock() >= question.operation.expiresAt
          ? {
            type: 'member-question-settled',
            operationId: question.operation.operationId,
            questionId,
            outcome: 'expired',
            settledAt: this.clock(),
          }
          : settlement.kind === 'answered' ? {
            type: 'member-question-settled',
            operationId: question.operation.operationId,
            questionId,
            outcome: 'answered',
            settledByInstallationId: settlement.settledByInstallationId,
            settledByDeviceName: settlement.settledByDeviceName,
            settledAt: settlement.settledAt,
            answers: structuredClone(settlement.answers),
          } : {
            type: 'member-question-settled',
            operationId: question.operation.operationId,
            questionId,
            outcome: 'declined',
            settledByInstallationId: settlement.settledByInstallationId,
            settledByDeviceName: settlement.settledByDeviceName,
            settledAt: settlement.settledAt,
          }
        terminal = (await this.terminalAuthority.claim(candidate)).terminal
        assertTerminalMatches(question, terminal)
      }
      await this.persistTerminal(question, terminal)
      this.scheduleExpiry()
      return structuredClone(terminal)
    })
  }

  override admitHumanTurn(
    input: AdmitMemberQuestionHumanTurnInput,
  ): Promise<AdmitMemberQuestionHumanTurnResult> {
    const request = structuredClone(input)
    return this.enqueue(async () => {
      const session = this.state.sessions.find(row => row.id === request.receivingSessionId)
      if (session === undefined) {
        throw new Error(`member-question-receiver: unknown receiving Session ${request.receivingSessionId}`)
      }
      const digest = humanTurnDigest(request.content, request.mode)
      let admission = this.state.admissions.find(row => row.rpcId === request.rpcId)
      if (admission !== undefined) {
        if (admission.receivingSessionId !== request.receivingSessionId
          || admission.expectedRevision !== request.revision
          || admission.requestDigest !== digest
          || admission.mode !== request.mode) {
          throw new Error(`member-question-receiver: rpcId ${request.rpcId} was replayed with different content, Session, revision, or mode`)
        }
        if (admission.state === 'committed') return admissionResult(admission)
      } else {
        if (session.revision !== request.revision) {
          throw new Error(`member-question-receiver: stale receiving Session revision ${request.revision}; current is ${session.revision}`)
        }
        admission = {
          receivingSessionId: request.receivingSessionId,
          rpcId: request.rpcId,
          expectedRevision: request.revision,
          requestDigest: digest,
          content: structuredClone(request.content),
          mode: request.mode,
          state: 'reserved',
          reservedAt: this.clock(),
        }
        await this.commit({
          ...this.state,
          revision: this.state.revision + 1,
          admissions: [...this.state.admissions, admission],
        })
      }
      const admitter = this.runtimeAdmitter ?? this.admitter
      if (admitter === undefined) {
        throw new Error('member-question-receiver: admitter is required to admit a human turn')
      }
      const context = this.admissionContext(session)
      await admitter({ ...request, content: structuredClone(admission.content) }, context)
      const revision = this.state.revision + 1
      const committed: PersistedHumanTurnAdmission = {
        ...admission,
        state: 'committed',
        committedAt: this.clock(),
        committedRevision: revision,
      }
      await this.commit({
        ...this.state,
        revision,
        sessions: this.state.sessions.map(row => row.id === request.receivingSessionId
          ? { ...row, revision, materialized: true }
          : row),
        questions: this.state.questions.map(row => row.receivingSessionId === request.receivingSessionId
          ? { ...row, revision }
          : row),
        admissions: this.state.admissions.map(row => row.rpcId === request.rpcId ? committed : row),
      })
      this.scheduleExpiry()
      return admissionResult(committed)
    })
  }

  override async resumeReservedHumanTurns(): Promise<void> {
    const reserved = await this.enqueue(() => Promise.resolve(structuredClone(
      this.state.admissions.filter(admission => admission.state === 'reserved'),
    )))
    for (const admission of reserved) {
      await this.admitHumanTurn({
        receivingSessionId: admission.receivingSessionId as ReceivingSessionId,
        revision: admission.expectedRevision,
        rpcId: admission.rpcId as import('./types.ts').MemberQuestionReceiverRpcId,
        content: admission.content,
        mode: admission.mode,
      })
    }
  }

  override async resumeReservedSessionMaterializations(): Promise<void> {
    const questions = await this.enqueue(() => Promise.resolve(
      this.state.sessions.flatMap((session) => {
        if (session.materialized) return []
        const question = this.state.questions.findLast(row => row.receivingSessionId === session.id)
        /* v8 ignore next -- every unmaterialized receiving Session is created with its first question in one commit. */
        return question === undefined ? [] : [structuredClone(question)]
      }),
    ))
    for (const question of questions) {
      await this.enqueue(() => this.ensureSessionMaterialized(question, 'replay'))
    }
  }

  override registerSessionMaterializer(materializer: MemberQuestionSessionMaterializer): () => void {
    if (this.runtimeMaterializer !== undefined) {
      throw new Error('member-question-receiver: a Host Session materializer is already registered')
    }
    this.runtimeMaterializer = materializer
    const revision = ++this.runtimeMaterializerRevision
    return () => {
      if (this.runtimeMaterializerRevision !== revision) return
      this.runtimeMaterializer = undefined
      this.runtimeMaterializerRevision += 1
    }
  }

  override registerHumanTurnAdmitter(admitter: MemberQuestionHumanTurnAdmitter): () => void {
    if (this.runtimeAdmitter !== undefined) {
      throw new Error('member-question-receiver: a Host human-turn admitter is already registered')
    }
    this.runtimeAdmitter = admitter
    const revision = ++this.runtimeAdmitterRevision
    return () => {
      if (this.runtimeAdmitterRevision !== revision) return
      this.runtimeAdmitter = undefined
      this.runtimeAdmitterRevision += 1
    }
  }

  private async claimAndPersist(
    question: PersistedReceivingQuestion,
    outcome: 'expired' | 'superseded',
    settledAt: number,
  ): Promise<void> {
    if (this.terminalAuthority === undefined) {
      throw new Error('member-question-receiver: terminalAuthority is required to settle a pending question')
    }
    const claim = await this.terminalAuthority.claim({
      type: 'member-question-settled',
      operationId: question.operation.operationId,
      questionId: question.operation.questionId,
      outcome,
      settledAt,
    })
    assertTerminalMatches(question, claim.terminal)
    await this.persistTerminal(question, claim.terminal)
  }

  private async persistTerminal(
    question: PersistedReceivingQuestion,
    terminal: CompanionMemberQuestionSettledResult,
  ): Promise<void> {
    const revision = this.state.revision + 1
    const nextQuestion: PersistedReceivingQuestion = { ...question, revision, terminal: structuredClone(terminal) }
    await this.commit({
      ...this.state,
      revision,
      sessions: this.state.sessions.map(session => session.id === question.receivingSessionId
        ? { ...session, revision }
        : session),
      questions: this.state.questions.map(current => current.questionId === question.questionId ? nextQuestion : current),
    })
    this.ctx.emit('member-question-receiver/changed', {
      revision,
      questionId: question.operation.questionId,
      state: terminal.outcome,
    })
    this.scheduleExpiry()
  }

  private async load(): Promise<void> {
    try {
      this.state = parseReceiverState(await readFile(this.storageFile, 'utf8'))
      await this.expireDue()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      /* v8 ignore next -- readFile and this module's parser reject only Error instances. */
      this.loadFailure = error instanceof Error ? error : new Error(String(error))
      throw this.loadFailure
    }
  }

  private async commit(next: PersistedReceiverState): Promise<void> {
    const content = serializeReceiverState(next)
    const validated = parseReceiverState(content)
    await this.stateWriter(this.storageFile, content)
    this.state = validated
    const snapshot = this.currentSnapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('member-question receiver subscriber failed:', error)
      }
    }
  }

  private currentSnapshot(): MemberQuestionReceiverSnapshot {
    return {
      revision: this.state.revision,
      pending: this.state.questions.flatMap(question => question.terminal === undefined
        ? [toPendingView(
          question,
          this.materialized(question),
          this.state.admissions.find(admission => admission.receivingSessionId === question.receivingSessionId
            && admission.state === 'reserved'),
        )]
        : []),
      terminal: this.state.questions.flatMap(question =>
        question.terminal === undefined ? [] : [toTerminalView(question, this.materialized(question))]),
    }
  }

  private materialized(question: PersistedReceivingQuestion): boolean {
    return this.state.sessions.find(session => session.id === question.receivingSessionId)?.materialized === true
  }

  private admissionContext(session: PersistedReceivingSession): MemberQuestionHumanTurnAdmissionContext {
    const questions = this.state.questions.filter(row => row.receivingSessionId === session.id)
    /* v8 ignore next -- every persisted receiving Session is created with its first question in one commit. */
    if (questions[0] === undefined) throw new Error('member-question-receiver: receiving Session has no questions')
    const projectId = questions[0].operation.projectId
    const workspaceId = this.state.workspaceBindings.find(binding =>
      binding.receivingAccountId === session.receivingAccountId
      && binding.projectId === projectId)?.workspaceId
    if (workspaceId === undefined) {
      throw new Error(
        `member-question-receiver: no local Workspace binding for account ${session.receivingAccountId} and project ${projectId}`,
      )
    }
    return {
      receivingAccountId: session.receivingAccountId as PlatformAccountId,
      projectId,
      workspaceId: workspaceId as Branded<'WorkspaceId'>,
      questions: questions.map(row => row.terminal === undefined
        ? toPendingView(row, this.materialized(row))
        : toTerminalView(row, this.materialized(row))),
    }
  }

  private async ensureSessionMaterialized(
    question: PersistedReceivingQuestion,
    mode: 'arrival' | 'replay',
  ): Promise<void> {
    const session = this.state.sessions.find(row => row.id === question.receivingSessionId)
    /* v8 ignore next -- ingest and resume only pass questions that already name a persisted Session. */
    if (session === undefined) {
      throw new Error(`member-question-receiver: unknown receiving Session ${question.receivingSessionId}`)
    }
    if (mode === 'replay' && session.materialized) return
    const materializer = this.runtimeMaterializer ?? this.materializer
    if (materializer === undefined) return
    await materializer({
      receivingSessionId: session.id as ReceivingSessionId,
      revision: question.revision,
      questionId: question.questionId as MemberQuestionId,
    }, this.admissionContext(session))
    if (session.materialized) return
    const revision = this.state.revision + 1
    await this.commit({
      ...this.state,
      revision,
      sessions: this.state.sessions.map(row => row.id === session.id
        ? { ...row, revision, materialized: true }
        : row),
      questions: this.state.questions.map(row => row.receivingSessionId === session.id
        ? { ...row, revision }
        : row),
    })
    this.ctx.emit('member-question-receiver/changed', {
      revision,
      questionId: question.questionId as MemberQuestionId,
      state: question.terminal?.outcome ?? 'pending',
    })
    this.scheduleExpiry()
  }

  private async expireDue(): Promise<void> {
    const now = this.clock()
    for (const question of this.state.questions) {
      if (question.terminal !== undefined || now < question.operation.expiresAt) continue
      await this.claimAndPersist(question, 'expired', now)
    }
  }

  private scheduleExpiry(delayOverride?: number): void {
    if (this.disposed) return
    this.clearTimer()
    let earliest: number | undefined
    for (const question of this.state.questions) {
      if (question.terminal !== undefined) continue
      if (earliest === undefined || question.operation.expiresAt < earliest) earliest = question.operation.expiresAt
    }
    if (earliest === undefined) return
    const delay = delayOverride ?? Math.max(0, earliest - this.clock())
    this.timerHandle = this.timer.set(() => {
      this.timerScheduled = false
      void this.enqueue(() => this.expireDue()).then(
        () => { this.scheduleExpiry() },
        () => { this.scheduleExpiry(this.terminalRetryMs) },
      )
    }, Math.min(delay, 2_147_483_647))
    this.timerScheduled = true
  }

  private clearTimer(): void {
    if (this.timerScheduled) this.timer.clear(this.timerHandle)
    this.timerScheduled = false
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.chain.then(async () => {
      if (this.loadFailure !== undefined) throw this.loadFailure
      if (this.disposed) throw new Error('member-question-receiver: service is disposed')
      return operation()
    })
    this.chain = queued.catch(() => undefined)
    return queued
  }
}

function assertTerminalMatches(
  question: PersistedReceivingQuestion,
  terminal: CompanionMemberQuestionSettledResult,
): void {
  if (terminal.questionId !== question.questionId || terminal.operationId !== question.operation.operationId) {
    throw new Error('member-question-receiver: authoritative terminal names a different question or operation')
  }
}

function resolveConfig(config: Config): Config {
  if (typeof config.storagePath !== 'string' || config.storagePath.trim() === '') {
    throw new TypeError('member-question-receiver: config.storagePath must be a non-empty directory path')
  }
  const environment: string = config.environment
  if (environment !== 'development' && environment !== 'production') {
    throw new TypeError("member-question-receiver: config.environment must be 'development' or 'production'")
  }
  if (!Number.isSafeInteger(config.maxRecords) || config.maxRecords < 1) {
    throw new TypeError('member-question-receiver: config.maxRecords must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.terminalRetryMs) || config.terminalRetryMs < 1) {
    throw new TypeError('member-question-receiver: config.terminalRetryMs must be a positive safe integer')
  }
  if (config.terminalAuthority !== undefined && typeof config.terminalAuthority.claim !== 'function') {
    throw new TypeError('member-question-receiver: config.terminalAuthority must implement claim()')
  }
  const terminalAuthorityMode: unknown = config.terminalAuthorityMode
  if (terminalAuthorityMode !== undefined
    && terminalAuthorityMode !== 'deferred'
    && terminalAuthorityMode !== 'development-local') {
    throw new TypeError("member-question-receiver: config.terminalAuthorityMode must be 'deferred' or 'development-local'")
  }
  if (config.environment === 'production' && config.terminalAuthorityMode === 'development-local') {
    throw new TypeError('member-question-receiver: config.terminalAuthorityMode development-local is forbidden in production')
  }
  if (config.clock !== undefined && typeof config.clock !== 'function') {
    throw new TypeError('member-question-receiver: config.clock must be a function')
  }
  if (config.materializer !== undefined && typeof config.materializer !== 'function') {
    throw new TypeError('member-question-receiver: config.materializer must be a function')
  }
  if (config.admitter !== undefined && typeof config.admitter !== 'function') {
    throw new TypeError('member-question-receiver: config.admitter must be a function')
  }
  if (config.timer !== undefined && (typeof config.timer.set !== 'function' || typeof config.timer.clear !== 'function')) {
    throw new TypeError('member-question-receiver: config.timer must implement set() and clear()')
  }
  if (config.stateWriter !== undefined && typeof config.stateWriter !== 'function') {
    throw new TypeError('member-question-receiver: config.stateWriter must be a function')
  }
  return config
}

const SYSTEM_TIMER: MemberQuestionReceiverTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

const DEVELOPMENT_LOCAL_TERMINAL_AUTHORITY: MemberQuestionTerminalAuthority = {
  claim: terminal => Promise.resolve({ claimed: true, terminal: structuredClone(terminal) }),
}

function admissionResult(admission: PersistedHumanTurnAdmission): AdmitMemberQuestionHumanTurnResult {
  const revision = admission.committedRevision
  /* v8 ignore next -- persisted parsing and the sole caller require committedRevision before this helper. */
  if (revision === undefined) throw new Error('member-question-receiver: committed admission has no revision')
  return {
    accepted: true,
    receivingSessionId: admission.receivingSessionId as ReceivingSessionId,
    revision,
    rpcId: admission.rpcId as import('./types.ts').MemberQuestionReceiverRpcId,
  }
}

function ingestResult(question: PersistedReceivingQuestion): MemberQuestionIngestResult {
  return {
    questionId: question.questionId as MemberQuestionId,
    receivingSessionId: question.receivingSessionId as ReceivingSessionId,
    revision: question.revision,
  }
}

function toPendingView(
  question: PersistedReceivingQuestion,
  materialized = false,
  admission?: PersistedHumanTurnAdmission,
): PendingMemberQuestionView {
  return {
    questionId: question.questionId as MemberQuestionId,
    receivingSessionId: question.receivingSessionId as ReceivingSessionId,
    receivingAccountId: question.receivingAccountId as PlatformAccountId,
    revision: question.revision,
    arrivedAt: question.arrivedAt,
    operation: structuredClone(question.operation),
    ...(materialized ? { hostSessionId: question.receivingSessionId as unknown as import('@deepseek-ai/dsh-session/types').SessionId } : {}),
    ...(admission === undefined ? {} : {
      reservedAdmission: {
        rpcId: admission.rpcId as import('./types.ts').MemberQuestionReceiverRpcId,
        mode: admission.mode,
      },
    }),
  }
}

function toTerminalView(question: PersistedReceivingQuestion, materialized = false): TerminalMemberQuestionView {
  const terminal = question.terminal
  /* v8 ignore next -- currentSnapshot calls this helper only from the terminal-defined branch. */
  if (terminal === undefined) throw new Error('member-question-receiver: terminal projection requires a terminal record')
  return {
    questionId: question.questionId as MemberQuestionId,
    receivingSessionId: question.receivingSessionId as ReceivingSessionId,
    receivingAccountId: question.receivingAccountId as PlatformAccountId,
    revision: question.revision,
    arrivedAt: question.arrivedAt,
    terminal: structuredClone(terminal),
    brief: structuredClone(question.operation),
    ...(materialized ? { hostSessionId: question.receivingSessionId as unknown as import('@deepseek-ai/dsh-session/types').SessionId } : {}),
  }
}
