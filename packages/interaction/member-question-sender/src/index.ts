/**
 * Service Definition and codec-backed Provider for member-directed questions
 * (`ctx.memberQuestionSender`). The Provider encodes a Companion
 * `member-question` operation through the T4 remote-protocol codec and
 * delivers the bytes through an injected adapter. Peer credentials are
 * retrieved through an injected B-side lookup over Remote Access
 * `getProjectPeerGrant`. Cross-machine registry transport remains the T4
 * Known Limitation, so delivery is injectable and tests use an in-memory stub.
 * @module @deepseek-ai/dsh-member-question-sender
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SealedProjectPeerGrant } from '@deepseek-ai/dsh-remote-access'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseMemberQuestionId,
  type CompanionMemberQuestionOperation,
  type CompanionMessage,
  type MemberQuestionId,
  type NegotiatedCompanionProtocol,
} from '@deepseek-ai/dsh-remote-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemberQuestionSenderError } from './errors.ts'
import type { MemberQuestionSenderErrorCode } from './errors.ts'
import type {
  EncodedMemberQuestion,
  MemberQuestionAnswer,
  MemberQuestionAskedRecord,
  MemberQuestionDelivery,
  MemberQuestionLifetimeOutcome,
  MemberQuestionOutcomeRecord,
  MemberQuestionSendPayload,
  MemberQuestionSendResult,
} from './types.ts'

export { MemberQuestionSenderError } from './errors.ts'
export type { MemberQuestionSenderErrorCode } from './errors.ts'
export type {
  EncodedMemberQuestion,
  MemberQuestionAnswer,
  MemberQuestionAskedRecord,
  MemberQuestionDelivery,
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
  projectId: string
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
  projectId: string
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
  projectId: string
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
  | { outcome: 'answered'; answers: readonly MemberQuestionAnswer[] }
  | { outcome: 'declined' }

/** Construction-owned faces injected into the sender Provider. */
export interface Config {
  /**
   * Delivers encoded Companion bytes to the addressed member's route. Absent,
   * `send()` answers the stable `DELIVERY_UNAVAILABLE` error — the same
   * fail-closed stance as the deferred registry transport.
   */
  delivery?: MemberQuestionDelivery
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
  delivery: MemberQuestionDelivery | undefined
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
  if (config.delivery !== undefined && typeof config.delivery.deliver !== 'function') {
    throw new TypeError('member-question-sender: config.delivery must implement deliver()')
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
   * @throws {MemberQuestionSenderError} `DELIVERY_UNAVAILABLE` when no adapter is composed,
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
   * @param settlement - answered answers or a declined verdict.
   * @returns fulfillment after the matching `send()` promise settles, or immediately when none is pending.
   */
  abstract settle(questionId: MemberQuestionId, settlement: MemberQuestionSettlement): Promise<void>

  /**
   * Withdraw one pending question as initiator cancellation.
   * Unknown or already-settled question ids are ignored.
   * @param questionId - branded question identity returned by `send()`.
   * @returns fulfillment after the matching `send()` promise rejects `QUESTION_WITHDRAWN`, or immediately when none is pending.
   */
  abstract withdraw(questionId: MemberQuestionId): Promise<void>
}

/** One in-flight routed ask waiting for a terminal settlement. */
interface PendingAsk {
  readonly questionId: MemberQuestionId
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
}

/**
 * Codec-backed sender Provider. Encoding reuses the T4 Companion codec;
 * delivery is the injected adapter; grant retrieval is the B-side lookup.
 */
export class CompanionMemberQuestionSender extends MemberQuestionSenderService {
  static Config = Config

  private readonly delivery: MemberQuestionDelivery | undefined
  private readonly lookupGrant: ProjectPeerGrantLookup | undefined
  private readonly presenceLookup: MemberPresenceLookup | undefined
  private readonly watchMembership: MemberMembershipWatch | undefined
  private readonly ttlMs: number
  private readonly protocol: NegotiatedCompanionProtocol
  private readonly pendingByRoute = new Map<string, PendingAsk>()
  private readonly pendingById = new Map<MemberQuestionId, PendingAsk>()

