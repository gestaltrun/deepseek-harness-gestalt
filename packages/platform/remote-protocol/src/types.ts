import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque Relay routing identifier with no application-domain meaning. */
export type RelayRouteId = Branded<'RelayRouteId'>

/** Opaque identifier for one live Relay attachment. */
export type RelayAttachmentId = Branded<'RelayAttachmentId'>

/** Opaque non-secret selector for one Personal Pairing's endpoint-owned static state. */
export type RelayPairingSelector = Branded<'RelayPairingSelector'>

/** Endpoint-owned P-256 PKCS#8 attachment signing key in canonical base64url form. */
export type RelayCredential = Branded<'RelayCredential'>
/** Endpoint P-256 SPKI verifier visible to Relay without granting signing authority. */
export type RelayCredentialPublicKey = Branded<'RelayCredentialPublicKey'>
/** Opaque identity of one single-use Relay attachment challenge. */
export type RelayAttachChallengeId = Branded<'RelayAttachChallengeId'>

/** Exactly 256 bits of one-time attachment blob authority in canonical base64url form. */
export type AttachmentCapability = Branded<'AttachmentCapability'>

/** Protocol-native identifier for one Desktop-authoritative operation. */
export type CompanionOperationId = Branded<'CompanionOperationId'>

/** Pairing-private identity of one pending Approval or Ask User request. */
export type CompanionInteractionId = Branded<'CompanionInteractionId'>

/** Protocol-native identifier for an approved Session projection or operation target. */
export type CompanionSessionId = Branded<'CompanionSessionId'>

/** Protocol-native identifier for one Desktop Workspace target. */
export type CompanionWorkspaceId = Branded<'CompanionWorkspaceId'>

/** Protocol-native identifier for one ordered transcript projection entry. */
export type CompanionTranscriptEntryId = Branded<'CompanionTranscriptEntryId'>

/** Security property required for a Companion major to remain negotiable. */
export type CompanionSecurityCapability =
  | 'authenticated-encryption'
  | 'pairing-key-separation'
  | 'replay-protection'

/** One supported Companion major and the security properties it preserves. */
export interface CompanionVersionDescriptor {
  major: 1 | 2 | 3
  capabilities: readonly CompanionSecurityCapability[]
}

/** Application-version offer exchanged before application plaintext. */
export interface CompanionVersionOffer {
  endpoint: 'mobile' | 'desktop'
  versions: readonly CompanionVersionDescriptor[]
}

/** Approved prompt submission to one opaque Companion Session target. */
export interface CompanionSubmitPromptOperation {
  type: 'submit-prompt'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
  text: string
}

/** Bounded Mobile control message pointing Desktop at one Platform-retained encrypted blob. */
export interface CompanionOfferAttachmentOperation {
  type: 'offer-attachment'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
  /** One-time HTTPS capability issued by the Platform attachment blob store. */
  capability: AttachmentCapability
  /** Lowercase hex SHA-256 of the retained ciphertext; Desktop verifies it before decrypting. */
  ciphertextSha256: string
  /** Exact ciphertext byte count Desktop must re-hash before decrypting. */
  byteLength: number
  /** Unix epoch milliseconds after which the capability and its blob are removed. */
  expiresAt: number
  /** File name submitted with the decrypted attachment into the Session path. */
  fileName: string
  /** Browser-declared media type retained as bounded display metadata. */
  mediaType: string
}

/** Authoritative full-text Session search delegated to the Paired Desktop Host. */
export interface CompanionSearchSessionsOperation {
  type: 'search-sessions'
  operationId: CompanionOperationId
  /** Non-blank query accepted by the Host `session.search` request contract. */
  query: string
}

/** Refresh the bounded Desktop-authoritative Session and Workspace projection. */
export interface CompanionRefreshSurfaceOperation {
  type: 'refresh-surface'
  operationId: CompanionOperationId
  /** Zero-based row offset into the complete Desktop Session list. */
  offset: number
}

/** Load one bounded Desktop-authoritative history window. */
export interface CompanionLoadHistoryOperation {
  type: 'load-history'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
  beforeSeq?: number
  maxMessages: number
}

/** Cancel the active turn of one Desktop Session. */
export interface CompanionCancelSessionOperation {
  type: 'cancel-session'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
}

