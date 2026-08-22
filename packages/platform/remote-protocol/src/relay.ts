import {
  decodeProtocolBase64Url,
  decodeProtocolJson,
  encodeProtocolBase64Url,
  encodeProtocolJson,
} from './boundary.ts'
import { RemoteProtocolError } from './errors.ts'
import { REMOTE_PROTOCOL_LIMITS } from './limits.ts'
import type {
  AttachmentCapability,
  RelayAttachChallengeId,
  RelayAttachChallengeMessage,
  RelayAttachChallengeRequestMessage,
  RelayAttachMessage,
  RelayAttachmentId,
  RelayCredential,
  RelayCredentialPublicKey,
  RelayErrorCode,
  RelayMessage,
  RelayPairingSelector,
  RelayRouteId,
} from './types.ts'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_IDENTIFIER_CHARACTERS = 128

/**
 * Parse an opaque Relay route identifier at the wire boundary.
 * @param value - untrusted route identifier.
 * @returns branded route identifier.
 */
export function parseRelayRouteId(value: unknown): RelayRouteId {
  return parseIdentifier(value, 'routeId') as RelayRouteId
}

/**
 * Parse an opaque live-attachment identifier at the wire boundary.
 * @param value - untrusted attachment identifier.
 * @returns branded attachment identifier.
 */
export function parseRelayAttachmentId(value: unknown): RelayAttachmentId {
  return parseIdentifier(value, 'attachmentId') as RelayAttachmentId
}

/**
 * Parse a non-secret Personal Pairing selector at the Relay wire boundary.
 * @param value - untrusted opaque selector.
 * @returns branded selector.
 */
export function parseRelayPairingSelector(value: unknown): RelayPairingSelector {
  return parseIdentifier(value, 'pairingSelector') as RelayPairingSelector
}

/**
 * Parse a canonical 256-bit Relay credential at the TLS wire boundary.
 * @param value - untrusted credential string.
 * @returns branded high-entropy credential.
 */
export function parseRelayCredential(value: unknown): RelayCredential {
  if (typeof value !== 'string' || value.length < 43 || value.length > 512 || !IDENTIFIER_PATTERN.test(value)) {
    invalid('Relay credential must be canonical base64url PKCS#8')
  }
  decodeProtocolBase64Url(value, 384, 'Relay credential')
  return value as RelayCredential
}

/** Parse one canonical P-256 SPKI verifier.
 * @param value - untrusted public-key encoding.
 * @returns branded canonical public key.
 */
export function parseRelayCredentialPublicKey(value: unknown): RelayCredentialPublicKey {
  if (typeof value !== 'string' || value.length < 64 || value.length > 256 || !IDENTIFIER_PATTERN.test(value)) {
    invalid('Relay credential public key must be canonical base64url SPKI')
  }
  decodeProtocolBase64Url(value, 192, 'Relay credential public key')
  return value as RelayCredentialPublicKey
}

/** Parse one opaque single-use Relay challenge id.
 * @param value - untrusted challenge identity.
 * @returns branded challenge identity.
 */
export function parseRelayAttachChallengeId(value: unknown): RelayAttachChallengeId {
  return parseIdentifier(value, 'challengeId') as RelayAttachChallengeId
}

/**
 * Derive the Relay authority-store digest from canonical credential bytes.
 * @param credential - validated canonical 256-bit credential.
 * @returns SHA-256 digest used by endpoint registration and Relay attachment authorization.
 */
export async function deriveRelayCredentialDigest(credential: RelayCredential): Promise<Uint8Array> {
  return deriveRelayCredentialPublicKeyDigest(await deriveRelayCredentialPublicKey(credential))
}

/** Generate one extractable endpoint-owned P-256 signing credential.
 * @returns canonical PKCS#8 private credential.
 */
export async function generateRelayCredential(): Promise<RelayCredential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return encodeProtocolBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))) as RelayCredential
}

/** Derive the public SPKI verifier from an endpoint private credential.
 * @param credential - endpoint-owned PKCS#8 private credential.
 * @returns canonical public SPKI verifier.
 */
export async function deriveRelayCredentialPublicKey(credential: RelayCredential): Promise<RelayCredentialPublicKey> {
  const bytes = decodeProtocolBase64Url(credential, 384, 'Relay credential')
  const privateKey = await crypto.subtle.importKey('pkcs8', ownedBuffer(bytes), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  bytes.fill(0)
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  delete jwk.d
  jwk.key_ops = ['verify']
  const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  return encodeProtocolBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey))) as RelayCredentialPublicKey
}

/** Derive the persistent authorization digest from a public verifier.
 * @param publicKey - canonical public SPKI verifier.
 * @returns SHA-256 authorization digest.
 */
