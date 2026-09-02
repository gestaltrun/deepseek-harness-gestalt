/**
 * Service Definition and codec-backed Provider for member-directed questions
 * (`ctx.memberQuestionSender`). The Provider encodes a Companion
 * `member-question` operation and aligned `document-chunk` frames through the
 * T4 remote-protocol codec and delivers the bytes through an injected port.
 * Peer credentials are retrieved through an injected B-side lookup over
 * Remote Access `getProjectPeerGrant`. Cross-machine registry transport
 * remains the T4 Known Limitation, so delivery is injectable and tests use
 * an in-memory stub.
 * @module @deepseek-ai/dsh-member-question-sender
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SealedProjectPeerGrant } from '@deepseek-ai/dsh-remote-access'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  deriveMemberQuestionDocumentTransferId,
  encodeCompanionMessage,
  encodeProtocolBase64Url,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseMemberQuestionId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionDocumentChunkOperation,
  type CompanionMemberQuestionSettledResult,
  type CompanionMemberQuestionOperation,
  type CompanionMessage,
  type CompanionOperationId,
  type InstallationId,
  type MemberQuestionId,
  type NegotiatedCompanionProtocol,
  type ProjectId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemberQuestionSenderError } from './errors.ts'
import type { MemberQuestionSenderErrorCode } from './errors.ts'
import type {
  EncodedMemberQuestion,
  EncodedMemberQuestionDocument,
  MemberQuestionDocument,
  MemberQuestionAnswer,
  MemberQuestionAskedRecord,
  MemberQuestionDeliveryPort,
  MemberQuestionLifetimeOutcome,
  MemberQuestionOutcomeRecord,
  MemberQuestionSendPayload,
  MemberQuestionSendResult,
  MemberQuestionTerminalClaim,
} from './types.ts'

export { MemberQuestionSenderError } from './errors.ts'
export type { MemberQuestionSenderErrorCode } from './errors.ts'
export type {
  EncodedMemberQuestion,
  EncodedMemberQuestionDocument,
  MemberQuestionAnswer,
  MemberQuestionAskedRecord,
  MemberQuestionDeliveryPort,
  MemberQuestionDocument,
  MemberQuestionTerminalClaim,
  MemberQuestionItem,
  MemberQuestionLifetimeOutcome,
  MemberQuestionOrigin,
  MemberQuestionOutcomeRecord,
  MemberQuestionReference,
  MemberQuestionSendPayload,
  MemberQuestionSendResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memberQuestionSender: MemberQuestionSenderService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A routed member-question ask was delivered — log-only record of the
     * already model-visible tool-call summary (not a surface event).
     * `questionId` pairs it with the `member-question/outcome` that always
     * follows.
     */
    'member-question/asked': MemberQuestionAskedRecord
    /**
     * The terminal outcome of a prior `member-question/asked` (same
     * `questionId`) — log-only record of the already model-visible tool
     * result. Exactly one per ask.
     */
    'member-question/outcome': MemberQuestionOutcomeRecord
  }
}

/** Default routed-question lifetime: thirty minutes. */
export const DEFAULT_QUESTION_TTL_MS = 30 * 60 * 1000

/** Inputs for retrieving one sealed project-peer grant on the B side. */
export interface ProjectPeerGrantLookupInput {
  /** Cloud project whose grant records are searched. */
  projectId: ProjectId
  /** Account the sealed grant must address. */
  peerAccountId: string
}

/**
 * B-side retrieval of one sealed project-peer grant. Compositions wire this
 * to `ctx.remoteAccess.getProjectPeerGrant`; tests inject a stub.
 * @param input - project and peer account identity.
 * @returns the sealed grant addressed to that peer.
 */
export type ProjectPeerGrantLookup = (input: ProjectPeerGrantLookupInput) => Promise<SealedProjectPeerGrant>

/** Inputs for a live presence verdict of one project member. */
export interface MemberPresenceLookupInput {
  /** Cloud project whose roster presence is queried. */
  projectId: ProjectId
  /** Account whose installations are aggregated. */
  peerAccountId: string
}

/**
 * Live presence of one project member. Compositions wire this to the
 * membership HTTP presence registry; tests inject a stub.
 * @param input - project and peer account identity.
 * @returns `online` when any installation holds a live heartbeat, else `offline`.
 */
export type MemberPresenceLookup = (input: MemberPresenceLookupInput) => Promise<'online' | 'offline'>

