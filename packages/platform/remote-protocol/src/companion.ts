import { decodeProtocolJson, encodeProtocolJson } from './boundary.ts'
import { RemoteProtocolError } from './errors.ts'
import { parseAttachmentCapability } from './relay.ts'
import { REMOTE_PROTOCOL_LIMITS } from './limits.ts'
import type {
  CompanionAnswerAskUserOperation,
  CompanionApprovalTranscriptEntry,
  CompanionAskUserTranscriptEntry,
  CompanionImageTranscriptEntry,
  CompanionInteractionId,
  CompanionInteractionSettlement,
  CompanionMessage,
  CompanionOperation,
  CompanionOperationId,
  CompanionProjection,
  CompanionResult,
  CompanionSecurityCapability,
  CompanionSessionId,
  CompanionSettleApprovalOperation,
  CompanionTranscriptEntry,
  CompanionTranscriptEntryId,
  CompanionTextTranscriptEntry,
  CompanionVersionDescriptor,
  CompanionVersionOffer,
} from './types.ts'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_IDENTIFIER_CHARACTERS = 128

/** Security properties that both endpoints must preserve at the selected major. */
export const REQUIRED_COMPANION_SECURITY_CAPABILITIES = [
  'authenticated-encryption',
  'pairing-key-separation',
  'replay-protection',
] as const satisfies readonly CompanionSecurityCapability[]

/** Successful application-version negotiation required by Companion application codecs. */
export interface NegotiatedCompanionProtocol {
  /** Selected current or immediately preceding application major. */
  readonly major: 1 | 2
}

/** Logical endpoint connection whose latest negotiation owns one active codec capability. */
export interface CompanionNegotiationChannel {
  /** Protocol-native tag; ownership is validated against process-local state. */
  readonly type: 'companion-negotiation-channel'
}

interface CompanionNegotiationState {
  active: NegotiatedCompanionProtocol | undefined
}

const negotiationChannels = new WeakMap<object, CompanionNegotiationState>()
const protocolOwners = new WeakMap<object, CompanionNegotiationChannel>()

/**
 * Create isolated negotiation state for one logical endpoint connection.
 * @returns channel whose next negotiation invalidates only its previous codec capability.
 */
export function createCompanionNegotiationChannel(): CompanionNegotiationChannel {
  const channel = Object.freeze({ type: 'companion-negotiation-channel' as const })
  negotiationChannels.set(channel, { active: undefined })
  return channel
}

/**
 * Build an endpoint offer for the current or immediately preceding Companion major.
 * @param endpoint - endpoint sending the offer.
 * @param majors - supported majors; array order does not affect selection.
 * @returns offer whose majors retain every required security property; negotiation selects the highest safe shared major.
 */
export function createCompanionVersionOffer(
  endpoint: 'mobile' | 'desktop',
  majors: readonly (1 | 2)[] = [2, 1],
): CompanionVersionOffer {
  if (majors.length === 0 || new Set(majors).size !== majors.length) {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', 'Companion version offer majors must be non-empty and unique')
  }
  const versions = majors.map<CompanionVersionDescriptor>(major => ({
    major,
    capabilities: [...REQUIRED_COMPANION_SECURITY_CAPABILITIES],
  }))
  return { endpoint, versions }
}

/**
 * Encode application-version metadata without any application plaintext.
 * @param offer - endpoint majors and security properties.
 * @returns bounded version-offer bytes for endpoint encryption.
 */
export function encodeCompanionVersionOffer(offer: CompanionVersionOffer): Uint8Array {
  return encodeProtocolJson(offer, REMOTE_PROTOCOL_LIMITS.companionMessageBytes, 'Companion version offer')
}

/**
 * Decode bounded application-version metadata before application plaintext is admitted.
 * @param encoded - decrypted version-offer bytes from the peer.
 * @returns validated endpoint majors and security properties.
 */
export function decodeCompanionVersionOffer(encoded: Uint8Array): CompanionVersionOffer {
  const record = object(
    decodeProtocolJson(encoded, REMOTE_PROTOCOL_LIMITS.companionMessageBytes, 'Companion version offer'),
    'Companion version offer',
  )
  exactKeys(record, ['endpoint', 'versions'], 'Companion version offer')
  if (record.endpoint !== 'mobile' && record.endpoint !== 'desktop') {
    invalid('Companion version endpoint must be mobile or desktop')
  }
  if (!Array.isArray(record.versions) || record.versions.length === 0) {
    invalid('Companion version offer must contain at least one major')
  }
  const versions = record.versions.map(parseVersionDescriptor)
  if (new Set(versions.map(version => version.major)).size !== versions.length) {
    invalid('Companion version offer majors must be unique')
  }
  return { endpoint: record.endpoint, versions }
}