/** Create a Session in one Workspace, or omit the Workspace for Ungrouped. */
export interface CompanionCreateSessionOperation {
  type: 'create-session'
  operationId: CompanionOperationId
  workspaceId?: CompanionWorkspaceId
}

/** Read exact historical image bytes after Desktop Session authorization. */
export interface CompanionReadImageOperation {
  type: 'read-image'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
  attachmentId: string
}

/** Human response to a pending Desktop-owned interaction. */
export type CompanionInteractionSettlement =
  | { kind: 'approval'; outcome: 'allowed-once' | 'rejected' }
  | {
    kind: 'question'
    answers: readonly { id: string; selected: readonly string[]; custom?: string }[]
  }
  | { kind: 'question-cancelled' }

/** Settle one exact pending interaction projected by the Paired Desktop. */
export interface CompanionSettleInteractionOperation {
  type: 'settle-interaction'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
  interactionId: CompanionInteractionId
  settlement: CompanionInteractionSettlement
}

/**
 * Stable explicit Companion attachment rejection reasons; never carry application data.
 *
 * `hash-mismatch` covers a ciphertext SHA-256 or byte-count mismatch and a post-hash
 * AES-GCM authentication failure (wrong pairing key) after the hash already matched.
 */
export type CompanionAttachmentRejectionReason =
  | 'cross-pairing'
  | 'hash-mismatch'
  | 'expired'
  | 'absent'
  | 'transfer-interrupted'
  | 'limit-exceeded'

/** Reconnect query for the Desktop-authoritative outcome of one transmitted operation. */
export interface CompanionQueryOperationStatusOperation {
  type: 'query-operation-status'
  operationId: CompanionOperationId
}

/** Operations in the implemented Companion codec slices. */
export type CompanionOperation =
  | CompanionCreateSessionOperation
  | CompanionSubmitPromptOperation
  | CompanionOfferAttachmentOperation
  | CompanionSearchSessionsOperation
  | CompanionQueryOperationStatusOperation
  | CompanionRefreshSurfaceOperation
  | CompanionLoadHistoryOperation
  | CompanionCancelSessionOperation
  | CompanionReadImageOperation
  | CompanionSettleInteractionOperation

/** Desktop-authoritative mutation result. */
export interface CompanionConfirmedResult {
  type: 'confirmed'
  operationId: CompanionOperationId
  committedAt: number
  outcome: 'accepted'
}

/** Desktop-confirmed creation of one real Host Session. */
export interface CompanionSessionCreatedResult {
  type: 'session-created'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
  committedAt: number
}

/** Explicit Desktop rejection of one offered attachment. */
export interface CompanionAttachmentRejectedResult {
  type: 'attachment-rejected'
  operationId: CompanionOperationId
  reason: CompanionAttachmentRejectionReason
}

/** One Desktop-authoritative full-text Session search hit. */
export interface CompanionSessionSearchItem {
  sessionId: CompanionSessionId
  /** Bounded plain-text excerpt returned by Desktop `session.search`. */
  snippet: string
}

/** Correlated authoritative search result from the Paired Desktop. */
export interface CompanionSessionSearchResult {
  type: 'session-search'
  operationId: CompanionOperationId
  items: readonly CompanionSessionSearchItem[]
  /** Desktop has more matching Sessions and Mobile should ask for a narrower query. */
  hasMore: boolean
}

/** Stable failure categories for one Desktop Host call. */
export type CompanionHostFailure =
  | { kind: 'http'; code: 'HOST_HTTP_STATUS'; message: string; status: number }
  | { kind: 'wire'; code: 'HOST_WIRE_INVALID'; message: string }
  | { kind: 'business'; code: string; message: string }
  | { kind: 'timeout'; code: 'HOST_TIMEOUT'; message: string }

/** Correlated Host refusal retained as application data through the encrypted channel. */
export interface CompanionOperationFailedResult {
  type: 'operation-failed'
  operationId: CompanionOperationId
  failure: CompanionHostFailure
}

/** One ordered chunk of Desktop-authorized historical image bytes. */
export interface CompanionImageChunkResult {
  type: 'image-chunk'
  operationId: CompanionOperationId
  sessionId: CompanionSessionId
  attachmentId: string
  mediaType: string
  index: number
  count: number
  /** Lowercase hexadecimal SHA-256 of the complete image. */
  sha256: string
  /** Canonical unpadded base64url bytes for this chunk. */
  data: string
}

