import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { ProjectId } from '@deepseek-ai/dsh-project-membership'
import type { SessionId as HostSessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CompanionMemberQuestionAnswer,
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
  /** Stable question identity from the authenticated operation. */
  readonly questionId: MemberQuestionId
  /** Opaque Host identity of the receiving thread. */
  readonly receivingSessionId: ReceivingSessionId
  /** Account whose endpoint accepted the operation. */
  readonly receivingAccountId: PlatformAccountId
  /** Durable receiver revision that published this row. */
  readonly revision: number
  /** Absolute Unix epoch milliseconds when the Host accepted the operation. */
  readonly arrivedAt: number
  /** Bounded authenticated member-question operation. */
  readonly operation: CompanionMemberQuestionOperation
  /** Ordinary Host Session identity after the first explicit human admission. */
  readonly hostSessionId?: HostSessionId
  /** Durable retry identity while a human-turn admission remains reserved. */
  readonly reservedAdmission?: {
    /** Envelope identity the Client must reuse for the reserved action. */
    readonly rpcId: MemberQuestionReceiverRpcId
    /** Original admission mode retained even if the Session begins running. */
    readonly mode: 'queue' | 'steer'
  }
}

/** Terminal receiver record retaining the globally authoritative first claim. */
export interface TerminalMemberQuestionView extends Omit<PendingMemberQuestionView, 'operation'> {
  /** Globally authoritative first-claim terminal. */
  readonly terminal: CompanionMemberQuestionSettledResult
  /** Bounded received operation retained for passive record rendering. */
  readonly brief: Omit<CompanionMemberQuestionOperation, 'questions'> & {
    /** Original question batch retained with the terminal record. */
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
    readonly kind: 'answered'
    readonly answers: readonly CompanionMemberQuestionAnswer[]
    readonly settledByInstallationId: InstallationId
    readonly settledByDeviceName: string
    readonly settledAt: number
  }
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
interface MemberQuestionHumanTextContent {
  /** Content discriminant. */
  readonly type: 'text'
  /** Human-authored text. */
  readonly text: string
}

/** Human-selected image committed by the Host attachment service before reservation. */
interface MemberQuestionHumanImageContent {
  /** Content discriminant. */
  readonly type: 'image'
  /** Durable normalized attachment; raw browser bytes never enter the receiver ledger. */
  readonly attachment: ImageAttachmentRef
}

/** Durable human content handed to the Host Session adapter. */
export type MemberQuestionHumanTurnContent = MemberQuestionHumanTextContent | MemberQuestionHumanImageContent

/** One explicit human turn addressed to a receiving Session. */
export interface AdmitMemberQuestionHumanTurnInput {
  /** Host-owned receiving thread to materialize or continue. */
  readonly receivingSessionId: ReceivingSessionId
  /** Exact receiving-thread revision the human observed. */
  readonly revision: number
  /** Stable idempotency identity retained across retries. */
  readonly rpcId: MemberQuestionReceiverRpcId
  /** Human-authored content retained durably for crash-safe admission replay. */
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
interface MemberQuestionHumanTurnAdmissionReceipt {
  /** The adapter materialized and admitted the human turn. */
  readonly accepted: true
}

/** Durable receiver facts needed by one Host materialize-and-admit operation. */
export interface MemberQuestionHumanTurnAdmissionContext {
  /** Account whose local workspace receives the Host Session. */
  readonly receivingAccountId: PlatformAccountId
  /** Cloud project whose accepted membership selects that workspace. */
  readonly projectId: ProjectId
  /** Every retained question on this receiving thread, in arrival order. */
  readonly questions: readonly (PendingMemberQuestionView | TerminalMemberQuestionView)[]
}

/** Local project-member Workspace association supplied by the Host composition. */
export interface MemberQuestionWorkspaceBinding {
  /**
   * Persist or replace the exact local Workspace selected during invitation acceptance.
   * @param accountId - authenticated receiving Account.
   * @param projectId - Cloud Project being joined.
   * @param workspaceId - exact local Workspace selected or cloned.
   */
  bind(accountId: PlatformAccountId, projectId: ProjectId, workspaceId: Branded<'WorkspaceId'>): Promise<void>
  /**
   * Read the persisted local Workspace selection without requiring one to exist.
   * @param accountId - authenticated receiving Account.
   * @param projectId - cloud Project whose local association is being inspected.
   * @returns exact local Workspace identity, or undefined before the first binding.
   */
  lookup(accountId: PlatformAccountId, projectId: ProjectId): Promise<Branded<'WorkspaceId'> | undefined>
  /**
   * Replace a binding only when its current value still matches the caller's observation.
   * @param accountId - authenticated receiving Account.
   * @param projectId - cloud Project whose local association is being repaired.
   * @param expectedWorkspaceId - exact current value observed by the caller, including undefined.
   * @param workspaceId - exact live Workspace proposed as the replacement.
   * @returns whether the comparison matched and the replacement committed.
   */
  bindIfCurrent(
    accountId: PlatformAccountId,
    projectId: ProjectId,
    expectedWorkspaceId: Branded<'WorkspaceId'> | undefined,
    workspaceId: Branded<'WorkspaceId'>,
  ): Promise<boolean>
  /**
   * Resolve one authenticated receiver/project pair to an existing Workspace id.
   * @param accountId - authenticated receiving Account.
   * @param projectId - cloud Project carried by the received operation.
   * @returns exact local Workspace identity.
   */
  resolve(accountId: PlatformAccountId, projectId: ProjectId): Promise<Branded<'WorkspaceId'>>
}

/**
 * High-level Host adapter that materializes the receiving Session if needed
 * and admits the human turn atomically under `rpcId` idempotency.
 */
export type MemberQuestionHumanTurnAdmitter = (
  input: AdmitMemberQuestionHumanTurnInput,
  context: MemberQuestionHumanTurnAdmissionContext,
) => Promise<MemberQuestionHumanTurnAdmissionReceipt>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Bounded Decision Brief metadata received from another project member. */
    'member-question/received': {
      questionId: MemberQuestionId
      projectId: ProjectId
      originSessionId: HostSessionId
      arrivedAt: number
      expiresAt: number
      origin: CompanionMemberQuestionOperation['origin']
      background: string
      questions: CompanionMemberQuestionOperation['questions']
      references: CompanionMemberQuestionOperation['references']
    }
    /** Canonical terminal metadata for one received member question. */
    'member-question/settled': CompanionMemberQuestionSettledResult
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memberQuestionWorkspaceBinding: MemberQuestionWorkspaceBinding
  }
}

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