/**
 * Select the highest shared Companion major only after security capabilities intersect.
 * The attempt first invalidates this channel's prior capability, including when the new offers fail closed.
 * @param channel - logical endpoint connection that owns the returned capability.
 * @param mobile - Mobile endpoint offer.
 * @param desktop - Desktop endpoint offer.
 * @returns capability required to encode application plaintext.
 */
export function negotiateCompanionProtocol(
  channel: CompanionNegotiationChannel,
  mobile: CompanionVersionOffer,
  desktop: CompanionVersionOffer,
): NegotiatedCompanionProtocol {
  const state = negotiationChannels.get(channel)
  if (state === undefined) {
    throw new RemoteProtocolError('COMPANION_VERSION_NOT_NEGOTIATED', 'Companion negotiation requires a process-owned channel')
  }
  state.active = undefined
  if (mobile.endpoint !== 'mobile' || desktop.endpoint !== 'desktop') {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', 'Companion version offers use the wrong endpoints')
  }
  let unsafeEndpoint: 'mobile' | 'desktop' | undefined
  for (const major of [2, 1] as const) {
    const mobileVersion = mobile.versions.find(version => version.major === major)
    const desktopVersion = desktop.versions.find(version => version.major === major)
    if (mobileVersion === undefined || desktopVersion === undefined) continue
    if (!hasRequiredCapabilities(mobileVersion)) {
      unsafeEndpoint ??= 'mobile'
      continue
    }
    if (!hasRequiredCapabilities(desktopVersion)) {
      unsafeEndpoint ??= 'desktop'
      continue
    }
    const negotiated = Object.freeze({ major })
    state.active = negotiated
    protocolOwners.set(negotiated, channel)
    return negotiated
  }
  if (unsafeEndpoint !== undefined) {
    throw new RemoteProtocolError(
      'COMPANION_SECURITY_CAPABILITY_MISSING',
      `${capitalize(unsafeEndpoint)} must update before application data is sent`,
      unsafeEndpoint,
    )
  }
  const mobileMax = Math.max(0, ...mobile.versions.map(version => version.major))
  const desktopMax = Math.max(0, ...desktop.versions.map(version => version.major))
  const updateEndpoint = mobileMax <= desktopMax ? 'mobile' : 'desktop'
  throw new RemoteProtocolError('COMPANION_UPDATE_REQUIRED', `${capitalize(updateEndpoint)} must update before application data is sent`, updateEndpoint)
}

/**
 * Parse a Companion operation id at the encrypted wire boundary.
 * @param value - untrusted protocol-native identifier.
 * @returns branded operation identifier.
 */
export function parseCompanionOperationId(value: unknown): CompanionOperationId {
  return parseIdentifier(value, 'Companion operationId') as CompanionOperationId
}

/**
 * Parse a Companion Session projection id without importing Harness Session types.
 * @param value - untrusted protocol-native identifier.
 * @returns branded Companion Session projection identifier.
 */
export function parseCompanionSessionId(value: unknown): CompanionSessionId {
  return parseIdentifier(value, 'Companion sessionId') as CompanionSessionId
}

/**
 * Parse one transcript projection entry id at the encrypted wire boundary.
 * @param value - untrusted protocol-native identifier.
 * @returns branded transcript entry identifier.
 */
export function parseCompanionTranscriptEntryId(value: unknown): CompanionTranscriptEntryId {
  return parseIdentifier(value, 'Companion transcript entryId') as CompanionTranscriptEntryId
}

/**
 * Parse one Desktop-authorized interaction id at the encrypted wire boundary.
 * @param value - untrusted protocol-native identifier.
 * @returns branded approval or Ask User identifier.
 */
export function parseCompanionInteractionId(value: unknown): CompanionInteractionId {
  return parseIdentifier(value, 'Companion interactionId') as CompanionInteractionId
}

/**
 * Encode approved application plaintext after Companion negotiation succeeds.
 * @param protocol - successful security-preserving negotiation.
 * @param message - approved operation, projection, or result.
 * @returns bounded plaintext bytes for endpoint encryption.
 */