export async function deriveRelayCredentialPublicKeyDigest(publicKey: RelayCredentialPublicKey): Promise<Uint8Array> {
  const bytes = decodeProtocolBase64Url(publicKey, 192, 'Relay credential public key')
  const canonical = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(canonical).set(bytes)
  try {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', canonical))
  } finally {
    bytes.fill(0)
    new Uint8Array(canonical).fill(0)
  }
}

/** Sign the exact single-use Relay attachment challenge tuple.
 * @param credential - endpoint-owned PKCS#8 private credential.
 * @param challenge - Platform-issued tuple for this physical socket.
 * @returns final non-bearer attachment proof.
 */
export async function signRelayAttachmentChallenge(
  credential: RelayCredential,
  challenge: RelayAttachChallengeMessage,
): Promise<RelayAttachMessage> {
  const bytes = decodeProtocolBase64Url(credential, 384, 'Relay credential')
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', ownedBuffer(bytes), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, privateKey, ownedBuffer(relayAttachmentProofTranscript(challenge)),
    ))
    const { type: _type, ...fields } = challenge
    return { type: 'attach', ...fields, signature }
  } finally {
    bytes.fill(0)
  }
}

/** Verify one proof against its public SPKI and exact challenge tuple.
 * @param message - final attachment proof.
 * @returns whether the signature authenticates the exact tuple.
 */
export async function verifyRelayAttachmentProof(message: RelayAttachMessage): Promise<boolean> {
  const bytes = decodeProtocolBase64Url(message.credentialPublicKey, 192, 'Relay credential public key')
  try {
    const publicKey = await crypto.subtle.importKey('spki', ownedBuffer(bytes), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey, ownedBuffer(message.signature),
      ownedBuffer(relayAttachmentProofTranscript({ ...message, type: 'attach-challenge-response' })),
    )
  } finally {
    bytes.fill(0)
  }
}

/** Compare a final proof to the challenge issued for this physical socket.
 * @param request - socket's initial public-key request.
 * @param challenge - challenge issued on that socket.
 * @param proof - final proof received on that socket.
 * @returns whether every challenge-bound field matches.
 */
export function relayAttachmentProofMatches(
  request: RelayAttachChallengeRequestMessage,
  challenge: RelayAttachChallengeMessage,
  proof: RelayAttachMessage,
): boolean {
  return request.routeId === challenge.routeId && request.routeId === proof.routeId
    && request.attachmentId === challenge.attachmentId && request.attachmentId === proof.attachmentId
    && request.endpoint === challenge.endpoint && request.endpoint === proof.endpoint
    && request.credentialPublicKey === challenge.credentialPublicKey
    && request.credentialPublicKey === proof.credentialPublicKey
    && challenge.challengeId === proof.challengeId
    && challenge.expiresAt === proof.expiresAt
    && challenge.nonce.byteLength === proof.nonce.byteLength
    && challenge.nonce.every((byte, index) => byte === proof.nonce[index])
}

function relayAttachmentProofTranscript(challenge: RelayAttachChallengeMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    domain: 'dsh-relay-attach-proof-v1', transportVersion: challenge.transportVersion,
    routeId: challenge.routeId, attachmentId: challenge.attachmentId, endpoint: challenge.endpoint,
    credentialPublicKey: challenge.credentialPublicKey, challengeId: challenge.challengeId,
    nonce: encodeProtocolBase64Url(challenge.nonce), expiresAt: challenge.expiresAt,
  }))
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

/**
 * Parse a canonical 256-bit one-time attachment capability at a wire boundary.
 * @param value - untrusted capability string.
 * @returns branded one-time blob capability.
 */
export function parseAttachmentCapability(value: unknown): AttachmentCapability {
  if (typeof value !== 'string' || value.length !== 43 || !IDENTIFIER_PATTERN.test(value)) {
    invalid('Attachment capability must be exactly 43 canonical base64url characters')
  }
  decodeProtocolBase64Url(value, 32, 'Attachment capability')
  return value as AttachmentCapability
}

/**
 * Encode one Relay Transport Protocol message without inspecting ciphertext.
 * @param message - validated transport-only message.
 * @returns UTF-8 JSON wire bytes.
 */