  /**
   * @param ctx - composition context receiving this service.
   * @param config - injected delivery adapter and optional grant lookup.
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
    ctx.effect(() => () => {
      for (const pending of [...this.pendingById.values()]) {
        this.complete(pending, {
          kind: 'error',
          code: 'QUESTION_WITHDRAWN',
          message: 'QUESTION_WITHDRAWN: the member-question sender was disposed while the ask was in flight',
          outcome: 'withdrawn',
        })
      }
    })
  }

  override async send(
    payload: MemberQuestionSendPayload,
    options: MemberQuestionSendOptions = {},
  ): Promise<MemberQuestionSendResult> {
    if (this.delivery === undefined) {
      throw new MemberQuestionSenderError(
        'DELIVERY_UNAVAILABLE: member-question delivery is not composed; inject a delivery adapter',
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
    const encoded = encodeMemberQuestion(this.protocol, payload)
    const pending = this.registerPending(
      encoded.questionId,
      routeKeyOf(payload.originSessionId, payload.toProjectMember),
      encoded.encoded,
      options,
    )
    this.recordAsked(pending, payload)
    this.armMembershipWatch(pending, payload)
    try {
      await this.delivery.deliver({
        ...encoded,
        toProjectMember: payload.toProjectMember,
        projectId: payload.projectId,
      })
    } catch (cause: unknown) {
      this.complete(pending, {
        kind: 'error',
        code: 'DELIVERY_UNAVAILABLE',
        message: 'DELIVERY_UNAVAILABLE: the composed delivery adapter rejected the encoded operation',
        outcome: 'withdrawn',
        cause,
      })
    }
    return pending.promise
  }

  override settle(questionId: MemberQuestionId, settlement: MemberQuestionSettlement): Promise<void> {
    const pending = this.pendingById.get(questionId)
    if (pending === undefined) return Promise.resolve()
    if (settlement.outcome === 'answered') {
      this.complete(pending, {
        kind: 'success',
        result: {
          questionId: pending.questionId,
          encoded: pending.encoded,
          outcome: 'answered',
          answers: settlement.answers,
        },
      })
      return Promise.resolve()
    }
    this.complete(pending, {
      kind: 'success',
      result: {
        questionId: pending.questionId,
        encoded: pending.encoded,
        outcome: 'declined',
      },
    })
    return Promise.resolve()
  }

  override withdraw(questionId: MemberQuestionId): Promise<void> {
    const pending = this.pendingById.get(questionId)
    if (pending === undefined) return Promise.resolve()
    this.complete(pending, {
      kind: 'error',
      code: 'QUESTION_WITHDRAWN',
      message: 'QUESTION_WITHDRAWN: the initiating turn cancelled the in-flight ask',
      outcome: 'withdrawn',
    })
    return Promise.resolve()
  }

  /**
   * Register one pending ask, arm TTL and abort-signal withdrawal, and index it
   * by route key and question id.
   * @param questionId - branded identity of the encoded operation.
   * @param routeKey - `(originSession, member)` occupancy key.
   * @param encoded - Companion application bytes retained for the send result.
   * @param options - asking session and withdrawal signal.
   * @returns the pending cell whose promise `send()` returns.
   */
  private registerPending(
    questionId: MemberQuestionId,
    routeKey: string,
    encoded: Uint8Array,
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
      questionId,
      routeKey,
      session: options.session,
      encoded,
      promise,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.complete(pending, {
          kind: 'error',
          code: 'QUESTION_EXPIRED',
          message: 'QUESTION_EXPIRED: the member-question lifetime elapsed unanswered',
          outcome: 'expired',
        })
      }, this.ttlMs),
      watchAbort,
      abortSignal: options.signal,
      abortListener: undefined,
      settled: false,
    }
    const superseded = this.pendingByRoute.get(routeKey)
    this.pendingByRoute.set(routeKey, pending)
    this.pendingById.set(questionId, pending)
    if (superseded !== undefined) {
      this.complete(superseded, {
        kind: 'error',
        code: 'QUESTION_SUPERSEDED',
        message: 'QUESTION_SUPERSEDED: a newer question on the same origin-session and member replaced this ask',
        outcome: 'superseded',
      })
    }
    if (options.signal !== undefined) {
      const listener = (): void => {
        this.complete(pending, {
          kind: 'error',
          code: 'QUESTION_WITHDRAWN',
          message: 'QUESTION_WITHDRAWN: the initiating turn cancelled the in-flight ask',
          outcome: 'withdrawn',
        })
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
        this.complete(pending, {
          kind: 'error',
          code: 'REVOKED_DURING_FLIGHT',
          message: 'REVOKED_DURING_FLIGHT: the addressed member lost project membership while the ask was in flight',
          outcome: 'revoked',
        })
      },
      (cause: unknown) => {
        if (pending.watchAbort.signal.aborted || pending.settled) return
        this.complete(pending, {
          kind: 'error',
          code: 'REVOKED_DURING_FLIGHT',
          message: 'REVOKED_DURING_FLIGHT: membership watch failed while the ask was in flight',
          outcome: 'revoked',
          cause,
        })
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
   * Settle one pending ask exactly once: clear timers and watches, record the
   * durable outcome, and resolve or reject the hanging `send()` promise.
   * @param pending - in-flight ask to complete.
   * @param completion - success settlement or stable lifetime error.
   */
  private complete(pending: PendingAsk, completion: PendingCompletion): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    pending.watchAbort.abort()
    if (pending.abortSignal !== undefined && pending.abortListener !== undefined) {
      pending.abortSignal.removeEventListener('abort', pending.abortListener)
    }
    if (this.pendingByRoute.get(pending.routeKey) === pending) this.pendingByRoute.delete(pending.routeKey)
    this.pendingById.delete(pending.questionId)
    if (completion.kind === 'success') {
      pending.session?.append('member-question/outcome', {
        questionId: pending.questionId,
        outcome: completion.result.outcome,
        ...completion.result.outcome === 'answered' ? { answers: completion.result.answers } : {},
      })
      pending.resolve(completion.result)
      return
    }
    pending.session?.append('member-question/outcome', {
      questionId: pending.questionId,
      outcome: completion.outcome,
    })
    pending.reject(new MemberQuestionSenderError(completion.message, completion.code, {
      ...completion.cause === undefined ? {} : { cause: completion.cause },
    }))
  }
}