export function encodeCompanionMessage(
  protocol: NegotiatedCompanionProtocol,
  message: CompanionMessage,
): Uint8Array {
  requireNegotiated(protocol)
  if (message.type === 'projection'
    && message.projection.entries.length > REMOTE_PROTOCOL_LIMITS.transcriptPageEntries) {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion transcript page exceeds its entry ceiling')
  }
  const encoded = encodeProtocolJson(
    { applicationVersion: protocol.major, ...message },
    REMOTE_PROTOCOL_LIMITS.companionMessageBytes,
    'Companion message',
  )
  if (message.type === 'projection' && encoded.byteLength > REMOTE_PROTOCOL_LIMITS.transcriptPageBytes) {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion transcript page exceeds its byte ceiling')
  }
  return encoded
}

/**
 * Decode approved application plaintext after endpoint decryption and negotiation.
 * @param protocol - successful security-preserving negotiation.
 * @param encoded - bounded decrypted application bytes.
 * @returns validated approved operation, projection, or result.
 */
export function decodeCompanionMessage(
  protocol: NegotiatedCompanionProtocol,
  encoded: Uint8Array,
): CompanionMessage {
  requireNegotiated(protocol)
  const record = object(
    decodeProtocolJson(encoded, REMOTE_PROTOCOL_LIMITS.companionMessageBytes, 'Companion message'),
    'Companion message',
  )
  if (record.applicationVersion !== protocol.major) invalid('Companion applicationVersion does not match negotiation')
  switch (record.type) {
    case 'operation':
      exactKeys(record, ['applicationVersion', 'type', 'operation'], 'Companion operation message')
      return { type: 'operation', operation: parseOperation(record.operation) }
    case 'projection':
      exactKeys(record, ['applicationVersion', 'type', 'projection'], 'Companion projection message')
      if (encoded.byteLength > REMOTE_PROTOCOL_LIMITS.transcriptPageBytes) {
        throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion transcript page exceeds its byte ceiling')
      }
      return { type: 'projection', projection: parseProjection(record.projection) }
    case 'result':
      exactKeys(record, ['applicationVersion', 'type', 'result'], 'Companion result message')
      return { type: 'result', result: parseResult(record.result) }
    default:
      invalid('Companion message type is unsupported')
  }
}

function parseOperation(value: unknown): CompanionOperation {
  const record = object(value, 'Companion operation')
  if (record.type === 'offer-attachment') {
    exactKeys(
      record,
      ['type', 'operationId', 'sessionId', 'capability', 'ciphertextSha256', 'byteLength', 'expiresAt', 'fileName'],
      'Companion offer-attachment operation',
    )
    if (typeof record.ciphertextSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.ciphertextSha256)) {
      invalid('Companion attachment ciphertextSha256 must be lowercase hex SHA-256')
    }
    if (typeof record.fileName !== 'string' || record.fileName.length === 0) {
      invalid('Companion attachment fileName must be non-empty')
    }
    if (new TextEncoder().encode(record.fileName).byteLength > REMOTE_PROTOCOL_LIMITS.attachmentFileNameBytes) {
      invalid('Companion attachment fileName exceeds its byte ceiling')
    }
    const byteLength = positiveSafeInteger(record.byteLength, 'Companion attachment byteLength')
    if (byteLength > REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes) {
      throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion attachment exceeds its blob byte ceiling')
    }
    return {
      type: 'offer-attachment',
      operationId: parseCompanionOperationId(record.operationId),
      sessionId: parseCompanionSessionId(record.sessionId),
      capability: parseAttachmentCapability(record.capability),
      ciphertextSha256: record.ciphertextSha256,
      byteLength,
      expiresAt: positiveSafeInteger(record.expiresAt, 'Companion attachment expiresAt'),
      fileName: record.fileName,
    }
  }
  if (record.type === 'query-operation-status') {
    exactKeys(record, ['type', 'operationId'], 'Companion query-operation-status operation')
    return {
      type: 'query-operation-status',
      operationId: parseCompanionOperationId(record.operationId),
    }
  }
  if (record.type === 'create-session') return parseCreateSession(record)
  if (record.type === 'cancel-prompt') {
    exactKeys(record, ['type', 'operationId', 'sessionId'], 'Companion cancel-prompt operation')
    return {
      type: 'cancel-prompt',
      operationId: parseCompanionOperationId(record.operationId),
      sessionId: parseCompanionSessionId(record.sessionId),
    }
  }
  if (record.type === 'settle-approval') return parseSettleApproval(record)
  if (record.type === 'answer-ask-user') return parseAnswerAskUser(record)
  if (record.type !== 'submit-prompt') invalid('Companion operation type is unsupported')
  exactKeys(record, ['type', 'operationId', 'sessionId', 'text'], 'Companion submit-prompt operation')
  if (typeof record.text !== 'string' || record.text.length === 0) invalid('Companion prompt text must be non-empty')
  return {
    type: 'submit-prompt',
    operationId: parseCompanionOperationId(record.operationId),
    sessionId: parseCompanionSessionId(record.sessionId),
    text: record.text,
  }
}