export function encodeRelayMessage(message: RelayMessage): Uint8Array {
  switch (message.type) {
    case 'attach-challenge':
      return encode({ ...message })
    case 'attach-challenge-response':
      return encode({ ...message, nonce: encodeProtocolBase64Url(message.nonce) })
    case 'attach':
      return encode({
        ...message,
        nonce: encodeProtocolBase64Url(message.nonce),
        signature: encodeProtocolBase64Url(message.signature),
      })
    case 'ciphertext':
      if (message.ciphertext.byteLength > REMOTE_PROTOCOL_LIMITS.ciphertextBytes) {
        throw new RemoteProtocolError('REMOTE_PROTOCOL_LIMIT_EXCEEDED', 'Relay ciphertext exceeds its byte ceiling')
      }
      return encode({ ...message, ciphertext: encodeProtocolBase64Url(message.ciphertext) })
    case 'error':
      return encode({ ...message })
    case 'heartbeat':
      return encode({ ...message })
    case 'peer-update':
      return encode({ ...message })
    case 'ready':
      return encode({ ...message })
    case 'revoke':
      return encode({ ...message })
    default:
      return assertNever(message)
  }
}

/**
 * Decode one Relay Transport Protocol message and reject application fields.
 * @param encoded - untrusted UTF-8 JSON wire bytes.
 * @returns validated transport-only message.
 */
export function decodeRelayMessage(encoded: Uint8Array): RelayMessage {
  try {
    const value = decodeProtocolJson(encoded, REMOTE_PROTOCOL_LIMITS.relayMessageBytes, 'Relay message')
    const record = object(value, 'Relay message')
    requireTransportVersion(record)
    switch (record.type) {
      case 'attach-challenge':
        exactKeys(record, ['type', 'transportVersion', 'routeId', 'attachmentId', 'endpoint', 'credentialPublicKey'], 'Relay attach challenge request')
        return {
          type: 'attach-challenge', transportVersion: 1,
          ...decodeRelayAttachIdentity(record),
        }
      case 'attach-challenge-response':
        exactKeys(record, ['type', 'transportVersion', 'routeId', 'attachmentId', 'endpoint', 'credentialPublicKey', 'challengeId', 'nonce', 'expiresAt'], 'Relay attach challenge response')
        return {
          type: 'attach-challenge-response', transportVersion: 1,
          ...decodeRelayAttachIdentity(record),
          challengeId: parseRelayAttachChallengeId(record.challengeId),
          nonce: decodeProtocolBase64Url(record.nonce, 32, 'Relay attach challenge nonce'),
          expiresAt: positiveSafeInteger(record.expiresAt, 'Relay attach challenge expiresAt'),
        }
      case 'attach':
        exactKeys(
          record,
          ['type', 'transportVersion', 'routeId', 'attachmentId', 'endpoint', 'credentialPublicKey', 'challengeId', 'nonce', 'expiresAt', 'signature'],
          'Relay attach message',
        )
        return {
          type: 'attach', transportVersion: 1,
          ...decodeRelayAttachIdentity(record),
          challengeId: parseRelayAttachChallengeId(record.challengeId),
          nonce: decodeProtocolBase64Url(record.nonce, 32, 'Relay attach challenge nonce'),
          expiresAt: positiveSafeInteger(record.expiresAt, 'Relay attach challenge expiresAt'),
          signature: decodeProtocolBase64Url(record.signature, 96, 'Relay attach signature'),
        }
      case 'ciphertext':
        exactKeys(record, ['type', 'transportVersion', 'routeId', 'sourceAttachmentId', 'targetAttachmentId', 'ciphertext'], 'Relay ciphertext message')
        return {
          type: 'ciphertext', transportVersion: 1,
          routeId: parseRelayRouteId(record.routeId),
          sourceAttachmentId: parseRelayAttachmentId(record.sourceAttachmentId),
          targetAttachmentId: parseRelayAttachmentId(record.targetAttachmentId),
          ciphertext: decodeProtocolBase64Url(
            record.ciphertext,
            REMOTE_PROTOCOL_LIMITS.ciphertextBytes,
            'Relay ciphertext',
          ),
        }
      case 'heartbeat':
        exactKeys(record, ['type', 'transportVersion', 'attachmentId', 'sentAt'], 'Relay heartbeat message')
        return {
          type: 'heartbeat', transportVersion: 1,
          attachmentId: parseRelayAttachmentId(record.attachmentId),
          sentAt: positiveSafeInteger(record.sentAt, 'Relay heartbeat sentAt'),
        }
      case 'peer-update':
        return decodePeerProjection(record, 'peer-update', 'Relay peer update')
      case 'ready':
        return decodePeerProjection(record, 'ready', 'Relay ready')
      case 'revoke':
        exactKeys(record, ['type', 'transportVersion', 'routeId', 'attachmentId', 'reason'], 'Relay revoke message')
        if (record.reason !== 'device' && record.reason !== 'all' && record.reason !== 'disabled') {
          invalid('Relay revocation reason is unsupported')
        }
        return {
          type: 'revoke', transportVersion: 1,
          routeId: parseRelayRouteId(record.routeId),
          attachmentId: parseRelayAttachmentId(record.attachmentId),
          reason: record.reason,
        }
      case 'error': {
        const keys = record.retryAfterMs === undefined
          ? ['type', 'transportVersion', 'code']
          : ['type', 'transportVersion', 'code', 'retryAfterMs']
        exactKeys(record, keys, 'Relay error message')
        if (!isRelayErrorCode(record.code)) invalid('Relay error code is unsupported')
        return {
          type: 'error', transportVersion: 1, code: record.code,
          ...(record.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: positiveSafeInteger(record.retryAfterMs, 'Relay retryAfterMs') }),
        }
      }
      default:
        invalid('Relay message type is unsupported')
    }
  } catch (error) {
    if (error instanceof RemoteProtocolError) throw error
    throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', 'Relay message is not valid protocol JSON')
  }
}