/** Inputs for watching one membership row until it is revoked or the ask settles. */
export interface MemberMembershipWatchInput {
  /** Cloud project whose roster is watched. */
  projectId: ProjectId
  /** Account whose membership is watched. */
  peerAccountId: string
  /** Aborts the watch when the ask settles for any other reason. */
  signal: AbortSignal
}

/**
 * Resolves when the addressed member's membership is revoked during flight.
 * Aborting `signal` cancels the watch without treating that as a revocation.
 * @param input - project, peer account, and settlement cancellation.
 * @returns fulfillment when membership is revoked while the ask is pending.
 */
export type MemberMembershipWatch = (input: MemberMembershipWatchInput) => Promise<void>

/** Optional session and cancellation attached to one `send()` call. */
export interface MemberQuestionSendOptions {
  /** Asking session that records the durable ask/outcome pair. */
  session?: Session
  /** Aborting this signal withdraws the in-flight question. */
  signal?: AbortSignal
}

/** Successful or declined settlement applied to one in-flight question. */
export type MemberQuestionSettlement =
  | {
    outcome: 'answered'
    answers: readonly MemberQuestionAnswer[]
    settledByInstallationId: InstallationId
    settledByDeviceName: string
    settledAt: number
  }
  | {
    outcome: 'declined'
    settledByInstallationId: InstallationId
    settledByDeviceName: string
    settledAt: number
  }

/** Construction-owned faces injected into the sender Provider. */
export interface Config {
  /**
   * Delivers encoded Companion bytes to the addressed member's route. Absent,
   * `send()` answers the stable `DELIVERY_UNAVAILABLE` error — the same
   * fail-closed stance as the deferred registry transport.
   */
  delivery?: MemberQuestionDeliveryPort
  /**
   * Retrieves the sealed project-peer grant addressed to the member. Absent,
   * encoding still proceeds so a keyless assembly can round-trip the codec
   * without a Platform Instance.
   */
  lookupGrant?: ProjectPeerGrantLookup
  /**
   * Reads live presence for the addressed member. Absent, send skips the
   * offline fail-fast so a keyless assembly can round-trip without a presence
   * registry. Present, an `offline` verdict answers `MEMBER_OFFLINE` before
   * encoding.
   */
  presenceLookup?: MemberPresenceLookup
  /**
   * Resolves when the addressed member's membership is revoked while an ask
   * is in flight. Absent, in-flight revocation is not observed.
   */
  watchMembership?: MemberMembershipWatch
  /**
   * Routed-question lifetime in milliseconds. Default 1_800_000 (30 minutes).
   * Expiry answers `QUESTION_EXPIRED` and records the expired outcome.
   */
  ttlMs?: number
}

/** Schemastery configuration for the sender Provider. */
export const Config: z<Config> = z.object({
  delivery: z.any(),
  lookupGrant: z.any(),
  presenceLookup: z.any(),
  watchMembership: z.any(),
  ttlMs: z.natural().min(1).default(DEFAULT_QUESTION_TTL_MS),
})

/** Config keys whose injected values must be callable. */
const LOOKUP_KEYS = ['lookupGrant', 'presenceLookup', 'watchMembership'] as const

/** Fully resolved construction-owned faces after loud validation. */
interface ResolvedConfig {
  delivery: MemberQuestionDeliveryPort | undefined
  lookupGrant: ProjectPeerGrantLookup | undefined
  presenceLookup: MemberPresenceLookup | undefined
  watchMembership: MemberMembershipWatch | undefined
  ttlMs: number
}

/**
 * Validate the injected faces loudly for both Loader-normalized and
 * programmatic construction, so misconfiguration fails at load.
 * @param config - raw plugin config.
 * @returns the same config once every present face has the expected shape.
 */
function resolveConfig(config: Config): ResolvedConfig {
  if (config.delivery !== undefined && (
    typeof config.delivery.deliver !== 'function'
    || typeof config.delivery.publishTerminal !== 'function'
    || typeof config.delivery.queryTerminal !== 'function'
  )) {
    throw new TypeError('member-question-sender: config.delivery must implement deliver(), publishTerminal(), and queryTerminal()')
  }
  for (const key of LOOKUP_KEYS) {
    const value = config[key]
    if (value !== undefined && typeof value !== 'function') {
      throw new TypeError(`member-question-sender: config.${key} must be a function`)
    }
  }
  const ttlMs = config.ttlMs === undefined ? DEFAULT_QUESTION_TTL_MS : config.ttlMs
  if (!Number.isFinite(ttlMs) || ttlMs < 1) {
    throw new TypeError('member-question-sender: config.ttlMs must be a positive finite number of milliseconds')
  }
  return {
    delivery: config.delivery,
    lookupGrant: config.lookupGrant,
    presenceLookup: config.presenceLookup,
    watchMembership: config.watchMembership,
    ttlMs,
  }
}