function parseSettleApproval(record: Record<string, unknown>): CompanionSettleApprovalOperation {
  exactKeysAllowing(
    record,
    ['type', 'operationId', 'sessionId', 'interactionId', 'decision'],
    ['persistent'],
    'Companion settle-approval operation',
  )
  const decision = nonEmptyString(record.decision, 'Companion settle-approval decision')
  if (record.persistent !== undefined && typeof record.persistent !== 'boolean') {
    invalid('Companion settle-approval persistent must be a boolean')
  }
  return {
    type: 'settle-approval',
    operationId: parseCompanionOperationId(record.operationId),
    sessionId: parseCompanionSessionId(record.sessionId),
    interactionId: parseCompanionInteractionId(record.interactionId),
    decision,
    ...(record.persistent === undefined ? {} : { persistent: record.persistent }),
  }
}

function parseAnswerAskUser(record: Record<string, unknown>): CompanionAnswerAskUserOperation {
  exactKeys(record, ['type', 'operationId', 'sessionId', 'interactionId', 'decision'], 'Companion answer-ask-user operation')
  return {
    type: 'answer-ask-user',
    operationId: parseCompanionOperationId(record.operationId),
    sessionId: parseCompanionSessionId(record.sessionId),
    interactionId: parseCompanionInteractionId(record.interactionId),
    decision: nonEmptyString(record.decision, 'Companion answer-ask-user decision'),
  }
}

function parseCreateSession(record: Record<string, unknown>): CompanionOperation {
  if (record.workspace === undefined) {
    exactKeys(record, ['type', 'operationId', 'sessionId', 'title'], 'Companion create-session operation')
  } else {
    exactKeys(record, ['type', 'operationId', 'sessionId', 'title', 'workspace'], 'Companion create-session operation')
    if (typeof record.workspace !== 'string' || record.workspace.length === 0) {
      invalid('Companion create-session workspace must be a non-empty string')
    }
  }
  if (typeof record.title !== 'string' || record.title.length === 0) {
    invalid('Companion create-session title must be a non-empty string')
  }
  return {
    type: 'create-session',
    operationId: parseCompanionOperationId(record.operationId),
    sessionId: parseCompanionSessionId(record.sessionId),
    title: record.title,
    ...(record.workspace === undefined ? {} : { workspace: record.workspace }),
  }
}

function parseResult(value: unknown): CompanionResult {
  const record = object(value, 'Companion result')
  if (record.type === 'attachment-rejected') {
    exactKeys(record, ['type', 'operationId', 'reason'], 'Companion attachment-rejected result')
    if (record.reason !== 'cross-pairing' && record.reason !== 'hash-mismatch' && record.reason !== 'expired'
      && record.reason !== 'absent' && record.reason !== 'transfer-interrupted' && record.reason !== 'limit-exceeded') {
      invalid('Companion attachment rejection reason is unsupported')
    }
    return {
      type: 'attachment-rejected',
      operationId: parseCompanionOperationId(record.operationId),
      reason: record.reason,
    }
  }
  if (record.type === 'status') return parseStatusResult(record)
  if (record.type !== 'confirmed') invalid('Companion result type is unsupported')
  exactKeys(record, ['type', 'operationId', 'committedAt', 'outcome'], 'Companion confirmed result')
  if (record.outcome !== 'accepted') invalid('Companion confirmed outcome is unsupported')
  return {
    type: 'confirmed',
    operationId: parseCompanionOperationId(record.operationId),
    committedAt: positiveSafeInteger(record.committedAt, 'Companion committedAt'),
    outcome: 'accepted',
  }
}

