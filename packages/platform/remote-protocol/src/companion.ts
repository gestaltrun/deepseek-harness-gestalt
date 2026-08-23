import { decodeProtocolBase64Url, decodeProtocolJson, encodeProtocolJson } from './boundary.ts'
import { RemoteProtocolError } from './errors.ts'
import { parseAttachmentCapability } from './relay.ts'
import { REMOTE_PROTOCOL_LIMITS } from './limits.ts'
import type {
  CompanionHostFailure,
  CompanionInteractionId,
  CompanionInteractionSettlement,
  CompanionMessage,
  CompanionOperation,
  CompanionOperationId,
  CompanionProjection,
  CompanionResult,
  CompanionSecurityCapability,
  CompanionSessionId,
  CompanionWorkspaceId,
  CompanionTranscriptEntryId,
  CompanionTextTranscriptEntry,
  CompanionVersionDescriptor,
  CompanionVersionOffer,
} from './types.ts'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/
const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u
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
  readonly major: 1 | 2 | 3
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
  majors: readonly (1 | 2 | 3)[] = [3, 2],
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
  for (const major of [3, 2, 1] as const) {
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
 * Parse one opaque Desktop Workspace id at the Companion wire boundary.
 * @param value - untrusted protocol-native identifier.
 * @returns branded Companion Workspace identifier.
 */
export function parseCompanionWorkspaceId(value: unknown): CompanionWorkspaceId {
  return parseIdentifier(value, 'Companion workspaceId') as CompanionWorkspaceId
}

/**
 * Parse one pairing-private pending-interaction identity.
 * @param value - untrusted protocol-native identifier.
 * @returns branded interaction identifier.
 */
export function parseCompanionInteractionId(value: unknown): CompanionInteractionId {
  return parseIdentifier(value, 'Companion interactionId') as CompanionInteractionId
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
    && message.projection.type === 'transcript-page'
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
  if (record.type === 'create-session') {
    exactKeys(
      record,
      record.workspaceId === undefined ? ['type', 'operationId'] : ['type', 'operationId', 'workspaceId'],
      'Companion create-session operation',
    )
    return {
      type: 'create-session',
      operationId: parseCompanionOperationId(record.operationId),
      ...(record.workspaceId === undefined ? {} : { workspaceId: parseCompanionWorkspaceId(record.workspaceId) }),
    }
  }
  if (record.type === 'offer-attachment') {
    exactKeys(
      record,
      ['type', 'operationId', 'sessionId', 'capability', 'ciphertextSha256', 'byteLength', 'expiresAt', 'fileName', 'mediaType'],
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
    if (typeof record.mediaType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(record.mediaType)
      || new TextEncoder().encode(record.mediaType).byteLength > REMOTE_PROTOCOL_LIMITS.attachmentMediaTypeBytes) {
      invalid('Companion attachment mediaType is invalid')
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
      mediaType: record.mediaType,
    }
  }
  if (record.type === 'search-sessions') {
    exactKeys(record, ['type', 'operationId', 'query'], 'Companion search-sessions operation')
    if (typeof record.query !== 'string' || record.query.trim() === '' || record.query.includes('\0')
      || record.query.length > REMOTE_PROTOCOL_LIMITS.sessionSearchQueryCharacters) {
      invalid('Companion Session search query must be non-blank, NUL-free, and within its character ceiling')
    }
    return {
      type: 'search-sessions',
      operationId: parseCompanionOperationId(record.operationId),
      query: record.query,
    }
  }
  if (record.type === 'query-operation-status') {
    exactKeys(record, ['type', 'operationId'], 'Companion query-operation-status operation')
    return {
      type: 'query-operation-status',
      operationId: parseCompanionOperationId(record.operationId),
    }
  }
  if (record.type === 'refresh-surface') {
    exactKeys(record, ['type', 'operationId', 'offset'], 'Companion refresh-surface operation')
    return {
      type: 'refresh-surface',
      operationId: parseCompanionOperationId(record.operationId),
      offset: nonNegativeSafeInteger(record.offset, 'Companion surface offset'),
    }
  }
  if (record.type === 'load-history') {
    exactKeys(record, record.beforeSeq === undefined
      ? ['type', 'operationId', 'sessionId', 'maxMessages']
      : ['type', 'operationId', 'sessionId', 'beforeSeq', 'maxMessages'], 'Companion load-history operation')
    const maxMessages = positiveSafeInteger(record.maxMessages, 'Companion history maxMessages')
    if (maxMessages > REMOTE_PROTOCOL_LIMITS.historyPageMessages) {
      throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion history request exceeds its message ceiling')
    }
    const beforeSeq = record.beforeSeq === undefined
      ? undefined
      : nonNegativeSafeInteger(record.beforeSeq, 'Companion history beforeSeq')
    return {
      type: 'load-history',
      operationId: parseCompanionOperationId(record.operationId),
      sessionId: parseCompanionSessionId(record.sessionId),
      ...beforeSeq === undefined ? {} : { beforeSeq },
      maxMessages,
    }
  }
  if (record.type === 'cancel-session') {
    exactKeys(record, ['type', 'operationId', 'sessionId'], 'Companion cancel-session operation')
    return {
      type: 'cancel-session',
      operationId: parseCompanionOperationId(record.operationId),
      sessionId: parseCompanionSessionId(record.sessionId),
    }
  }
  if (record.type === 'read-image') {
    exactKeys(record, ['type', 'operationId', 'sessionId', 'attachmentId'], 'Companion read-image operation')
    return {
      type: 'read-image',
      operationId: parseCompanionOperationId(record.operationId),
      sessionId: parseCompanionSessionId(record.sessionId),
      attachmentId: parseAttachmentId(record.attachmentId),
    }
  }
  if (record.type === 'settle-interaction') {
    exactKeys(record, ['type', 'operationId', 'sessionId', 'interactionId', 'settlement'], 'Companion settle-interaction operation')
    return {
      type: 'settle-interaction',
      operationId: parseCompanionOperationId(record.operationId),
      sessionId: parseCompanionSessionId(record.sessionId),
      interactionId: parseCompanionInteractionId(record.interactionId),
      settlement: parseInteractionSettlement(record.settlement),
    }
  }
  if (record.type !== 'submit-prompt') invalid('Companion operation type is unsupported')
  exactKeys(record, ['type', 'operationId', 'sessionId', 'text'], 'Companion submit-prompt operation')
  if (typeof record.text !== 'string' || record.text.trim() === ''
    || new TextEncoder().encode(record.text).byteLength > REMOTE_PROTOCOL_LIMITS.promptTextBytes) {
    invalid('Companion prompt text must be non-blank and within its byte ceiling')
  }
  return {
    type: 'submit-prompt',
    operationId: parseCompanionOperationId(record.operationId),
    sessionId: parseCompanionSessionId(record.sessionId),
    text: record.text,
  }
}

function parseResult(value: unknown): CompanionResult {
  const record = object(value, 'Companion result')
  if (record.type === 'image-chunk') {
    exactKeys(
      record,
      ['type', 'operationId', 'sessionId', 'attachmentId', 'mediaType', 'index', 'count', 'sha256', 'data'],
      'Companion image-chunk result',
    )
    const count = positiveSafeInteger(record.count, 'Companion image chunk count')
    if (count > REMOTE_PROTOCOL_LIMITS.imageChunks) {
      throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion image result exceeds its chunk ceiling')
    }
    const index = nonNegativeSafeInteger(record.index, 'Companion image chunk index')
    if (index >= count) invalid('Companion image chunk index must be less than count')
    if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.sha256)) {
      invalid('Companion image sha256 must be lowercase hexadecimal')
    }
    const mediaType = parseMediaType(record.mediaType, 'Companion image mediaType')
    decodeProtocolBase64Url(record.data, REMOTE_PROTOCOL_LIMITS.imageChunkBytes, 'Companion image chunk data')
    return {
      type: 'image-chunk',
      operationId: parseCompanionOperationId(record.operationId),
      sessionId: parseCompanionSessionId(record.sessionId),
      attachmentId: parseAttachmentId(record.attachmentId),
      mediaType,
      index,
      count,
      sha256: record.sha256,
      data: record.data as string,
    }
  }
  if (record.type === 'interaction-receipt') {
    const keys = record.accepted === true
      ? ['type', 'operationId', 'accepted']
      : ['type', 'operationId', 'accepted', 'reason']
    exactKeys(record, keys, 'Companion interaction-receipt result')
    if (record.accepted === true) {
      return { type: 'interaction-receipt', operationId: parseCompanionOperationId(record.operationId), accepted: true }
    }
    if (record.accepted !== false || (record.reason !== 'not-pending' && record.reason !== 'bad-response')) {
      invalid('Companion interaction receipt is invalid')
    }
    return {
      type: 'interaction-receipt', operationId: parseCompanionOperationId(record.operationId),
      accepted: false, reason: record.reason,
    }
  }
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
  if (record.type === 'session-search') {
    exactKeys(record, ['type', 'operationId', 'items', 'hasMore'], 'Companion session-search result')
    if (!Array.isArray(record.items) || record.items.length > REMOTE_PROTOCOL_LIMITS.sessionSearchResults) {
      invalid('Companion Session search items must be an array within its result ceiling')
    }
    if (typeof record.hasMore !== 'boolean') invalid('Companion Session search hasMore must be boolean')
    const items = record.items.map((item) => {
      const hit = object(item, 'Companion Session search item')
      exactKeys(hit, ['sessionId', 'snippet'], 'Companion Session search item')
      if (typeof hit.snippet !== 'string'
        || countUnicodeCodePoints(hit.snippet) > REMOTE_PROTOCOL_LIMITS.sessionSearchSnippetCodePoints) {
        invalid('Companion Session search snippet exceeds its code-point ceiling')
      }
      return { sessionId: parseCompanionSessionId(hit.sessionId), snippet: hit.snippet }
    })
    if (new Set(items.map(item => item.sessionId)).size !== items.length) {
      invalid('Companion Session search results must contain unique Session ids')
    }
    return {
      type: 'session-search',
      operationId: parseCompanionOperationId(record.operationId),
      items,
      hasMore: record.hasMore,
    }
  }
  if (record.type === 'operation-failed') {
    exactKeys(record, ['type', 'operationId', 'failure'], 'Companion operation-failed result')
    return {
      type: 'operation-failed',
      operationId: parseCompanionOperationId(record.operationId),
      failure: parseHostFailure(record.failure),
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

function parseHostFailure(value: unknown): CompanionHostFailure {
  const failure = object(value, 'Companion Host failure')
  if (typeof failure.message !== 'string' || failure.message.length === 0
    || new TextEncoder().encode(failure.message).byteLength > REMOTE_PROTOCOL_LIMITS.hostFailureMessageBytes) {
    invalid('Companion Host failure message must be non-empty and within its byte ceiling')
  }
  switch (failure.kind) {
    case 'http': {
      exactKeys(failure, ['kind', 'code', 'message', 'status'], 'Companion Host HTTP failure')
      if (failure.code !== 'HOST_HTTP_STATUS') invalid('Companion Host HTTP failure code is unsupported')
      if (!Number.isSafeInteger(failure.status) || (failure.status as number) < 100 || (failure.status as number) > 599) {
        invalid('Companion Host HTTP status must be from 100 through 599')
      }
      return { kind: 'http', code: 'HOST_HTTP_STATUS', message: failure.message, status: failure.status as number }
    }
    case 'wire':
      exactKeys(failure, ['kind', 'code', 'message'], 'Companion Host wire failure')
      if (failure.code !== 'HOST_WIRE_INVALID') invalid('Companion Host wire failure code is unsupported')
      return { kind: 'wire', code: 'HOST_WIRE_INVALID', message: failure.message }
    case 'business':
      exactKeys(failure, ['kind', 'code', 'message'], 'Companion Host business failure')
      return {
        kind: 'business',
        code: parseIdentifier(failure.code, 'Companion Host business failure code'),
        message: failure.message,
      }
    case 'timeout':
      exactKeys(failure, ['kind', 'code', 'message'], 'Companion Host timeout failure')
      if (failure.code !== 'HOST_TIMEOUT') invalid('Companion Host timeout failure code is unsupported')
      return { kind: 'timeout', code: 'HOST_TIMEOUT', message: failure.message }
    default:
      invalid('Companion Host failure kind is unsupported')
  }
}

function countUnicodeCodePoints(value: string): number {
  let count = 0
  for (const _codePoint of value) count++
  return count
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
  if ((confirmed.type !== 'confirmed' && confirmed.type !== 'attachment-rejected'
    && confirmed.type !== 'operation-failed' && confirmed.type !== 'interaction-receipt')
    || confirmed.operationId !== operationId) {
    invalid('Companion committed status must embed its own terminal mutation result')
  }
  return { type: 'status', operationId, committed: confirmed }
}

function parseProjection(value: unknown): CompanionProjection {
  const record = object(value, 'Companion projection')
  if (record.type === 'foreground-sync') {
    exactKeys(record, ['type', 'desktopName', 'generation', 'desktopRevision'], 'Companion foreground-sync projection')
    if (typeof record.desktopName !== 'string' || record.desktopName.trim() === '' || record.desktopName.length > 128) {
      invalid('Companion foreground-sync desktopName must contain 1-128 characters')
    }
    return {
      type: 'foreground-sync',
      desktopName: record.desktopName,
      generation: positiveSafeInteger(record.generation, 'Companion foreground-sync generation'),
      desktopRevision: positiveSafeInteger(record.desktopRevision, 'Companion foreground-sync desktopRevision'),
    }
  }
  if (record.type === 'surface-snapshot') return parseSurfaceSnapshot(record)
  if (record.type === 'conversation-snapshot') {
    exactKeys(
      record,
      record.beforeSeq === undefined
        ? ['type', 'operationId', 'generation', 'desktopRevision', 'sessionId', 'conversation']
        : ['type', 'operationId', 'generation', 'desktopRevision', 'sessionId', 'beforeSeq', 'conversation'],
      'Companion conversation-snapshot projection',
    )
    return {
      type: 'conversation-snapshot',
      operationId: parseCompanionOperationId(record.operationId),
      generation: positiveSafeInteger(record.generation, 'Companion conversation generation'),
      desktopRevision: positiveSafeInteger(record.desktopRevision, 'Companion conversation desktopRevision'),
      sessionId: parseCompanionSessionId(record.sessionId),
      ...(record.beforeSeq === undefined ? {} : {
        beforeSeq: nonNegativeSafeInteger(record.beforeSeq, 'Companion conversation beforeSeq'),
      }),
      conversation: record.conversation,
    }
  }
  if (record.type !== 'transcript-page') invalid('Companion projection type is unsupported')
  exactKeys(record, ['type', 'sessionId', 'entries'], 'Companion transcript-page projection')
  if (!Array.isArray(record.entries)) invalid('Companion transcript entries must be an array')
  if (record.entries.length > REMOTE_PROTOCOL_LIMITS.transcriptPageEntries) {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion transcript page exceeds its entry ceiling')
  }
  return {
    type: 'transcript-page',
    sessionId: parseCompanionSessionId(record.sessionId),
    entries: record.entries.map(parseTranscriptEntry),
  }
}

function parseTranscriptEntry(value: unknown): CompanionTextTranscriptEntry {
  const record = object(value, 'Companion transcript entry')
  if (record.type !== 'text') invalid('Companion transcript entry type is unsupported')
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

function parseInteractionSettlement(value: unknown): CompanionInteractionSettlement {
  const settlement = object(value, 'Companion interaction settlement')
  if (settlement.kind === 'approval') {
    exactKeys(settlement, ['kind', 'outcome'], 'Companion Approval settlement')
    if (settlement.outcome !== 'allowed-once' && settlement.outcome !== 'rejected') {
      invalid('Companion Approval outcome is unsupported')
    }
    return { kind: 'approval', outcome: settlement.outcome }
  }
  if (settlement.kind === 'question-cancelled') {
    exactKeys(settlement, ['kind'], 'Companion Ask User cancellation')
    return { kind: 'question-cancelled' }
  }
  if (settlement.kind !== 'question') invalid('Companion interaction settlement kind is unsupported')
  exactKeys(settlement, ['kind', 'answers'], 'Companion Ask User settlement')
  if (!Array.isArray(settlement.answers) || settlement.answers.length === 0
    || settlement.answers.length > REMOTE_PROTOCOL_LIMITS.interactionQuestions) {
    invalid('Companion Ask User answers must be a non-empty bounded array')
  }
  const ids = new Set<string>()
  const answers = settlement.answers.map((valueAnswer) => {
    const answer = object(valueAnswer, 'Companion Ask User answer')
    const keys = answer.custom === undefined ? ['id', 'selected'] : ['id', 'selected', 'custom']
    exactKeys(answer, keys, 'Companion Ask User answer')
    const id = parseInteractionString(answer.id, 'Companion Ask User answer id')
    if (ids.has(id)) invalid('Companion Ask User answer ids must be unique')
    ids.add(id)
    if (!Array.isArray(answer.selected) || answer.selected.length > REMOTE_PROTOCOL_LIMITS.interactionSelections) {
      invalid('Companion Ask User selections exceed their item ceiling')
    }
    const selected = answer.selected.map(selection =>
      parseInteractionString(selection, 'Companion Ask User selected label'))
    if (new Set(selected).size !== selected.length) invalid('Companion Ask User selected labels must be unique')
    const custom = answer.custom === undefined
      ? undefined
      : parseInteractionString(answer.custom, 'Companion Ask User custom answer')
    return { id, selected, ...custom === undefined ? {} : { custom } }
  })
  return { kind: 'question', answers }
}

function parseSurfaceSnapshot(record: Record<string, unknown>): CompanionProjection {
  exactKeys(
    record,
    ['type', 'operationId', 'generation', 'desktopRevision', 'desktopName', 'offset', 'sessions', 'workspaces', 'hasMore'],
    'Companion surface-snapshot projection',
  )
  if (typeof record.desktopName !== 'string' || record.desktopName.trim() === '' || record.desktopName.length > 128) {
    invalid('Companion surface desktopName must contain 1-128 characters')
  }
  if (!Array.isArray(record.sessions) || record.sessions.length > REMOTE_PROTOCOL_LIMITS.surfaceSessionRows) {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion surface exceeds its Session row ceiling')
  }
  if (!Array.isArray(record.workspaces) || record.workspaces.length > REMOTE_PROTOCOL_LIMITS.surfaceWorkspaceRows) {
    throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Companion surface exceeds its Workspace row ceiling')
  }
  if (typeof record.hasMore !== 'boolean') invalid('Companion surface hasMore must be boolean')
  const sessions = record.sessions.map((valueSession) => {
    const session = object(valueSession, 'Companion Session summary')
    const keys = [
      'sessionId', 'displayTitle', 'cwd', 'running', 'blank', 'updatedAt', 'pendingInteraction',
    ].filter(key => session[key] !== undefined)
    exactKeys(session, keys, 'Companion Session summary')
    if (typeof session.displayTitle !== 'string' || session.displayTitle.trim() === '') {
      invalid('Companion Session displayTitle must be non-blank')
    }
    if (session.cwd !== undefined && typeof session.cwd !== 'string') invalid('Companion Session cwd must be a string')
    if (typeof session.running !== 'boolean' || typeof session.blank !== 'boolean') {
      invalid('Companion Session running and blank must be boolean')
    }
    const pendingInteraction = parsePendingInteraction(session.pendingInteraction)
    return {
      sessionId: parseCompanionSessionId(session.sessionId),
      displayTitle: session.displayTitle,
      ...session.cwd === undefined ? {} : { cwd: session.cwd },
      running: session.running,
      blank: session.blank,
      updatedAt: nonNegativeSafeInteger(session.updatedAt, 'Companion Session updatedAt'),
      ...pendingInteraction === undefined ? {} : {
        pendingInteraction,
      },
    }
  })
  if (new Set(sessions.map(session => session.sessionId)).size !== sessions.length) {
    invalid('Companion surface Session ids must be unique')
  }
  const visibleIds = new Set(sessions.map(session => session.sessionId))
  const workspaces = record.workspaces.map((valueWorkspace) => {
    const workspace = object(valueWorkspace, 'Companion Workspace projection')
    exactKeys(
      workspace,
      ['workspaceId', 'path', 'title', 'sessionIds', 'createdAt', 'updatedAt'],
      'Companion Workspace projection',
    )
    const workspaceId = parseCompanionWorkspaceId(workspace.workspaceId)
    for (const key of ['path', 'title', 'createdAt', 'updatedAt'] as const) {
      if (typeof workspace[key] !== 'string' || workspace[key].length === 0) {
        invalid(`Companion Workspace ${key} must be non-empty`)
      }
    }
    if (!Array.isArray(workspace.sessionIds) || workspace.sessionIds.length > REMOTE_PROTOCOL_LIMITS.surfaceSessionRows) {
      invalid('Companion Workspace sessionIds exceed the current surface page')
    }
    const sessionIds = workspace.sessionIds.map(parseCompanionSessionId)
    if (new Set(sessionIds).size !== sessionIds.length || sessionIds.some(id => !visibleIds.has(id))) {
      invalid('Companion Workspace sessionIds must be unique ids from the current surface page')
    }
    return {
      workspaceId,
      path: workspace.path as string,
      title: workspace.title as string,
      sessionIds,
      createdAt: workspace.createdAt as string,
      updatedAt: workspace.updatedAt as string,
    }
  })
  return {
    type: 'surface-snapshot',
    operationId: parseCompanionOperationId(record.operationId),
    generation: positiveSafeInteger(record.generation, 'Companion surface generation'),
    desktopRevision: positiveSafeInteger(record.desktopRevision, 'Companion surface desktopRevision'),
    desktopName: record.desktopName,
    offset: nonNegativeSafeInteger(record.offset, 'Companion surface offset'),
    sessions,
    workspaces,
    hasMore: record.hasMore,
  }
}

function parsePendingInteraction(value: unknown): 'approval' | 'plan-review' | 'question' | undefined {
  if (value === undefined || value === 'approval' || value === 'plan-review' || value === 'question') return value
  return invalid('Companion Session pendingInteraction is unsupported')
}

function parseMediaType(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)
    || new TextEncoder().encode(value).byteLength > REMOTE_PROTOCOL_LIMITS.attachmentMediaTypeBytes) {
    invalid(`${name} is invalid`)
  }
  return value
}

function parseInteractionString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0
    || new TextEncoder().encode(value).byteLength > REMOTE_PROTOCOL_LIMITS.interactionStringBytes) {
    invalid(`${name} must be non-empty and within its byte ceiling`)
  }
  return value
}