/**
 * Member-question sender capability. `send(payload)` encodes one Companion
 * `member-question` operation, delivers it, and waits for a terminal
 * settlement or a stable lifetime error.
 */
export abstract class MemberQuestionSenderService extends Service {
  /** @param ctx - composition context receiving this service. */
  constructor(ctx: Context) {
    super(ctx, 'memberQuestionSender')
  }

  /**
   * Encode one member-directed question, deliver it, and wait for settlement.
   * @param payload - Decision Brief origin, background, question batch, and references.
   * @param options - optional asking session and withdrawal signal.
   * @returns the answered or declined settlement plus the encoded Companion bytes.
   * @throws {MemberQuestionSenderError} `DELIVERY_UNAVAILABLE` when no delivery port is composed,
   *   `GRANT_UNAVAILABLE` when a composed grant lookup cannot retrieve the peer grant,
   *   `ENCODE_FAILED` when the T4 codec rejects the payload,
   *   `MEMBER_OFFLINE` when presence is offline at send time,
   *   `QUESTION_EXPIRED` when the configured TTL elapses unanswered,
   *   `QUESTION_WITHDRAWN` when the initiator cancels the turn,
   *   `QUESTION_SUPERSEDED` when a newer same-route ask replaces this one,
   *   or `REVOKED_DURING_FLIGHT` when membership is withdrawn while waiting.
   */
  abstract send(
    payload: MemberQuestionSendPayload,
    options?: MemberQuestionSendOptions,
  ): Promise<MemberQuestionSendResult>

  /**
   * Apply one answered or declined settlement to a pending question.
   * Unknown or already-settled question ids are ignored (idempotent).
   * @param questionId - branded question identity returned by `send()`.
   * @param settlement - answered answers or a declined verdict with the settling Installation metadata and epoch.
   * @returns fulfillment after the matching `send()` promise settles, or immediately when none is pending.
   */
  abstract settle(questionId: MemberQuestionId, settlement: MemberQuestionSettlement): Promise<void>

  /**
   * Apply one authoritative first-claim terminal published by transport.
   * Unknown or already-settled question ids are ignored.
   * @param terminal - Companion member-question settled result.
   * @returns fulfillment after the matching `send()` promise settles, or immediately when none is pending.
   */
  abstract applyTerminal(terminal: CompanionMemberQuestionSettledResult): Promise<void>

  /**
   * Withdraw one pending question as initiator cancellation.
   * Unknown or already-settled question ids are ignored.
   * @param questionId - branded question identity returned by `send()`.
   * @returns fulfillment after the matching `send()` promise rejects `QUESTION_WITHDRAWN`, or immediately when none is pending.
   */
  abstract withdraw(questionId: MemberQuestionId): Promise<void>

  /**
   * Query the authoritative first terminal retained for reconnect replay.
   * @param questionId - branded question identity returned by `send()`.
   * @returns the retained terminal, or undefined while pending or unknown.
   */
  abstract queryTerminal(questionId: MemberQuestionId): Promise<CompanionMemberQuestionSettledResult | undefined>
}

/** One in-flight routed ask waiting for a terminal settlement. */
interface PendingAsk {
  readonly questionId: MemberQuestionId
  readonly operationId: CompanionOperationId
  readonly delivery: MemberQuestionDeliveryPort
  readonly routeKey: string
  readonly session: Session | undefined
  readonly encoded: Uint8Array
  readonly promise: Promise<MemberQuestionSendResult>
  readonly resolve: (result: MemberQuestionSendResult) => void
  readonly reject: (error: MemberQuestionSenderError) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly watchAbort: AbortController
  readonly abortSignal: AbortSignal | undefined
  abortListener: (() => void) | undefined
  settled: boolean
  completion: Promise<boolean> | undefined
}

/**
 * Codec-backed sender Provider. Encoding reuses the T4 Companion codec;
 * delivery is the injected port; grant retrieval is the B-side lookup.
 */
export class CompanionMemberQuestionSender extends MemberQuestionSenderService {
  static Config = Config

