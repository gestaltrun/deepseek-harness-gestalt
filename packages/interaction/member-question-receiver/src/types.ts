import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type {
  CompanionMemberQuestionOperation,
  CompanionMemberQuestionSettledResult,
  InstallationId,
  MemberQuestionId,
} from '@deepseek-ai/dsh-remote-protocol'

/** Host-owned durable identity of one member-question receiving thread. */
export type ReceivingSessionId = Branded<'ReceivingSessionId'>
/** Stable caller idempotency identity for one explicit human turn. */
export type MemberQuestionReceiverRpcId = Branded<'MemberQuestionReceiverRpcId'>

/** Authenticated receiver identity supplied by the endpoint, never by question plaintext. */
export interface MemberQuestionReceiverAuthority {
  readonly accountId: PlatformAccountId
}

/** One decoded operation paired with endpoint-authenticated receiver authority. */
export interface AuthenticatedMemberQuestionEnvelope {
  readonly authority: MemberQuestionReceiverAuthority
  readonly operation: CompanionMemberQuestionOperation
}

/** Pending receiver projection retained without referenced document bodies. */
export interface PendingMemberQuestionView {
  readonly questionId: MemberQuestionId
  readonly receivingSessionId: ReceivingSessionId
  readonly receivingAccountId: PlatformAccountId
  readonly revision: number
  readonly arrivedAt: number
  readonly operation: CompanionMemberQuestionOperation
}

/** Terminal receiver record retaining the globally authoritative first claim. */
export interface TerminalMemberQuestionView extends Omit<PendingMemberQuestionView, 'operation'> {
  readonly terminal: CompanionMemberQuestionSettledResult
  readonly brief: Omit<CompanionMemberQuestionOperation, 'questions'> & {
    readonly questions: CompanionMemberQuestionOperation['questions']
  }
}

/** Authoritative receiver projection at one durable revision. */
export interface MemberQuestionReceiverSnapshot {
  readonly revision: number
  readonly pending: readonly PendingMemberQuestionView[]
  readonly terminal: readonly TerminalMemberQuestionView[]
}

/** Subscription callback receiving a complete committed receiver projection. */
export type MemberQuestionReceiverListener = (snapshot: MemberQuestionReceiverSnapshot) => void

/** Result of admitting or replaying one authenticated arrival. */
export interface MemberQuestionIngestResult {
  readonly questionId: MemberQuestionId
  readonly receivingSessionId: ReceivingSessionId
  readonly revision: number
}

/** Package-folded Consumer adapter for one authenticated endpoint callback. */
export type AuthenticatedMemberQuestionIngress = (
  envelope: AuthenticatedMemberQuestionEnvelope,
) => Promise<MemberQuestionIngestResult>

/** One receiver-ledger commit published after atomic replacement succeeds. */
export interface MemberQuestionReceiverChange {
  readonly revision: number
  readonly questionId: MemberQuestionId
  readonly state: 'pending' | CompanionMemberQuestionSettledResult['outcome']
}

/** Result of one global first-terminal claim. */
export interface MemberQuestionTerminalClaim {
  /** Whether this candidate committed the first global terminal. */
  readonly claimed: boolean
  /** Canonical first terminal, whether this candidate won or lost. */
  readonly terminal: CompanionMemberQuestionSettledResult
}

/** Authority adapter retaining exactly one global terminal per question id. */
export interface MemberQuestionTerminalAuthority {
  /**
   * Commit or replay the first terminal for one question.
   * @param candidate - terminal proposed by this Host.
   * @returns the canonical retained terminal, including when another Installation won.
   */
  claim(candidate: CompanionMemberQuestionSettledResult): Promise<MemberQuestionTerminalClaim>
}

/** Explicit receiver decline or an authoritative first claim delivered by transport. */
export type MemberQuestionReceiverSettlement =
  | {
    readonly kind: 'declined'
    readonly settledByInstallationId: InstallationId
    readonly settledByDeviceName: string
    readonly settledAt: number
  }
  | {
    readonly kind: 'authoritative'
    readonly claim: MemberQuestionTerminalClaim
  }

/** Human-authored text handed to the future Host Session adapter. */
export interface MemberQuestionHumanTextContent {
  /** Content discriminant. */
  readonly type: 'text'
  /** Human-authored text. */
  readonly text: string
}

/** Human-selected image handed to the future Host Session adapter. */
export interface MemberQuestionHumanImageContent {
  /** Content discriminant. */
  readonly type: 'image'
  /** Browser-declared image media type. */
  readonly mediaType: string
  /** Base64 payload consumed by the future Host adapter. */
  readonly data: string
  /** Optional human-facing file name. */
  readonly name?: string
}

/** High-level human content handed to the future Host Session adapter. */
export type MemberQuestionHumanTurnContent = MemberQuestionHumanTextContent | MemberQuestionHumanImageContent

/** One explicit human turn addressed to a receiving Session. */
export interface AdmitMemberQuestionHumanTurnInput {
  /** Host-owned receiving thread to materialize or continue. */
  readonly receivingSessionId: ReceivingSessionId
  /** Exact receiving-thread revision the human observed. */
  readonly revision: number
  /** Stable idempotency identity retained across retries. */
  readonly rpcId: MemberQuestionReceiverRpcId
  /** Human-authored content excluded from the receiver ledger body. */
  readonly content: readonly MemberQuestionHumanTurnContent[]
  /** Ordinary Host queue or steering admission mode. */
  readonly mode: 'queue' | 'steer'
}

/** Durable result of one admitted human turn. */
export interface AdmitMemberQuestionHumanTurnResult {
  readonly accepted: true
  readonly receivingSessionId: ReceivingSessionId
  readonly revision: number
  readonly rpcId: MemberQuestionReceiverRpcId
}

/** Successful high-level Host adapter admission. */
export interface MemberQuestionHumanTurnAdmissionReceipt {
  /** The adapter materialized and admitted the human turn. */
  readonly accepted: true
}

/**
 * High-level Host adapter that materializes the receiving Session if needed
 * and admits the human turn atomically under `rpcId` idempotency.
 */
export type MemberQuestionHumanTurnAdmitter = (
  input: AdmitMemberQuestionHumanTurnInput,
) => Promise<MemberQuestionHumanTurnAdmissionReceipt>

/** Injectable scheduler used for the one earliest authoritative expiry. */
export interface MemberQuestionReceiverTimer {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

/** Atomic durable replacement adapter; production uses `writeFileAtomic`. */
export type MemberQuestionReceiverStateWriter = (path: string, content: string) => Promise<void>

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The receiver ledger committed one authoritative question-state change.
     * @param change - durable revision, question identity, and committed state.
     * @mode emit
     */
    'member-question-receiver/changed'(change: MemberQuestionReceiverChange): void
  }
}