/** Internal terminal of one pending ask. */
type PendingCompletion =
  | { kind: 'success'; result: MemberQuestionSendResult }
  | {
    kind: 'error'
    code: MemberQuestionSenderErrorCode
    message: string
    outcome: MemberQuestionLifetimeOutcome
    cause?: unknown
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
 * @returns the branded question id, Companion message, and encoded bytes.
 * @throws {MemberQuestionSenderError} `ENCODE_FAILED` when the codec rejects the payload.
 */
export function encodeMemberQuestion(
  protocol: NegotiatedCompanionProtocol,
  payload: MemberQuestionSendPayload,
): EncodedMemberQuestion {
  const questionId = parseMemberQuestionId(`mq${randomUUID().replaceAll('-', '')}`)
  const operation: CompanionMemberQuestionOperation = {
    type: 'member-question',
    operationId: parseCompanionOperationId(`op${randomUUID().replaceAll('-', '')}`),
    questionId,
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
    return { questionId, message, encoded: encodeCompanionMessage(protocol, message) }
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
export class MemoryMemberQuestionDelivery implements MemberQuestionDelivery {
  /** Encoded operations accepted by this stub, in send order. */
  readonly delivered: EncodedMemberQuestion[] = []

  /**
   * Accept one encoded operation into the in-memory log.
   * @param encoded - codec output plus addressee identity.
   * @returns fulfillment after the operation is recorded.
   */
  deliver(encoded: EncodedMemberQuestion & { toProjectMember: string; projectId: string }): Promise<void> {
    this.delivered.push({
      questionId: encoded.questionId,
      message: encoded.message,
      encoded: encoded.encoded,
    })
    return Promise.resolve()
  }
}

export { parseMemberQuestionId }
export type { MemberQuestionId, NegotiatedCompanionProtocol }

export default CompanionMemberQuestionSender