function parseStatusResult(record: Record<string, unknown>): CompanionResult {
  const operationId = parseCompanionOperationId(record.operationId)
  if (record.committed !== undefined && record.absent !== undefined) {
    invalid('Companion status result cannot be both committed and absent')
  }
  if (record.absent !== undefined) {
    exactKeys(record, ['type', 'operationId', 'absent'], 'Companion absent status result')
    if (record.absent !== true) invalid('Companion absent status must be literal true')
    return { type: 'status', operationId, absent: true }
  }
  exactKeys(record, ['type', 'operationId', 'committed'], 'Companion committed status result')
  const confirmed = parseResult(record.committed)
  if (confirmed.type !== 'confirmed' || confirmed.operationId !== operationId) {
    invalid('Companion committed status must embed its own confirmed result')
  }
  return { type: 'status', operationId, committed: confirmed }
}

function parseProjection(value: unknown): CompanionProjection {
  const record = object(value, 'Companion projection')
  if (record.type !== 'transcript-page') invalid('Companion projection type is unsupported')
  exactKeysAllowing(record, ['type', 'sessionId', 'entries'], ['streaming'], 'Companion transcript-page projection')
  if (!Array.isArray(record.entries)) invalid('Companion transcript entries must be an array')
  if (record.entries.length > REMOTE_PROTOCOL_LIMITS.transcriptPageEntries) {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion transcript page exceeds its entry ceiling')
  }
  if (record.streaming !== undefined && record.streaming !== true && record.streaming !== false) {
    invalid('Companion transcript streaming must be a boolean')
  }
  return {
    type: 'transcript-page',
    sessionId: parseCompanionSessionId(record.sessionId),
    entries: record.entries.map(parseTranscriptEntry),
    ...(record.streaming === undefined ? {} : { streaming: record.streaming }),
  }
}

function parseTranscriptEntry(value: unknown): CompanionTranscriptEntry {
  const record = object(value, 'Companion transcript entry')
  switch (record.type) {
    case 'text':
      return parseTextTranscriptEntry(record)
    case 'image':
      return parseImageTranscriptEntry(record)
    case 'approval':
      return parseApprovalTranscriptEntry(record)
    case 'ask-user':
      return parseAskUserTranscriptEntry(record)
    default:
      invalid('Companion transcript entry type is unsupported')
  }
}

function parseTextTranscriptEntry(record: Record<string, unknown>): CompanionTextTranscriptEntry {
  exactKeys(record, ['type', 'entryId', 'role', 'text'], 'Companion text transcript entry')
  if (record.role !== 'user' && record.role !== 'assistant') invalid('Companion transcript role is unsupported')
  if (typeof record.text !== 'string') invalid('Companion transcript text must be a string')
  return {
    type: 'text',
    entryId: parseCompanionTranscriptEntryId(record.entryId),
    role: record.role,
    text: record.text,
  }
}

function parseImageTranscriptEntry(record: Record<string, unknown>): CompanionImageTranscriptEntry {
  exactKeys(record, ['type', 'entryId', 'fileName', 'alt'], 'Companion image transcript entry')
  return {
    type: 'image',
    entryId: parseCompanionTranscriptEntryId(record.entryId),
    fileName: nonEmptyString(record.fileName, 'Companion image fileName'),
    alt: nonEmptyString(record.alt, 'Companion image alt'),
  }
}

function parseApprovalTranscriptEntry(record: Record<string, unknown>): CompanionApprovalTranscriptEntry {
  exactKeysAllowing(
    record,
    ['type', 'entryId', 'interactionId', 'summary', 'authorized'],
    ['cwd', 'diff', 'terminal', 'settled'],
    'Companion approval transcript entry',
  )
  const authorized = parseAuthorizedDecisions(record.authorized, 'Companion approval authorized')
  return {
    type: 'approval',
    entryId: parseCompanionTranscriptEntryId(record.entryId),
    interactionId: parseCompanionInteractionId(record.interactionId),
    summary: nonEmptyString(record.summary, 'Companion approval summary'),
    authorized,
    ...(record.cwd === undefined ? {} : { cwd: nonEmptyString(record.cwd, 'Companion approval cwd') }),
    ...(record.diff === undefined ? {} : { diff: nonEmptyString(record.diff, 'Companion approval diff') }),
    ...(record.terminal === undefined ? {} : { terminal: nonEmptyString(record.terminal, 'Companion approval terminal') }),
    ...(record.settled === undefined ? {} : { settled: parseSettlement(record.settled, authorized) }),
  }
}