/** Carrier receipt for a pairing-private Approval or Ask User response. */
export interface CompanionInteractionReceiptResult {
  type: 'interaction-receipt'
  operationId: CompanionOperationId
  accepted: boolean
  reason?: 'not-pending' | 'bad-response'
}

/** Terminal Desktop result retained for one idempotent Companion mutation. */
export type CompanionMutationResult =
  | CompanionConfirmedResult
  | CompanionSessionCreatedResult
  | CompanionAttachmentRejectedResult
  | CompanionOperationFailedResult
  | CompanionInteractionReceiptResult

/** Reconnect answer returning the original committed result for one operation id. */
export interface CompanionCommittedStatusResult {
  type: 'status'
  operationId: CompanionOperationId
  committed: CompanionMutationResult
}

/** Reconnect answer stating the queried operation id committed nothing. */
export interface CompanionAbsentStatusResult {
  type: 'status'
  operationId: CompanionOperationId
  absent: true
}

/** Results in the implemented Companion codec slices. */
export type CompanionResult =
  | CompanionConfirmedResult
  | CompanionSessionCreatedResult
  | CompanionAttachmentRejectedResult
  | CompanionSessionSearchResult
  | CompanionOperationFailedResult
  | CompanionImageChunkResult
  | CompanionInteractionReceiptResult
  | CompanionCommittedStatusResult
  | CompanionAbsentStatusResult

/** Bounded plain-text transcript entry approved for Mobile presentation. */
export interface CompanionTextTranscriptEntry {
  type: 'text'
  entryId: CompanionTranscriptEntryId
  role: 'user' | 'assistant'
  text: string
}

/** Approved transcript page projected by the Paired Desktop. */
export interface CompanionTranscriptPageProjection {
  type: 'transcript-page'
  sessionId: CompanionSessionId
  entries: readonly CompanionTextTranscriptEntry[]
}

/** Desktop-authoritative state marker required after each foreground IK reconnect. */
export interface CompanionForegroundSyncProjection {
  type: 'foreground-sync'
  /** Endpoint-owned Installation name authenticated by this physical channel. */
  desktopName: string
  /** Physical attachment generation bound into the IK prologue. */
  generation: number
  /** Monotonic Desktop projection revision represented by this synchronization. */
  desktopRevision: number
}

/** One bounded Session row in the Mobile Companion browse projection. */
export interface CompanionSessionSummaryProjection {
  sessionId: CompanionSessionId
  displayTitle: string
  cwd?: string
  running: boolean
  blank: boolean
  updatedAt: number
  pendingInteraction?: 'approval' | 'plan-review' | 'question'
}

/** One bounded Workspace row containing only Session ids present in this page. */
export interface CompanionWorkspaceProjection {
  workspaceId: CompanionWorkspaceId
  path: string
  title: string
  sessionIds: readonly CompanionSessionId[]
  createdAt: string
  updatedAt: string
}

/** Desktop-authoritative browse baseline correlated to one foreground refresh. */
export interface CompanionSurfaceSnapshotProjection {
  type: 'surface-snapshot'
  operationId: CompanionOperationId
  generation: number
  desktopRevision: number
  desktopName: string
  /** Zero-based offset of the first Session row in this page. */
  offset: number
  sessions: readonly CompanionSessionSummaryProjection[]
  workspaces: readonly CompanionWorkspaceProjection[]
  hasMore: boolean
}

/** JSON conversation carrier reconstructed into shared Web presentation values by Mobile. */
export interface CompanionConversationSnapshotProjection {
  type: 'conversation-snapshot'
  operationId: CompanionOperationId
  generation: number
  desktopRevision: number
  sessionId: CompanionSessionId
  /** Exclusive upper event-sequence bound for an older page; absent for an authoritative tail replacement. */
  beforeSeq?: number
  /** Merge-extensible presentation data, bounded structurally by the protocol decoder. */
  conversation: unknown
}

/** Projections in the first implemented Companion codec slice. */
export type CompanionProjection =
  | CompanionTranscriptPageProjection
  | CompanionForegroundSyncProjection
  | CompanionSurfaceSnapshotProjection
  | CompanionConversationSnapshotProjection

