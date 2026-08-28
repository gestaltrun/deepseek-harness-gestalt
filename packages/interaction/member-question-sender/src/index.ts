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
import { MemberQuestionSenderError } from './errors.ts'
import type {
  EncodedMemberQuestion,
  MemberQuestionDelivery,
  MemberQuestionSendPayload,
  MemberQuestionSendResult,
} from './types.ts'

export { MemberQuestionSenderError } from './errors.ts'
export type { MemberQuestionSenderErrorCode } from './errors.ts'
export type {
  EncodedMemberQuestion,
  MemberQuestionDelivery,
  MemberQuestionItem,
  MemberQuestionOrigin,
  MemberQuestionReference,
  MemberQuestionSendPayload,
  MemberQuestionSendResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memberQuestionSender: MemberQuestionSenderService
  }
}

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
}

/** Schemastery configuration for the sender Provider. */
export const Config: z<Config> = z.object({
  delivery: z.any(),
  lookupGrant: z.any(),
})

/**
 * Validate the injected faces loudly for both Loader-normalized and
 * programmatic construction, so misconfiguration fails at load.
 * @param config - raw plugin config.
 * @returns the same config once every present face has the expected shape.
 */
function resolveConfig(config: Config): Config {
  if (config.delivery !== undefined && typeof config.delivery.deliver !== 'function') {
    throw new TypeError('member-question-sender: config.delivery must implement deliver()')
  }
  if (config.lookupGrant !== undefined && typeof config.lookupGrant !== 'function') {
    throw new TypeError('member-question-sender: config.lookupGrant must be a lookup function')
  }
  return config
}

/**
 * Member-question sender capability. `send(payload)` encodes one Companion
 * `member-question` operation and hands the bytes to the composed delivery
 * adapter.
 */
export abstract class MemberQuestionSenderService extends Service {
  /** @param ctx - composition context receiving this service. */
  constructor(ctx: Context) {
    super(ctx, 'memberQuestionSender')
  }

  /**
   * Encode one member-directed question and deliver it to the addressed member.
   * @param payload - Decision Brief origin, background, question batch, and references.
   * @returns the branded question id and the encoded Companion application bytes.
   * @throws {MemberQuestionSenderError} `DELIVERY_UNAVAILABLE` when no adapter is composed,
   *   `GRANT_UNAVAILABLE` when a composed grant lookup cannot retrieve the peer grant,
   *   or `ENCODE_FAILED` when the T4 codec rejects the payload.
   */
  abstract send(payload: MemberQuestionSendPayload): Promise<MemberQuestionSendResult>
}

/**
 * Codec-backed sender Provider. Encoding reuses the T4 Companion codec;
 * delivery is the injected adapter; grant retrieval is the B-side lookup.
 */
export class CompanionMemberQuestionSender extends MemberQuestionSenderService {
  static Config = Config

  private readonly delivery: MemberQuestionDelivery | undefined
  private readonly lookupGrant: ProjectPeerGrantLookup | undefined
  private readonly protocol: NegotiatedCompanionProtocol

  /**
   * @param ctx - composition context receiving this service.
   * @param config - injected delivery adapter and optional grant lookup.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const resolved = resolveConfig(config)
    this.delivery = resolved.delivery
    this.lookupGrant = resolved.lookupGrant
    this.protocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
  }

  override async send(payload: MemberQuestionSendPayload): Promise<MemberQuestionSendResult> {
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
    const encoded = encodeMemberQuestion(this.protocol, payload)
    await this.delivery.deliver({
      ...encoded,
      toProjectMember: payload.toProjectMember,
      projectId: payload.projectId,
    })
    return { questionId: encoded.questionId, encoded: encoded.encoded }
  }
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