  private readonly delivery: MemberQuestionDeliveryPort | undefined
  private readonly lookupGrant: ProjectPeerGrantLookup | undefined
  private readonly presenceLookup: MemberPresenceLookup | undefined
  private readonly watchMembership: MemberMembershipWatch | undefined
  private readonly ttlMs: number
  private readonly protocol: NegotiatedCompanionProtocol
  private readonly pendingByRoute = new Map<string, PendingAsk>()
  private readonly pendingById = new Map<MemberQuestionId, PendingAsk>()

  /**
   * @param ctx - composition context receiving this service.
   * @param config - injected delivery port and optional grant lookup.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const resolved = resolveConfig(config)
    this.delivery = resolved.delivery
    this.lookupGrant = resolved.lookupGrant
    this.presenceLookup = resolved.presenceLookup
    this.watchMembership = resolved.watchMembership
    this.ttlMs = resolved.ttlMs
    this.protocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    ctx.effect(() => async () => {
      await Promise.all([...this.pendingById.values()].map(pending =>
        this.complete(pending, systemCompletion(
          pending,
          'withdrawn',
          'QUESTION_WITHDRAWN',
          'QUESTION_WITHDRAWN: the member-question sender was disposed while the ask was in flight',
        )),
      ))
    }, 'member-question-sender: publish pending withdrawals')
  }

  override async send(
    payload: MemberQuestionSendPayload,
    options: MemberQuestionSendOptions = {},
  ): Promise<MemberQuestionSendResult> {
    const delivery = this.delivery
    if (delivery === undefined) {
      throw new MemberQuestionSenderError(
        'DELIVERY_UNAVAILABLE: member-question delivery is not composed; inject a delivery port',
        'DELIVERY_UNAVAILABLE',
      )
    }
    if (this.lookupGrant !== undefined) {
      try {
        await this.lookupGrant({
          projectId: payload.projectId,
          peerAccountId: payload.toProjectMember,
        })
      } catch (cause: unknown) {
        throw new MemberQuestionSenderError(
          'GRANT_UNAVAILABLE: no live project-peer grant addresses this member',
          'GRANT_UNAVAILABLE',
          { cause },
        )
      }
    }
    if (this.presenceLookup !== undefined) {
      let presence: 'online' | 'offline'
      try {
        presence = await this.presenceLookup({
          projectId: payload.projectId,
          peerAccountId: payload.toProjectMember,
        })
      } catch (cause: unknown) {
        throw new MemberQuestionSenderError(
          'MEMBER_OFFLINE: presence lookup failed; refusing to queue an offline ask',
          'MEMBER_OFFLINE',
          { cause },
        )
      }
      if (presence !== 'online') {
        throw new MemberQuestionSenderError(
          'MEMBER_OFFLINE: the addressed member has no live installation; nothing is queued',
          'MEMBER_OFFLINE',
        )
      }
    }
    if (options.signal?.aborted) {
      throw new MemberQuestionSenderError(
        'QUESTION_WITHDRAWN: the initiating turn cancelled the ask before delivery',
        'QUESTION_WITHDRAWN',
      )
    }
    const routeKey = routeKeyOf(payload.originSessionId, payload.toProjectMember)
    for (let superseded = this.pendingByRoute.get(routeKey); superseded !== undefined;
      superseded = this.pendingByRoute.get(routeKey)) {
      const published = await this.complete(superseded, systemCompletion(
        superseded,
        'superseded',
        'QUESTION_SUPERSEDED',
        'QUESTION_SUPERSEDED: a newer question on the same origin-session and member replaced this ask',
      ))
      if (!published) {
        throw new MemberQuestionSenderError(
          'DELIVERY_UNAVAILABLE: the previous same-route question could not publish its superseded terminal',
          'DELIVERY_UNAVAILABLE',
        )
      }
    }
    if (options.signal?.aborted) {
      throw new MemberQuestionSenderError(
        'QUESTION_WITHDRAWN: the initiating turn cancelled the ask before delivery',
        'QUESTION_WITHDRAWN',
      )
    }
    const encoded = encodeMemberQuestion(this.protocol, payload, Date.now() + this.ttlMs)
    const documentPayloads = payload.documents
    if (documentPayloads !== undefined
      && (documentPayloads.length !== payload.references.length
        || documentPayloads.some((document, index) => document.path !== payload.references[index]?.path))) {
      throw new MemberQuestionSenderError(
        'ENCODE_FAILED: document bytes must align with member-question references',
        'ENCODE_FAILED',
      )
    }
    const documents = encodeMemberQuestionDocuments(
      this.protocol,
      encoded.questionId,
      documentPayloads ?? [],
    )
    const pending = this.registerPending(
      encoded,
      routeKey,
      delivery,
      options,
    )
    this.recordAsked(pending, payload)
    this.armMembershipWatch(pending, payload)
    try {
      await delivery.deliver({
        ...encoded,
        toProjectMember: payload.toProjectMember,
        projectId: payload.projectId,
        documents,
      })
    } catch (cause: unknown) {
      await this.complete(pending, systemCompletion(
        pending,
        'withdrawn',
        'DELIVERY_UNAVAILABLE',
        'DELIVERY_UNAVAILABLE: the composed delivery port rejected the encoded operation',
        cause,
      ))
    }
    return pending.promise
  }

  override settle(questionId: MemberQuestionId, settlement: MemberQuestionSettlement): Promise<void> {
    const pending = this.pendingById.get(questionId)
    if (pending === undefined) return Promise.resolve()
    return this.complete(pending, {
      terminal: {
        type: 'member-question-settled',
        operationId: pending.operationId,
        questionId: pending.questionId,
        ...settlement,
      },
    }).then(() => undefined)
  }

  override applyTerminal(terminal: CompanionMemberQuestionSettledResult): Promise<void> {
    const pending = this.pendingById.get(terminal.questionId)
    if (pending === undefined) return Promise.resolve()
    if (terminal.operationId !== pending.operationId) {
      return Promise.reject(new Error('member-question sender authoritative terminal names a different operation'))
    }
    return this.complete(pending, { terminal }).then(() => undefined)
  }

  override withdraw(questionId: MemberQuestionId): Promise<void> {
    const pending = this.pendingById.get(questionId)
    if (pending === undefined) return Promise.resolve()
    return this.complete(pending, systemCompletion(
      pending,
      'withdrawn',
      'QUESTION_WITHDRAWN',
      'QUESTION_WITHDRAWN: the initiating turn cancelled the in-flight ask',
    )).then(() => undefined)
  }

  override queryTerminal(questionId: MemberQuestionId): Promise<CompanionMemberQuestionSettledResult | undefined> {
    return this.delivery?.queryTerminal(questionId) ?? Promise.resolve(undefined)
  }

  /**
   * Register one pending ask, arm TTL and abort-signal withdrawal, and index it
   * by route key and question id.
   * @param encoded - Companion operation and bounded application bytes.
   * @param routeKey - `(originSession, member)` occupancy key.
   * @param delivery - port that accepted the operation and retains its terminal.
   * @param options - asking session and withdrawal signal.
   * @returns the pending cell whose promise `send()` returns.
   */
  private registerPending(
    encoded: EncodedMemberQuestion,
    routeKey: string,
    delivery: MemberQuestionDeliveryPort,
    options: MemberQuestionSendOptions,
  ): PendingAsk {
    let resolve!: (result: MemberQuestionSendResult) => void
    let reject!: (error: MemberQuestionSenderError) => void
    const promise = new Promise<MemberQuestionSendResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    const watchAbort = new AbortController()
    const pending: PendingAsk = {
      questionId: encoded.questionId,
      operationId: encoded.operationId,
      delivery,
      routeKey,
      session: options.session,
      encoded: encoded.encoded,
      promise,
      resolve,
      reject,
      timer: setTimeout(() => {
        void this.complete(pending, systemCompletion(
          pending,
          'expired',
          'QUESTION_EXPIRED',
          'QUESTION_EXPIRED: the member-question lifetime elapsed unanswered',
        ))
      }, this.ttlMs),
      watchAbort,
      abortSignal: options.signal,
      abortListener: undefined,
      settled: false,
      completion: undefined,
    }
    this.pendingByRoute.set(routeKey, pending)
    this.pendingById.set(encoded.questionId, pending)
    if (options.signal !== undefined) {
      const listener = (): void => {
        void this.complete(pending, systemCompletion(
          pending,
          'withdrawn',
          'QUESTION_WITHDRAWN',
          'QUESTION_WITHDRAWN: the initiating turn cancelled the in-flight ask',
        ))
      }
      pending.abortListener = listener
      options.signal.addEventListener('abort', listener, { once: true })
    }
    return pending
  }