function hasRequiredCapabilities(version: CompanionVersionDescriptor): boolean {
  return REQUIRED_COMPANION_SECURITY_CAPABILITIES.every(capability => version.capabilities.includes(capability))
}

function parseVersionDescriptor(value: unknown): CompanionVersionDescriptor {
  const record = object(value, 'Companion version descriptor')
  exactKeys(record, ['major', 'capabilities'], 'Companion version descriptor')
  if (record.major !== 1 && record.major !== 2 && record.major !== 3) invalid('Companion major must be supported')
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
  const supported = keys.filter((key): key is string => typeof key === 'string')
  const actual = Object.keys(record)
  if (actual.length !== supported.length || actual.some(key => !supported.includes(key))) {
    invalid(`${name} contains unsupported fields`)
  }
}

function parseIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_CHARACTERS
    || !IDENTIFIER_PATTERN.test(value)) {
    invalid(`${name} must be 1-${String(MAX_IDENTIFIER_CHARACTERS)} base64url characters`)
  }
  return value
}

function parseAttachmentId(value: unknown): string {
  if (typeof value !== 'string' || !ATTACHMENT_ID_PATTERN.test(value)) {
    invalid('Companion image attachmentId must be a content-addressed sha256 identifier')
  }
  return value
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${name} must be a positive safe integer`)
  return value as number
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${name} must be a non-negative safe integer`)
  return value as number
}

function invalid(message: string): never {
  throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', message)
}

function capitalize(value: 'mobile' | 'desktop'): 'Mobile' | 'Desktop' {
  return value === 'mobile' ? 'Mobile' : 'Desktop'
}
