/**
 * Request and delivery types for the member-question sender seam.
 * @module @deepseek-ai/dsh-member-question-sender/types
 */

import type {
  CompanionMemberQuestionItem,
  CompanionMemberQuestionOrigin,
  CompanionMemberQuestionReference,
  CompanionMessage,
  MemberQuestionId,
} from '@deepseek-ai/dsh-remote-protocol'

/** One referenced document attached to a routed member question. */
export type MemberQuestionReference = CompanionMemberQuestionReference

/** One question in a routed member-question batch. */
export type MemberQuestionItem = CompanionMemberQuestionItem

/** Decision Brief origin of one routed member question. */
export type MemberQuestionOrigin = CompanionMemberQuestionOrigin

/**
 * Application payload of one member-directed question. The sender encodes it
 * as a Companion `member-question` operation; origin, background, questions,
 * and references reuse the T4 codec vocabulary without a second protocol.
 */
export interface MemberQuestionSendPayload {
  /** Account reference of the single addressee. */
  readonly toProjectMember: string
  /** Cloud project whose peer grant addresses that member. */
  readonly projectId: string
  /** Agent-authored background; already bounded by the asking tool. */
  readonly background: string
  /** Question batch mirrored from `ask_user_question`. */
  readonly questions: readonly MemberQuestionItem[]
  /** Workspace-validated references; an empty list is admitted. */
  readonly references: readonly MemberQuestionReference[]
  /** Public identity fields rendered on the receiver's Decision Brief. */
  readonly origin: MemberQuestionOrigin
}

/** Encoded Companion operation ready for the injected delivery adapter. */
export interface EncodedMemberQuestion {
  /** Branded question identity correlated with later settlement. */
  readonly questionId: MemberQuestionId
  /** Companion `member-question` operation message. */
  readonly message: CompanionMessage
  /** Bounded Companion application bytes produced by the T4 codec. */
  readonly encoded: Uint8Array
}

/**
 * Injected delivery adapter. Cross-machine registry transport is deferred
 * (the T4 Known Limitation); tests and keyless assemblies inject an in-memory
 * stub. Production delivery stays behind that same gap.
 */
export interface MemberQuestionDelivery {
  /**
   * Deliver one encoded member-question operation to the addressed member.
   * @param encoded - codec output plus the addressee and project identity.
   * @returns fulfillment after the adapter accepts the encoded bytes.
   */
  deliver(encoded: EncodedMemberQuestion & {
    toProjectMember: string
    projectId: string
  }): Promise<void>
}

/** Result of one successful send: the encoded operation plus its question id. */
export interface MemberQuestionSendResult {
  /** Branded question identity the caller correlates with later settlement. */
  readonly questionId: MemberQuestionId
  /** Companion application bytes encoded by the T4 codec. */
  readonly encoded: Uint8Array
}