  /**
   * Start the optional membership watch; a resolution answers
   * `REVOKED_DURING_FLIGHT`. Abort and unexpected rejection after abort are ignored.
   * @param pending - in-flight ask whose membership is watched.
   * @param payload - project and addressee identity.
   */
  private armMembershipWatch(pending: PendingAsk, payload: MemberQuestionSendPayload): void {
    if (this.watchMembership === undefined) return
    void this.watchMembership({
      projectId: payload.projectId,
      peerAccountId: payload.toProjectMember,
      signal: pending.watchAbort.signal,
    }).then(
      () => {
        void this.complete(pending, systemCompletion(
          pending,
          'withdrawn',
          'REVOKED_DURING_FLIGHT',
          'REVOKED_DURING_FLIGHT: the addressed member lost project membership while the ask was in flight',
          undefined,
          'revoked',
        ))
      },
      (cause: unknown) => {
        if (pending.watchAbort.signal.aborted || pending.settled) return
        void this.complete(pending, systemCompletion(
          pending,
          'withdrawn',
          'REVOKED_DURING_FLIGHT',
          'REVOKED_DURING_FLIGHT: membership watch failed while the ask was in flight',
          cause,
          'revoked',
        ))
      },
    )
  }

  /**
   * Append the durable ask summary on the asking session when one was supplied.
   * @param pending - in-flight ask whose question id is recorded.
   * @param payload - Decision Brief fields retained as the ask summary.
   */
  private recordAsked(pending: PendingAsk, payload: MemberQuestionSendPayload): void {
    pending.session?.append('member-question/asked', {
      questionId: pending.questionId,
      toProjectMember: payload.toProjectMember,
      projectId: payload.projectId,
      background: payload.background,
      questions: payload.questions.map(question => ({
        id: question.id,
        question: question.question,
      })),
      originSessionId: payload.originSessionId,
    })
  }