function decodeRelayAttachIdentity(record: Record<string, unknown>): {
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  endpoint: 'mobile' | 'desktop'
  credentialPublicKey: RelayCredentialPublicKey
} {
  if (record.endpoint !== 'mobile' && record.endpoint !== 'desktop') {
    invalid('Relay endpoint must be mobile or desktop')
  }
  return {
    routeId: parseRelayRouteId(record.routeId),
    attachmentId: parseRelayAttachmentId(record.attachmentId),
    endpoint: record.endpoint,
    credentialPublicKey: parseRelayCredentialPublicKey(record.credentialPublicKey),
  }
}

function decodePeerProjection(
  record: Record<string, unknown>,
  type: 'ready' | 'peer-update',
  name: string,
): Extract<RelayMessage, { type: typeof type }> {
  exactKeys(record, ['type', 'transportVersion', 'routeId', 'attachmentId', 'peers'], `${name} message`)
  if (!Array.isArray(record.peers)) invalid(`${name} peers must be an array`)
  const peers = record.peers.map((value) => {
    const peer = object(value, `${name} peer`)
    exactKeys(peer, ['attachmentId', 'pairingSelector', 'generation'], `${name} peer`)
    return {
      attachmentId: parseRelayAttachmentId(peer.attachmentId),
      pairingSelector: parseRelayPairingSelector(peer.pairingSelector),
      generation: positiveSafeInteger(peer.generation, 'Relay peer generation'),
    }
  })
  if (new Set(peers.map(peer => peer.pairingSelector)).size !== peers.length
    || new Set(peers.map(peer => peer.attachmentId)).size !== peers.length) {
    invalid(`${name} peers must have distinct selectors and attachment ids`)
  }
  return {
    type, transportVersion: 1,
    routeId: parseRelayRouteId(record.routeId),
    attachmentId: parseRelayAttachmentId(record.attachmentId),
    peers,
  }
}

/**
 * Negotiate the highest shared Relay Transport major independently from Companion versions.
 * @param localVersions - locally implemented transport majors.
 * @param remoteVersions - peer transport majors.
 * @returns the selected transport major.
 */
export function negotiateRelayTransportVersion(
  localVersions: readonly number[],
  remoteVersions: readonly number[],
): 1 {
  if (localVersions.includes(1) && remoteVersions.includes(1)) return 1
  throw new RemoteProtocolError('RELAY_TRANSPORT_INCOMPATIBLE', 'Relay Transport Protocol has no supported version overlap')
}

function parseIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_CHARACTERS
    || !IDENTIFIER_PATTERN.test(value)) {
    invalid(`${name} must be 1-${String(MAX_IDENTIFIER_CHARACTERS)} base64url characters`)
  }
  return value
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(record)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    invalid(`${name} contains unsupported fields`)
  }
}

function encode(value: Record<string, unknown>): Uint8Array {
  return encodeProtocolJson(value, REMOTE_PROTOCOL_LIMITS.relayMessageBytes, 'Relay message')
}

function requireTransportVersion(record: Record<string, unknown>): void {
  if (record.transportVersion !== 1) invalid('Relay transportVersion must be 1')
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${name} must be a positive safe integer`)
  return value as number
}

function isRelayErrorCode(value: unknown): value is RelayErrorCode {
  return value === 'PLATFORM_CAPACITY'
    || value === 'RELAY_ATTACHMENT_REJECTED'
    || value === 'RELAY_ROUTE_REVOKED'
    || value === 'RELAY_SLOW_CONSUMER'
    || value === 'RELAY_TRANSPORT_INCOMPATIBLE'
    || value === 'REMOTE_OFFLINE'
}

function invalid(message: string): never {
  throw new RemoteProtocolError('REMOTE_PROTOCOL_INVALID_MESSAGE', message)
}

function assertNever(_value: never): never {
  invalid('Relay message type is unsupported')
}
