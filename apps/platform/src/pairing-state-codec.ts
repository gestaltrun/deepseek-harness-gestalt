/** JSON encoding for shared Personal Pairing transaction state. */

import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  PERSONAL_PAIRING_PROTOCOL_MAJOR,
  parseDevicePrincipalId,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parsePersonalPairingKeyReference,
  type ChallengeOutcome,
  type ChallengeRecord,
  type CleanupRecord,
  type CompletionReplayRecord,
  type OrphanPendingCleanupRecord,
  type PendingOutcome,
  type PendingPairingRecord,
  type PersonalPairingTransactionState,
  type PersonalPairingView,
  type SettledChallengeRecord,
  type SettledPendingRecord,
  type StoredPersonalPairing,
} from '@deepseek-ai/dsh-remote-access'
import type { RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'

const CHALLENGE_OUTCOMES = new Set<ChallengeOutcome>([
  'cancelled', 'expired', 'completed', 'account-mismatch', 'disabled', 'disposed',
])
const PENDING_OUTCOMES = new Set<PendingOutcome>([
  'confirmed', 'rejected', 'disabled', 'collision', 'disposed',
])

/** Empty exclusive pairing-transaction document. */
export function emptyPairingTransactionState(): PersonalPairingTransactionState {
  return {
    challenges: new Map(),
    settledChallenges: new Map(),
    completions: new Map(),
    pending: new Map(),
    settledPending: new Map(),
    pairings: new Map(),
    principalIds: new Set(),
    orphanPendingCleanups: new Map(),
    accountChallengeAt: new Map(),
    ipChallengeAt: new Map(),
    blobs: new Map(),
    blobUploads: new Map(),
    blobSequence: { next: 0 },
  }
}

/**
 * Encode one exclusive pairing-transaction document as JSON-safe data.
 * @param state - in-memory Maps mutated under the store lease.
 * @returns JSON-serializable document.
 */
export function encodePairingTransactionState(state: PersonalPairingTransactionState): unknown {
  return {
    challenges: [...state.challenges].map(([id, record]) => [id, encodeChallenge(record)]),
    settledChallenges: [...state.settledChallenges].map(([id, record]) => [id, encodeSettledChallenge(record)]),
    completions: [...state.completions].map(([id, record]) => [id, encodeCompletion(record)]),
    pending: [...state.pending].map(([id, record]) => [id, encodePending(record)]),
    settledPending: [...state.settledPending].map(([id, record]) => [id, encodeSettledPending(record)]),
    pairings: [...state.pairings].map(([id, record]) => [id, encodeStoredPairing(record)]),
    principalIds: [...state.principalIds],
    orphanPendingCleanups: [...state.orphanPendingCleanups.values()].map(record => encodeOrphan(record)),
    accountChallengeAt: [...state.accountChallengeAt],
    ipChallengeAt: [...state.ipChallengeAt],
    blobs: [...state.blobs],
    blobUploads: [...state.blobUploads],
    blobSequence: { next: state.blobSequence.next },
  }
}

/**
 * Decode one exclusive pairing-transaction document after a durable read.
 * @param value - JSON or jsonb document.
 * @returns Maps ready for in-lease mutation.
 */
export function decodePairingTransactionState(value: unknown): PersonalPairingTransactionState {
  if (value === null || value === undefined) return emptyPairingTransactionState()
  const record = asRecord(value, 'pairing transaction state')
  const orphans = new Map<CleanupRecord<Uint8Array>, OrphanPendingCleanupRecord>()
  for (const encoded of asArray(record.orphanPendingCleanups, 'orphanPendingCleanups')) {
    const orphan = decodeOrphan(encoded)
    orphans.set(orphan.cleanup, orphan)
  }
  return {
    challenges: decodeMap(record.challenges, 'challenges', parsePairingChallengeId, decodeChallenge),
    settledChallenges: decodeMap(
      record.settledChallenges, 'settledChallenges', parsePairingChallengeId, decodeSettledChallenge,
    ),
    completions: decodeMap(record.completions, 'completions', parsePairingCompletionId, decodeCompletion),
    pending: decodeMap(record.pending, 'pending', parsePendingPairingId, decodePending),
    settledPending: decodeMap(record.settledPending, 'settledPending', parsePendingPairingId, decodeSettledPending),
    pairings: decodeMap(record.pairings, 'pairings', parsePersonalPairingId, decodeStoredPairing),
    principalIds: new Set(asArray(record.principalIds, 'principalIds').map(parseDevicePrincipalId)),
    orphanPendingCleanups: orphans,
    accountChallengeAt: decodeNumberListMap(record.accountChallengeAt, 'accountChallengeAt'),
    ipChallengeAt: decodeNumberListMap(record.ipChallengeAt, 'ipChallengeAt'),
    blobs: decodeMap(record.blobs, 'blobs', asPlainString, decodeBlob),
    blobUploads: decodeMap(record.blobUploads, 'blobUploads', asPlainString, decodeBlobUploads),
    blobSequence: { next: asSafeInteger(asRecord(record.blobSequence, 'blobSequence').next, 'blobSequence.next') },
  }
}

function encodeChallenge(record: ChallengeRecord): unknown {
  return {
    invitation: encodeInvitation(record.invitation),
    accountId: record.accountId,
    desktopInstallationId: record.desktopInstallationId,
    cleanup: encodeCleanup(record.cleanup),
  }
}

function decodeChallenge(value: unknown): ChallengeRecord {
  const record = asRecord(value, 'challenge')
  return {
    invitation: decodeInvitation(record.invitation),
    accountId: asPlainString(record.accountId, 'challenge.accountId'),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    cleanup: decodeCleanup(record.cleanup),
  }
}

function encodeSettledChallenge(record: SettledChallengeRecord): unknown {
  return {
    accountId: record.accountId,
    desktopInstallationId: record.desktopInstallationId,
    outcome: record.outcome,
    cleanup: encodeCleanup(record.cleanup),
    settledAt: record.settledAt,
  }
}

function decodeSettledChallenge(value: unknown): SettledChallengeRecord {
  const record = asRecord(value, 'settled challenge')
  const outcome = asPlainString(record.outcome, 'settled challenge outcome')
  if (!CHALLENGE_OUTCOMES.has(outcome as ChallengeOutcome)) {
    throw new TypeError('pairing transaction settled challenge outcome is invalid')
  }
  return {
    accountId: asPlainString(record.accountId, 'settled challenge accountId'),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    outcome: outcome as ChallengeOutcome,
    cleanup: decodeCleanup(record.cleanup),
    settledAt: asSafeInteger(record.settledAt, 'settled challenge settledAt'),
  }
}

function encodeCompletion(record: CompletionReplayRecord): unknown {
  return {
    accountId: record.accountId,
    desktopInstallationId: record.desktopInstallationId,
    mobileInstallationId: record.mobileInstallationId,
    challengeId: record.challengeId,
    requestDigest: encodeBytes(record.requestDigest),
    challengeCleanup: encodeCleanup(record.challengeCleanup),
    view: encodeCompletionView(record.view),
    completedAt: record.completedAt,
  }
}

function decodeCompletion(value: unknown): CompletionReplayRecord {
  const record = asRecord(value, 'completion')
  return {
    accountId: asPlainString(record.accountId, 'completion.accountId'),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    mobileInstallationId: parseInstallationId(record.mobileInstallationId),
    challengeId: parsePairingChallengeId(record.challengeId),
    requestDigest: decodeDigest(record.requestDigest, 'completion.requestDigest'),
    challengeCleanup: decodeCleanup(record.challengeCleanup),
    view: decodeCompletionView(record.view),
    completedAt: asSafeInteger(record.completedAt, 'completion.completedAt'),
  }
}

function encodePending(record: PendingPairingRecord): unknown {
  return {
    ...encodeCompletion(record) as Record<string, unknown>,
    cleanup: encodeCleanup(record.cleanup),
    ...(record.activationCleanup === undefined ? {} : { activationCleanup: encodeCleanup(record.activationCleanup) }),
  }
}

function decodePending(value: unknown): PendingPairingRecord {
  const record = asRecord(value, 'pending pairing')
  return {
    ...decodeCompletion(record),
    cleanup: decodeCleanup(record.cleanup),
    ...(record.activationCleanup === undefined ? {} : { activationCleanup: decodeCleanup(record.activationCleanup) }),
  }
}

function encodeSettledPending(record: SettledPendingRecord): unknown {
  return {
    accountId: record.accountId,
    desktopInstallationId: record.desktopInstallationId,
    mobileInstallationId: record.mobileInstallationId,
    outcome: record.outcome,
    cleanup: encodeCleanup(record.cleanup),
    ...(record.activeCleanup === undefined ? {} : { activeCleanup: encodeCleanup(record.activeCleanup) }),
    ...(record.view === undefined ? {} : { view: encodePairingView(record.view) }),
    settledAt: record.settledAt,
  }
}

function decodeSettledPending(value: unknown): SettledPendingRecord {
  const record = asRecord(value, 'settled pending')
  const outcome = asPlainString(record.outcome, 'settled pending outcome')
  if (!PENDING_OUTCOMES.has(outcome as PendingOutcome)) {
    throw new TypeError('pairing transaction settled pending outcome is invalid')
  }
  return {
    accountId: asPlainString(record.accountId, 'settled pending accountId'),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    mobileInstallationId: parseInstallationId(record.mobileInstallationId),
    outcome: outcome as PendingOutcome,
    cleanup: decodeCleanup(record.cleanup),
    ...(record.activeCleanup === undefined ? {} : { activeCleanup: decodeCleanup(record.activeCleanup) }),
    ...(record.view === undefined ? {} : { view: decodePairingView(record.view) }),
    settledAt: asSafeInteger(record.settledAt, 'settled pending settledAt'),
  }
}

function encodeStoredPairing(record: StoredPersonalPairing): unknown {
  return {
    ...encodePairingView(record) as Record<string, unknown>,
    desktopInstallationId: record.desktopInstallationId,
    keyReference: record.keyReference,
    cleanup: encodeCleanup(record.cleanup),
    ...(record.mobileGrant === undefined ? {} : { mobileGrant: encodeGrant(record.mobileGrant) }),
  }
}

function decodeStoredPairing(value: unknown): StoredPersonalPairing {
  const record = asRecord(value, 'stored pairing')
  return {
    ...decodePairingView(record),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    keyReference: parsePersonalPairingKeyReference(record.keyReference),
    cleanup: decodeCleanup(record.cleanup),
    ...(record.mobileGrant === undefined ? {} : { mobileGrant: decodeGrant(record.mobileGrant) }),
  }
}

function encodeOrphan(record: OrphanPendingCleanupRecord): unknown {
  return {
    accountId: record.accountId,
    desktopInstallationId: record.desktopInstallationId,
    mobileInstallationId: record.mobileInstallationId,
    cleanup: encodeCleanup(record.cleanup),
  }
}

function decodeOrphan(value: unknown): OrphanPendingCleanupRecord {
  const record = asRecord(value, 'orphan pending cleanup')
  const cleanup = decodeCleanup(record.cleanup)
  return {
    accountId: asPlainString(record.accountId, 'orphan.accountId'),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    mobileInstallationId: parseInstallationId(record.mobileInstallationId),
    cleanup,
  }
}

function encodeInvitation(invitation: ChallengeRecord['invitation']): unknown {
  return {
    challengeId: invitation.challengeId,
    invitationSecret: encodeBytes(invitation.invitationSecret),
    desktopFingerprint: invitation.desktopFingerprint,
    rendezvousId: invitation.rendezvousId,
    expiresAt: invitation.expiresAt,
    protocolMajor: invitation.protocolMajor,
  }
}

function decodeInvitation(value: unknown): ChallengeRecord['invitation'] {
  const record = asRecord(value, 'invitation')
  const protocolMajor = asSafeInteger(record.protocolMajor, 'invitation.protocolMajor')
  if (protocolMajor !== PERSONAL_PAIRING_PROTOCOL_MAJOR) {
    throw new TypeError('pairing invitation protocol major is unsupported')
  }
  return {
    challengeId: parsePairingChallengeId(record.challengeId),
    invitationSecret: decodeBytes(record.invitationSecret, 'invitationSecret'),
    desktopFingerprint: asPlainString(record.desktopFingerprint, 'desktopFingerprint'),
    rendezvousId: parsePairingRendezvousId(record.rendezvousId),
    expiresAt: asSafeInteger(record.expiresAt, 'invitation.expiresAt'),
    protocolMajor: PERSONAL_PAIRING_PROTOCOL_MAJOR,
  }
}

function encodeCompletionView(view: CompletionReplayRecord['view']): unknown {
  return {
    pendingPairingId: view.pendingPairingId,
    authenticationWords: [...view.authenticationWords],
    desktopHandshake: encodeBytes(view.desktopHandshake),
    device: view.device,
  }
}

function decodeCompletionView(value: unknown): CompletionReplayRecord['view'] {
  const record = asRecord(value, 'completion view')
  const words = asArray(record.authenticationWords, 'authenticationWords')
  if (words.length !== 6 || words.some(word => typeof word !== 'string' || word === '')) {
    throw new TypeError('pairing completion authentication words are invalid')
  }
  return {
    pendingPairingId: parsePendingPairingId(record.pendingPairingId),
    authenticationWords: words as unknown as CompletionReplayRecord['view']['authenticationWords'],
    desktopHandshake: decodeBytes(record.desktopHandshake, 'desktopHandshake'),
    device: decodeDevice(record.device),
  }
}

function encodePairingView(view: PersonalPairingView): unknown {
  return {
    id: view.id,
    devicePrincipal: view.devicePrincipal,
    device: view.device,
    pairedAt: view.pairedAt,
    lastAccessAt: view.lastAccessAt,
    online: view.online,
  }
}

function decodePairingView(value: unknown): PersonalPairingView {
  const record = asRecord(value, 'pairing view')
  const principal = asRecord(record.devicePrincipal, 'devicePrincipal')
  if (principal.authority !== 'companion-surface') {
    throw new TypeError('pairing device principal authority is invalid')
  }
  return {
    id: parsePersonalPairingId(record.id),
    devicePrincipal: {
      id: parseDevicePrincipalId(principal.id),
      accountId: parsePlatformAccountId(principal.accountId),
      installationId: parseInstallationId(principal.installationId),
      authority: 'companion-surface',
    },
    device: decodeDevice(record.device),
    pairedAt: asSafeInteger(record.pairedAt, 'pairedAt'),
    lastAccessAt: asSafeInteger(record.lastAccessAt, 'lastAccessAt'),
    online: record.online === true,
  }
}

function decodeDevice(value: unknown): CompletionReplayRecord['view']['device'] {
  const record = asRecord(value, 'pairing device')
  if (record.platform !== 'ios' && record.platform !== 'android') {
    throw new TypeError('pairing device platform must be ios or android')
  }
  return {
    name: asPlainString(record.name, 'pairing device name'),
    platform: record.platform,
  }
}

function encodeGrant(grant: RelayCredentialGrant): unknown {
  return {
    routeId: grant.routeId,
    endpoint: grant.endpoint,
    credential: grant.credential,
    revision: grant.revision,
  }
}

function decodeGrant(value: unknown): RelayCredentialGrant {
  const record = asRecord(value, 'relay grant')
  if (record.endpoint !== 'mobile' && record.endpoint !== 'desktop') {
    throw new TypeError('relay grant endpoint is invalid')
  }
  return {
    routeId: parseRelayRouteId(record.routeId),
    endpoint: record.endpoint,
    credential: parseRelayCredential(record.credential),
    revision: asSafeInteger(record.revision, 'relay grant revision'),
  }
}

function decodeBlob(value: unknown): { accountId: string; bytes: number } {
  const record = asRecord(value, 'blob reservation')
  return {
    accountId: asPlainString(record.accountId, 'blob.accountId'),
    bytes: asSafeInteger(record.bytes, 'blob.bytes'),
  }
}

function decodeBlobUploads(value: unknown): Array<{ at: number; bytes: number }> {
  return asArray(value, 'blob uploads').map((entry, index) => {
    const record = asRecord(entry, `blobUploads[${String(index)}]`)
    return {
      at: asSafeInteger(record.at, 'blob upload at'),
      bytes: asSafeInteger(record.bytes, 'blob upload bytes'),
    }
  })
}

function encodeCleanup(cleanup: CleanupRecord<Uint8Array>): unknown {
  return cleanup.resource === undefined ? {} : { resource: encodeBytes(cleanup.resource) }
}

function decodeCleanup(value: unknown): CleanupRecord<Uint8Array> {
  const record = asRecord(value, 'cleanup')
  return record.resource === undefined ? {} : { resource: decodeBytes(record.resource, 'cleanup.resource') }
}

function encodeBytes(bytes: Uint8Array): unknown {
  return { $b: Buffer.from(bytes).toString('base64url') }
}

function decodeBytes(value: unknown, name: string): Uint8Array {
  const record = asRecord(value, name)
  const encoded = record.$b
  if (typeof encoded !== 'string' || encoded === '') throw new TypeError(`${name} must be tagged bytes`)
  return Uint8Array.from(Buffer.from(encoded, 'base64url'))
}

function decodeDigest(value: unknown, name: string): Uint8Array {
  const digest = decodeBytes(value, name)
  if (digest.byteLength !== 32) throw new TypeError(`${name} must contain 32 bytes`)
  return digest
}

function decodeMap<K, V>(
  value: unknown,
  name: string,
  parseKey: (key: unknown, field: string) => K,
  parseValue: (entry: unknown) => V,
): Map<K, V> {
  const map = new Map<K, V>()
  for (const entry of asArray(value, name)) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError(`${name} entries must be pairs`)
    map.set(parseKey(entry[0], `${name} key`), parseValue(entry[1]))
  }
  return map
}

function decodeNumberListMap(value: unknown, name: string): Map<string, number[]> {
  return decodeMap(value, name, asPlainString, (entry) => {
    return asArray(entry, name).map((item, index) => asSafeInteger(item, `${name}[${String(index)}]`))
  })
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
  return value
}

function asPlainString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function asSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`)
  }
  return value
}