  /**
   * Publish one terminal candidate through the delivery port, then settle the
   * local ask from the authoritative first claim.
   * @param pending - in-flight ask to complete.
   * @param completion - terminal candidate and optional local failure meaning.
   * @returns `true` when a terminal committed, or `false` when publication failed.
   */
  private complete(pending: PendingAsk, completion: PendingCompletion): Promise<boolean> {
    if (pending.completion !== undefined) return pending.completion
    const publishing = this.publishAndFinish(pending, completion)
    pending.completion = publishing
    return publishing
  }

  /** Publish and apply the first terminal claim for one pending ask. */
  private async publishAndFinish(pending: PendingAsk, completion: PendingCompletion): Promise<boolean> {
    let claim: MemberQuestionTerminalClaim
    try {
      claim = await pending.delivery.publishTerminal(completion.terminal)
    } catch (cause: unknown) {
      this.releasePending(pending)
      pending.reject(new MemberQuestionSenderError(
        'DELIVERY_UNAVAILABLE: the delivery port rejected terminal publication',
        'DELIVERY_UNAVAILABLE',
        { cause },
      ))
      return false
    }
    if (claim.claimed && completion.claimedError !== undefined) {
      this.finishError(pending, completion.claimedError)
      return true
    }
    const terminal = claim.terminal
    if (terminal.outcome === 'answered') {
      this.finishSuccess(pending, {
        questionId: pending.questionId,
        encoded: pending.encoded,
        outcome: 'answered',
        answers: terminal.answers,
      })
      return true
    }
    if (terminal.outcome === 'declined') {
      this.finishSuccess(pending, {
        questionId: pending.questionId,
        encoded: pending.encoded,
        outcome: 'declined',
      })
      return true
    }
    this.finishError(pending, errorForTerminal(terminal.outcome))
    return true
  }

  /** Finish common pending ownership and resolve one successful human terminal. */
  private finishSuccess(pending: PendingAsk, result: MemberQuestionSendResult): void {
    this.releasePending(pending)
    pending.session?.append('member-question/outcome', {
      questionId: pending.questionId,
      outcome: result.outcome,
      ...result.outcome === 'answered' ? { answers: result.answers } : {},
    })
    pending.resolve(result)
  }

  /** Finish common pending ownership and reject with one stable lifetime failure. */
  private finishError(pending: PendingAsk, failure: PendingFailure): void {
    this.releasePending(pending)
    pending.session?.append('member-question/outcome', {
      questionId: pending.questionId,
      outcome: failure.outcome,
    })
    pending.reject(new MemberQuestionSenderError(failure.message, failure.code, {
      ...failure.cause === undefined ? {} : { cause: failure.cause },
    }))
  }

  /** Release timers, watches, listeners, and indexes after terminal publication. */
  private releasePending(pending: PendingAsk): void {
    pending.settled = true
    clearTimeout(pending.timer)
    pending.watchAbort.abort()
    if (pending.abortSignal !== undefined && pending.abortListener !== undefined) {
      pending.abortSignal.removeEventListener('abort', pending.abortListener)
    }
    this.pendingByRoute.delete(pending.routeKey)
    this.pendingById.delete(pending.questionId)
  }
}