/** Version-tagged encrypted application plaintext before endpoint encryption. */
export type CompanionMessage =
  | { type: 'operation'; operation: CompanionOperation }
  | { type: 'projection'; projection: CompanionProjection }
  | { type: 'result'; result: CompanionResult }

/** Relay-visible ciphertext forwarding frame. */
export interface RelayCiphertextMessage {
  /** Transport-only discriminant. */
  type: 'ciphertext'
  /** Independently negotiated Relay Transport major. */
  transportVersion: 1
  /** Opaque route selected by the sender. */
  routeId: RelayRouteId
  /** Live attachment that supplied the ciphertext. */
  sourceAttachmentId: RelayAttachmentId
  /** Live attachment that should receive the ciphertext. */
  targetAttachmentId: RelayAttachmentId
  /** Application ciphertext that Relay must not interpret. */
  ciphertext: Uint8Array
}

/** Relay attachment challenge request containing only public authority. */
export interface RelayAttachChallengeRequestMessage {
  type: 'attach-challenge'
  transportVersion: 1
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  endpoint: 'mobile' | 'desktop'
  credentialPublicKey: RelayCredentialPublicKey
}

/** Platform-issued single-use challenge bound to one requested attachment tuple. */
export interface RelayAttachChallengeMessage {
  type: 'attach-challenge-response'
  transportVersion: 1
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  endpoint: 'mobile' | 'desktop'
  credentialPublicKey: RelayCredentialPublicKey
  challengeId: RelayAttachChallengeId
  nonce: Uint8Array
  expiresAt: number
}

/** Relay attachment proof for one Platform-issued challenge. */
export interface RelayAttachMessage {
  type: 'attach'
  transportVersion: 1
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  endpoint: 'mobile' | 'desktop'
  credentialPublicKey: RelayCredentialPublicKey
  challengeId: RelayAttachChallengeId
  nonce: Uint8Array
  expiresAt: number
  signature: Uint8Array
}

/** Content-free liveness frame for one Relay attachment. */
export interface RelayHeartbeatMessage {
  type: 'heartbeat'
  transportVersion: 1
  attachmentId: RelayAttachmentId
  sentAt: number
}

/** Content-free confirmation that Platform authenticated and registered one attachment. */
export interface RelayReadyMessage {
  type: 'ready'
  transportVersion: 1
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  /** Current opposite-endpoint attachments authenticated under this route. */
  peers: readonly RelayPeerDescriptor[]
}

/** Content-free replacement of the current opposite-endpoint attachment projection. */
export interface RelayPeerUpdateMessage {
  type: 'peer-update'
  transportVersion: 1
  routeId: RelayRouteId
  /** Receiving attachment whose route projection is replaced. */
  attachmentId: RelayAttachmentId
  peers: readonly RelayPeerDescriptor[]
}

/** One route-bound peer tuple whose static identity is authenticated later by Snow IK. */
export interface RelayPeerDescriptor {
  attachmentId: RelayAttachmentId
  pairingSelector: RelayPairingSelector
  generation: number
}

/** Content-free revocation frame for one Relay attachment. */
export interface RelayRevokeMessage {
  type: 'revoke'
  transportVersion: 1
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  reason: 'device' | 'all' | 'disabled'
}

/** Stable transport failures that never carry application data. */
export type RelayErrorCode =
  | 'PLATFORM_CAPACITY'
  | 'RELAY_ATTACHMENT_REJECTED'
  | 'RELAY_ROUTE_REVOKED'
  | 'RELAY_SLOW_CONSUMER'
  | 'RELAY_TRANSPORT_INCOMPATIBLE'
  | 'REMOTE_OFFLINE'

/** Relay-visible transport failure. */
export interface RelayErrorMessage {
  type: 'error'
  transportVersion: 1
  code: RelayErrorCode
  retryAfterMs?: number
}

/** Relay Transport Protocol messages accepted by the version-one codec. */
export type RelayMessage =
  | RelayAttachChallengeRequestMessage
  | RelayAttachChallengeMessage
  | RelayAttachMessage
  | RelayCiphertextMessage
  | RelayErrorMessage
  | RelayHeartbeatMessage
  | RelayPeerUpdateMessage
  | RelayReadyMessage
  | RelayRevokeMessage