function parseAskUserTranscriptEntry(record: Record<string, unknown>): CompanionAskUserTranscriptEntry {
  exactKeysAllowing(
    record,
    ['type', 'entryId', 'interactionId', 'summary', 'authorized'],
    ['settled'],
    'Companion ask-user transcript entry',
  )
  const authorized = parseAuthorizedDecisions(record.authorized, 'Companion ask-user authorized')
  return {
    type: 'ask-user',
    entryId: parseCompanionTranscriptEntryId(record.entryId),
    interactionId: parseCompanionInteractionId(record.interactionId),
    summary: nonEmptyString(record.summary, 'Companion ask-user summary'),
    authorized,
    ...(record.settled === undefined ? {} : { settled: parseSettlement(record.settled, authorized) }),
  }
}

function parseAuthorizedDecisions(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) invalid(`${name} must be a non-empty array`)
  const authorized = value.map((decision, index) => nonEmptyString(decision, `${name}[${String(index)}]`))
  if (new Set(authorized).size !== authorized.length) invalid(`${name} must be unique`)
  return authorized
}

function parseSettlement(value: unknown, authorized: readonly string[]): CompanionInteractionSettlement {
  const record = object(value, 'Companion interaction settlement')
  exactKeysAllowing(record, ['decision'], ['persistent'], 'Companion interaction settlement')
  const decision = nonEmptyString(record.decision, 'Companion settled decision')
  if (!authorized.includes(decision)) invalid('Companion settled decision must be one of the authorized decisions')
  if (record.persistent !== undefined && typeof record.persistent !== 'boolean') {
    invalid('Companion settled persistent must be a boolean')
  }
  return {
    decision,
    ...(record.persistent === undefined ? {} : { persistent: record.persistent }),
  }
}

function hasRequiredCapabilities(version: CompanionVersionDescriptor): boolean {
  return REQUIRED_COMPANION_SECURITY_CAPABILITIES.every(capability => version.capabilities.includes(capability))
}

function parseVersionDescriptor(value: unknown): CompanionVersionDescriptor {
  const record = object(value, 'Companion version descriptor')
  exactKeys(record, ['major', 'capabilities'], 'Companion version descriptor')
  if (record.major !== 1 && record.major !== 2) invalid('Companion major must be current or immediately preceding')
  if (!Array.isArray(record.capabilities)) invalid('Companion capabilities must be an array')
  const capabilities = record.capabilities.map(parseSecurityCapability)
  if (new Set(capabilities).size !== capabilities.length) invalid('Companion security capabilities must be unique')
  return { major: record.major, capabilities }
}

function parseSecurityCapability(value: unknown): CompanionSecurityCapability {
  if (value === 'authenticated-encryption' || value === 'pairing-key-separation' || value === 'replay-protection') {
    return value
  }
  invalid('Companion security capability is unsupported')
}

function requireNegotiated(protocol: unknown): asserts protocol is NegotiatedCompanionProtocol {
  if (typeof protocol !== 'object' || protocol === null) {
    throw new RemoteProtocolError('COMPANION_VERSION_NOT_NEGOTIATED', 'Companion application data requires successful negotiation')
  }
  const owner = protocolOwners.get(protocol)
  if (owner === undefined || negotiationChannels.get(owner)?.active !== protocol) {
    throw new RemoteProtocolError('COMPANION_VERSION_NOT_NEGOTIATED', 'Companion application data requires successful negotiation')
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${name} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, keys: readonly unknown[], name: string): void {
  exactKeysAllowing(record, keys.filter((key): key is string => typeof key === 'string'), [], name)
}

function exactKeysAllowing(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record)
  if (required.some(key => !actual.includes(key))) invalid(`${name} contains unsupported fields`)
  if (actual.some(key => !required.includes(key) && !optional.includes(key))) {
    invalid(`${name} contains unsupported fields`)
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${name} must be a non-empty string`)
  return value
}

function parseIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_CHARACTERS
    || !IDENTIFIER_PATTERN.test(value)) {
    invalid(`${name} must be 1-${String(MAX_IDENTIFIER_CHARACTERS)} base64url characters`)
  }
  return value
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${name} must be a positive safe integer`)
  return value as number
}

function invalid(message: string): never {
  throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', message)
}

function capitalize(value: 'mobile' | 'desktop'): 'Mobile' | 'Desktop' {
  return value === 'mobile' ? 'Mobile' : 'Desktop'
}