/** Internal terminal of one pending ask. */
interface PendingCompletion {
  terminal: CompanionMemberQuestionSettledResult
  claimedError?: PendingFailure
}

/** Local stable failure associated with a terminal candidate. */
interface PendingFailure {
  code: MemberQuestionSenderErrorCode
  message: string
  outcome: MemberQuestionLifetimeOutcome
  cause?: unknown
}

/** Build one system terminal candidate and its local caller-facing failure. */
function systemCompletion(
  pending: PendingAsk,
  terminalOutcome: 'expired' | 'withdrawn' | 'superseded',
  code: MemberQuestionSenderErrorCode,
  message: string,
  cause?: unknown,
  recordedOutcome: MemberQuestionLifetimeOutcome = terminalOutcome,
): PendingCompletion {
  return {
    terminal: {
      type: 'member-question-settled',
      operationId: pending.operationId,
      questionId: pending.questionId,
      outcome: terminalOutcome,
      settledAt: Date.now(),
    },
    claimedError: {
      code,
      message,
      outcome: recordedOutcome,
      ...cause === undefined ? {} : { cause },
    },
  }
}

/** Map a terminal first claimed elsewhere onto this sender's stable outcome. */
function errorForTerminal(outcome: 'expired' | 'withdrawn' | 'superseded'): PendingFailure {
  switch (outcome) {
    case 'expired':
      return {
        code: 'QUESTION_EXPIRED',
        message: 'QUESTION_EXPIRED: the member-question lifetime elapsed unanswered',
        outcome,
      }
    case 'withdrawn':
      return {
        code: 'QUESTION_WITHDRAWN',
        message: 'QUESTION_WITHDRAWN: the member question was withdrawn before an answer committed',
        outcome,
      }
    case 'superseded':
      return {
        code: 'QUESTION_SUPERSEDED',
        message: 'QUESTION_SUPERSEDED: a newer question on the same route committed first',
        outcome,
      }
  }
}

/**
 * Occupancy key of one pending ask: one (origin session, member) pair holds at
 * most one in-flight question.
 * @param originSessionId - asking session identity.
 * @param toProjectMember - addressed member account.
 * @returns a stable map key.
 */
function routeKeyOf(originSessionId: string, toProjectMember: string): string {
  return `${originSessionId}\n${toProjectMember}`
}

/**
 * Encode one member-question payload through the T4 Companion codec.
 * @param protocol - negotiated Companion major 4 protocol.
 * @param payload - Decision Brief origin, background, questions, and references.
 * @param expiresAt - absolute question expiry in Unix epoch milliseconds.
 * @returns the branded question id, Companion message, and encoded bytes.
 * @throws {MemberQuestionSenderError} `ENCODE_FAILED` when the codec rejects the payload.
 */
/**
 * Encode arbitrary reference bytes into bounded Companion document frames.
 * @param protocol - negotiated Companion major 4 protocol.
 * @param questionId - member question owning every document.
 * @param documents - reference paths and bytes in operation reference order.
 * @returns one ordered frame group per input document.
 */
export function encodeMemberQuestionDocuments(
  protocol: NegotiatedCompanionProtocol,
  questionId: MemberQuestionId,
  documents: readonly MemberQuestionDocument[],
): readonly EncodedMemberQuestionDocument[] {
  if (documents.length > REMOTE_PROTOCOL_LIMITS.memberQuestionReferences) {
    throw new MemberQuestionSenderError(
      'ENCODE_FAILED: document count exceeds the member-question reference ceiling',
      'ENCODE_FAILED',
    )
  }
  return documents.map((document, referenceIndex) => {
    if (document.bytes.byteLength > REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes) {
      throw new MemberQuestionSenderError(
        `ENCODE_FAILED: document exceeds the ${String(REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes)}-byte transfer ceiling`,
        'ENCODE_FAILED',
      )
    }
    const total = Math.max(1, Math.ceil(
      document.bytes.byteLength / REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes,
    ))
    if (total > REMOTE_PROTOCOL_LIMITS.documentTransferChunks) {
      throw new MemberQuestionSenderError(
        `ENCODE_FAILED: document exceeds the ${String(REMOTE_PROTOCOL_LIMITS.documentTransferChunks)}-chunk transfer ceiling`,
        'ENCODE_FAILED',
      )
    }
    const transferId = deriveMemberQuestionDocumentTransferId(questionId, referenceIndex)
    const messages: CompanionMessage[] = Array.from({ length: total }, (_, index) => {
      const start = index * REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes
      const operation: CompanionDocumentChunkOperation = {
        type: 'document-chunk',
        operationId: parseCompanionOperationId(`op${randomUUID().replaceAll('-', '')}`),
        transferId,
        questionId,
        index,
        total,
        bytes: encodeProtocolBase64Url(document.bytes.slice(
          start,
          Math.min(document.bytes.byteLength, start + REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes),
        )),
      }
      return { type: 'operation', operation }
    })
    return {
      path: document.path,
      transferId,
      messages,
      encoded: messages.map(message => encodeCompanionMessage(protocol, message)),
    }
  })
}

