/**
 * Request and delivery types for the member-question sender seam.
 * @module @deepseek-ai/dsh-member-question-sender/types
 */

import type {
  CompanionMemberQuestionAnswer,
  CompanionMemberQuestionItem,
  CompanionMemberQuestionOrigin,
  CompanionMemberQuestionReference,
  CompanionMemberQuestionSettledResult,
  CompanionMessage,
  CompanionOperationId,
  CompanionSessionId,
  DocumentTransferId,
  MemberQuestionId,
  ProjectId,
} from '@deepseek-ai/dsh-remote-protocol'

/** One referenced document attached to a routed member question. */
export type MemberQuestionReference = CompanionMemberQuestionReference

/** One question in a routed member-question batch. */
export type MemberQuestionItem = CompanionMemberQuestionItem

/** Decision Brief origin of one routed member question. */
export type MemberQuestionOrigin = CompanionMemberQuestionOrigin

/** One settling answer echoed by question id. */
export type MemberQuestionAnswer = CompanionMemberQuestionAnswer

/** Source bytes for one routed reference document. */
export interface MemberQuestionDocument {
  /** Workspace-relative path matching the operation's reference entry. */
  readonly path: string
  /** Arbitrary file bytes read before the routed ask leaves its Workspace. */
  readonly bytes: Uint8Array
}

/** Bounded Companion frames carrying one routed reference document. */
export interface EncodedMemberQuestionDocument {
  /** Workspace-relative path matching the operation's reference entry. */
  readonly path: string
  /** Transfer identity derived from the question and reference position. */
  readonly transferId: DocumentTransferId
  /** Typed Companion messages in chunk order. */
  readonly messages: readonly CompanionMessage[]
  /** Encoded Companion application frames in chunk order. */
  readonly encoded: readonly Uint8Array[]
}

/**
 * Application payload of one member-directed question. The sender encodes it
 * as a Companion `member-question` operation; origin, background, questions,
 * and references reuse the T4 codec vocabulary without a second protocol.
 */
export interface MemberQuestionSendPayload {
  /** Account reference of the single addressee. */
  readonly toProjectMember: string
  /** Cloud project whose peer grant addresses that member. */
  readonly projectId: ProjectId
  /** Agent-authored background; already bounded by the asking tool. */
  readonly background: string
  /** Question batch mirrored from `ask_user_question`. */
  readonly questions: readonly MemberQuestionItem[]
  /** Workspace-validated references; an empty list is admitted. */
  readonly references: readonly MemberQuestionReference[]
  /** File bytes aligned 1:1 with references; omission is valid only when references is empty. */
  readonly documents?: readonly MemberQuestionDocument[]
  /** Public identity fields rendered on the receiver's Decision Brief. */
  readonly origin: MemberQuestionOrigin
  /** Originating session identity used as one half of the supersede route key. */
  readonly originSessionId: CompanionSessionId
}

/** Encoded Companion operation ready for the injected delivery port. */
export interface EncodedMemberQuestion {
  /** Companion mutation identity used by status replay. */
  readonly operationId: CompanionOperationId
  /** Branded question identity correlated with later settlement. */
  readonly questionId: MemberQuestionId
  /** Companion `member-question` operation message. */
  readonly message: CompanionMessage
  /** Bounded Companion application bytes produced by the T4 codec. */
  readonly encoded: Uint8Array
}

/** Result of one atomic terminal publication attempt. */
export interface MemberQuestionTerminalClaim {
  /** Whether this publication committed the first terminal for the question. */
  readonly claimed: boolean
  /** Authoritative first terminal, equal to the candidate only when this publication won. */
  readonly terminal: CompanionMemberQuestionSettledResult
}

/**
 * Delivery seam for member-question operations and their first-claim terminal
 * results. Cross-machine registry transport is deferred; tests and keyless
 * assemblies inject an in-memory implementation, while production remains fail-closed.
 */
export interface MemberQuestionDeliveryPort {
  /**
   * Deliver one encoded member-question operation to the addressed member.
   * @param encoded - codec output plus the addressee and project identity.
   * @returns fulfillment after the port accepts the encoded bytes.
   */
  deliver(encoded: EncodedMemberQuestion & {
    toProjectMember: string
    projectId: ProjectId
    documents: readonly EncodedMemberQuestionDocument[]
  }): Promise<void>

  /**
   * Atomically publish one terminal candidate; the first claim remains authoritative.
   * @param terminal - candidate encoded by the sender or receiving Installation.
   * @returns whether this candidate won and the authoritative retained terminal.
   */
  publishTerminal(terminal: CompanionMemberQuestionSettledResult): Promise<MemberQuestionTerminalClaim>

  /**
   * Query the retained first terminal for reconnect replay.
   * @param questionId - member-question identity to replay.
   * @returns the authoritative terminal, or undefined while still pending or unknown.
   */
  queryTerminal(questionId: MemberQuestionId): Promise<CompanionMemberQuestionSettledResult | undefined>
}

/** Successful routed-ask settlement: the member answered the batch. */
export interface MemberQuestionAnsweredResult {
  /** Branded question identity the caller correlates with later settlement. */
  readonly questionId: MemberQuestionId
  /** Companion application bytes encoded by the T4 codec. */
  readonly encoded: Uint8Array
  /** Terminal answered outcome. */
  readonly outcome: 'answered'
  /** Settling answers echoed by question id. */
  readonly answers: readonly MemberQuestionAnswer[]
}

/** Successful routed-ask settlement: the member declined without answering. */
export interface MemberQuestionDeclinedResult {
  /** Branded question identity the caller correlates with later settlement. */
  readonly questionId: MemberQuestionId
  /** Companion application bytes encoded by the T4 codec. */
  readonly encoded: Uint8Array
  /** Terminal declined outcome. */
  readonly outcome: 'declined'
}

/** Result of one successful send: an answered or declined settlement. */
export type MemberQuestionSendResult = MemberQuestionAnsweredResult | MemberQuestionDeclinedResult

/** Terminal lifetime outcome recorded on the asking session. */
export type MemberQuestionLifetimeOutcome =
  | 'answered'
  | 'declined'
  | 'expired'
  | 'withdrawn'
  | 'superseded'
  | 'offline'
  | 'revoked'

/** Durable ask-summary payload recorded on the asking session. */
export interface MemberQuestionAskedRecord {
  /** Branded question identity correlated with the matching outcome. */
  readonly questionId: MemberQuestionId
  /** Account reference of the single addressee. */
  readonly toProjectMember: string
  /** Cloud project whose peer grant addresses that member. */
  readonly projectId: ProjectId
  /** Agent-authored background already admitted by the asking tool. */
  readonly background: string
  /** Question ids and prompts retained as the model-visible ask summary. */
  readonly questions: readonly { readonly id: string; readonly question: string }[]
  /** Originating session identity used as one half of the supersede route key. */
  readonly originSessionId: CompanionSessionId
}

/** Durable outcome payload recorded on the asking session. */
export interface MemberQuestionOutcomeRecord {
  /** Branded question identity matching the prior asked record. */
  readonly questionId: MemberQuestionId
  /** Terminal lifetime outcome. */
  readonly outcome: MemberQuestionLifetimeOutcome
  /** Settling answers, present only for the answered outcome. */
  readonly answers?: readonly MemberQuestionAnswer[]
}