export function encodeMemberQuestion(
  protocol: NegotiatedCompanionProtocol,
  payload: MemberQuestionSendPayload,
  expiresAt: number,
): EncodedMemberQuestion {
  const questionId = parseMemberQuestionId(`mq${randomUUID().replaceAll('-', '')}`)
  const operationId = parseCompanionOperationId(`op${randomUUID().replaceAll('-', '')}`)
  const operation: CompanionMemberQuestionOperation = {
    type: 'member-question',
    operationId,
    questionId,
    projectId: payload.projectId,
    originSessionId: parseCompanionSessionId(payload.originSessionId),
    expiresAt,
    origin: payload.origin,
    background: payload.background,
    questions: payload.questions,
    references: payload.references.map(reference => ({
      path: reference.path,
      reason: reference.reason,
    })),
  }
  const message: CompanionMessage = { type: 'operation', operation }
  try {
    return { operationId, questionId, message, encoded: encodeCompanionMessage(protocol, message) }
  } catch (cause: unknown) {
    throw new MemberQuestionSenderError(
      'ENCODE_FAILED: the member-question payload is not a valid Companion operation',
      'ENCODE_FAILED',
      { cause },
    )
  }
}

/**
 * Negotiate a major-4 Companion protocol for encoding member-question operations.
 * @returns a process-owned negotiated protocol.
 */
export function createMemberQuestionProtocol(): NegotiatedCompanionProtocol {
  return negotiateCompanionProtocol(
    createCompanionNegotiationChannel(),
    createCompanionVersionOffer('mobile'),
    createCompanionVersionOffer('desktop'),
  )
}

/**
 * In-memory delivery stub for keyless round-trip tests. It records every
 * encoded operation without crossing a machine boundary.
 */
export class MemoryMemberQuestionDelivery implements MemberQuestionDeliveryPort {
  /** Encoded operations accepted by this stub, in send order. */
  readonly delivered: EncodedMemberQuestion[] = []
  private readonly terminals = new Map<MemberQuestionId, CompanionMemberQuestionSettledResult>()

  /**
   * Accept one encoded operation into the in-memory log.
   * @param encoded - codec output plus addressee identity.
   * @returns fulfillment after the operation is recorded.
   */
  deliver(encoded: EncodedMemberQuestion & {
    toProjectMember: string
    projectId: MemberQuestionSendPayload['projectId']
    documents: readonly EncodedMemberQuestionDocument[]
  }): Promise<void> {
    this.delivered.push({
      operationId: encoded.operationId,
      questionId: encoded.questionId,
      message: encoded.message,
      encoded: encoded.encoded,
    })
    return Promise.resolve()
  }

  /**
   * Retain the first terminal candidate for one question.
   * @param terminal - candidate terminal to claim.
   * @returns whether this candidate won and the retained terminal.
   */
  publishTerminal(terminal: CompanionMemberQuestionSettledResult): Promise<MemberQuestionTerminalClaim> {
    const retained = this.terminals.get(terminal.questionId)
    if (retained !== undefined) return Promise.resolve({ claimed: false, terminal: retained })
    this.terminals.set(terminal.questionId, terminal)
    return Promise.resolve({ claimed: true, terminal })
  }

  /**
   * Read one retained terminal for replay.
   * @param questionId - member question to query.
   * @returns retained terminal, or undefined while pending or unknown.
   */
  queryTerminal(questionId: MemberQuestionId): Promise<CompanionMemberQuestionSettledResult | undefined> {
    return Promise.resolve(this.terminals.get(questionId))
  }
}

export { parseMemberQuestionId }
export type { MemberQuestionId, NegotiatedCompanionProtocol }

export default CompanionMemberQuestionSender
