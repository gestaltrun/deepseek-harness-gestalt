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
  type EndpointOwnedPairingMailboxState,
  type EndpointPairingPublication,
  type EndpointPairingRevocation,
  type OrphanPendingCleanupRecord,
  type PendingOutcome,
  type PendingPairingRecord,
  type PersonalPairingTransactionState,
  type PersonalPairingView,
  type SettledChallengeRecord,
  type SettledPendingRecord,
  type StoredPersonalPairing,
} from '@deepseek-ai/dsh-remote-access'
import {
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

const CHALLENGE_OUTCOMES = new Set<ChallengeOutcome>([
  'cancelled', 'expired', 'completed', 'account-mismatch', 'disabled', 'disposed',
])
const PENDING_OUTCOMES = new Set<PendingOutcome>([
  'confirmed', 'rejected', 'disabled', 'collision', 'disposed',
])

/** Empty exclusive pairing-transaction document. */
export function emptyPairingTransactionState(): PersonalPairingTransactionState {
  return {
    endpointMailbox: { challenges: [], pending: [] },
    endpointPublications: new Map(),
    endpointPublicationRevocations: new Map(),
    endpointAccessGenerations: new Map(),
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
    endpointMailbox: encodeEndpointMailbox(state.endpointMailbox),
    endpointPublications: [...state.endpointPublications].map(([id, publication]) => [id, encodeEndpointPublication(publication)]),
    endpointPublicationRevocations: [...state.endpointPublicationRevocations]
      .map(([id, revocation]) => [id, encodeEndpointRevocation(revocation)]),
    endpointAccessGenerations: [...state.endpointAccessGenerations],
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
    endpointMailbox: decodeEndpointMailbox(record.endpointMailbox),
    endpointPublications: decodeMap(
      record.endpointPublications, 'endpointPublications', parsePendingPairingId, decodeEndpointPublication,
    ),
    endpointPublicationRevocations: decodeMap(
      record.endpointPublicationRevocations, 'endpointPublicationRevocations',
      parsePendingPairingId, decodeEndpointRevocation,
    ),
    endpointAccessGenerations: decodeEndpointAccessGenerations(record.endpointAccessGenerations),
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

function encodeEndpointPublication(publication: EndpointPairingPublication): unknown {
  return {
    accountId: publication.accountId,
    desktopInstallationId: publication.desktopInstallationId,
    mobileInstallationId: publication.mobileInstallationId,
    pendingPairingId: publication.pendingPairingId,
    routeId: publication.routeId,
    desktopCredentialDigest: encodeBytes(publication.desktopCredentialDigest),
    credentialDigest: encodeBytes(publication.credentialDigest),
    pairing: encodeStoredPairing(publication.pairing),
    accessGeneration: publication.accessGeneration,
  }
}

function decodeEndpointPublication(value: unknown): EndpointPairingPublication {
  const record = asRecord(value, 'endpoint publication')
  rejectUnsupportedKeys(record, [
    'accountId', 'desktopInstallationId', 'mobileInstallationId', 'pendingPairingId',
    'routeId', 'desktopCredentialDigest', 'credentialDigest', 'pairing', 'accessGeneration',
  ], 'endpoint publication')
  const publication = {
    accountId: parsePlatformAccountId(record.accountId),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    mobileInstallationId: parseInstallationId(record.mobileInstallationId),
    pendingPairingId: parsePendingPairingId(record.pendingPairingId),
    routeId: parseRelayRouteId(record.routeId),
    desktopCredentialDigest: decodeFixedBytes(record.desktopCredentialDigest, 'endpoint publication Desktop credential digest', 32),
    credentialDigest: decodeFixedBytes(record.credentialDigest, 'endpoint publication credential digest', 32),
    pairing: decodeStoredPairing(record.pairing),
    accessGeneration: positiveSafeInteger(record.accessGeneration, 'endpoint publication access generation'),
  }
  assertDistinctCredentialDigests(
    publication.desktopCredentialDigest, publication.credentialDigest, 'endpoint publication',
  )
  return publication
}

function encodeEndpointRevocation(revocation: EndpointPairingRevocation): unknown {
  return {
    accountId: revocation.accountId,
    desktopInstallationId: revocation.desktopInstallationId,
    mobileInstallationId: revocation.mobileInstallationId,
    pendingPairingId: revocation.pendingPairingId,
    pairingId: revocation.pairingId,
    routeId: revocation.routeId,
    desktopCredentialDigest: encodeBytes(revocation.desktopCredentialDigest),
    credentialDigest: encodeBytes(revocation.credentialDigest),
    desktopRevoked: revocation.desktopRevoked,
    mobileRevoked: revocation.mobileRevoked,
    authorityRevoked: revocation.authorityRevoked,
  }
}

function decodeEndpointRevocation(value: unknown): EndpointPairingRevocation {
  const record = asRecord(value, 'endpoint publication revocation')
  rejectUnsupportedKeys(record, [
    'accountId', 'desktopInstallationId', 'mobileInstallationId', 'pendingPairingId',
    'pairingId', 'routeId', 'desktopCredentialDigest', 'credentialDigest',
    'desktopRevoked', 'mobileRevoked', 'authorityRevoked',
  ], 'endpoint publication revocation')
  if (typeof record.desktopRevoked !== 'boolean' || typeof record.mobileRevoked !== 'boolean'
    || typeof record.authorityRevoked !== 'boolean') {
    throw new TypeError('endpoint publication revocation completion flags are invalid')
  }
  const decoded = {
    accountId: parsePlatformAccountId(record.accountId),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    mobileInstallationId: parseInstallationId(record.mobileInstallationId),
    pendingPairingId: parsePendingPairingId(record.pendingPairingId),
    pairingId: parsePersonalPairingId(record.pairingId),
    routeId: parseRelayRouteId(record.routeId),
    desktopCredentialDigest: decodeFixedBytes(
      record.desktopCredentialDigest, 'endpoint publication revocation Desktop credential digest', 32,
    ),
    credentialDigest: decodeFixedBytes(
      record.credentialDigest, 'endpoint publication revocation credential digest', 32,
    ),
    desktopRevoked: record.desktopRevoked,
    mobileRevoked: record.mobileRevoked,
    authorityRevoked: record.authorityRevoked,
  }
  assertDistinctCredentialDigests(
    decoded.desktopCredentialDigest, decoded.credentialDigest, 'endpoint publication revocation',
  )
  return decoded
}

function decodeEndpointAccessGenerations(value: unknown): PersonalPairingTransactionState['endpointAccessGenerations'] {
  const result = new Map<string, PersonalPairingTransactionState['endpointAccessGenerations'] extends Map<string, infer V> ? V : never>()
  for (const entry of asArray(value, 'endpointAccessGenerations')) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new TypeError('endpointAccessGenerations entry is invalid')
    }
    const record = asRecord(entry[1], 'endpoint access generation')
    rejectUnsupportedKeys(record, ['generation', 'phase', 'routeId'], 'endpoint access generation')
    if (record.phase !== 'enabled' && record.phase !== 'disabled') {
      throw new TypeError('endpoint access generation phase is invalid')
    }
    result.set(entry[0], {
      generation: positiveSafeInteger(record.generation, 'endpoint access generation'),
      phase: record.phase,
      ...(record.routeId === undefined ? {} : { routeId: parseRelayRouteId(record.routeId) }),
    })
  }
  return result
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return value as number
}

function encodeEndpointMailbox(state: EndpointOwnedPairingMailboxState): unknown {
  return {
    challenges: state.challenges.map(record => ({
      ...record,
    })),
    pending: state.pending.map(record => ({
      ...record,
      message1: encodeBytes(record.message1),
      ...(record.message2 === undefined ? {} : { message2: encodeBytes(record.message2) }),
      ...(record.message3 === undefined ? {} : { message3: encodeBytes(record.message3) }),
      ...(record.sealedRelayAuthority === undefined
        ? {}
        : { sealedRelayAuthority: encodeBytes(record.sealedRelayAuthority) }),
    })),
  }
}

function decodeEndpointMailbox(value: unknown): EndpointOwnedPairingMailboxState {
  const mailbox = asRecord(value, 'endpoint mailbox')
  return {
    challenges: asArray(mailbox.challenges, 'endpoint mailbox challenges').map((value, index) => {
      const record = asRecord(value, `endpoint mailbox challenge ${String(index)}`)
      rejectUnsupportedKeys(
        record,
        ['challengeId', 'accountId', 'desktopInstallationId', 'expiresAt', 'completionId', 'pendingPairingId'],
        `endpoint mailbox challenge ${String(index)}`,
      )
      return {
        challengeId: parsePairingChallengeId(record.challengeId),
        accountId: parsePlatformAccountId(record.accountId),
        desktopInstallationId: parseInstallationId(record.desktopInstallationId),
        expiresAt: asSafeInteger(record.expiresAt, 'endpoint mailbox challenge expiresAt'),
        ...(record.completionId === undefined
          ? {}
          : { completionId: parsePairingCompletionId(record.completionId) }),
        ...(record.pendingPairingId === undefined
          ? {}
          : { pendingPairingId: parsePendingPairingId(record.pendingPairingId) }),
      }
    }),
    pending: asArray(mailbox.pending, 'endpoint mailbox pending').map((value, index) => {
      const record = asRecord(value, `endpoint mailbox pending ${String(index)}`)
      rejectUnsupportedKeys(
        record,
        ['pendingPairingId', 'completionId', 'challengeId', 'accountId', 'desktopInstallationId',
          'mobileInstallationId', 'device', 'expiresAt', 'message1', 'message2', 'message3',
          'confirmed', 'rejected', 'pairingId', 'sealedRelayAuthority', 'settledAt'],
        `endpoint mailbox pending ${String(index)}`,
      )
      if (typeof record.confirmed !== 'boolean') throw new TypeError('endpoint mailbox confirmed must be boolean')
      if (typeof record.rejected !== 'boolean') throw new TypeError('endpoint mailbox rejected must be boolean')
      return {
        pendingPairingId: parsePendingPairingId(record.pendingPairingId),
        completionId: parsePairingCompletionId(record.completionId),
        challengeId: parsePairingChallengeId(record.challengeId),
        accountId: parsePlatformAccountId(record.accountId),
        desktopInstallationId: parseInstallationId(record.desktopInstallationId),
        mobileInstallationId: parseInstallationId(record.mobileInstallationId),
        device: decodeDevice(record.device),
        expiresAt: asSafeInteger(record.expiresAt, 'endpoint mailbox pending expiresAt'),
        message1: decodeBytes(record.message1, 'endpoint mailbox message1'),
        ...(record.message2 === undefined ? {} : { message2: decodeBytes(record.message2, 'endpoint mailbox message2') }),
        ...(record.message3 === undefined ? {} : { message3: decodeBytes(record.message3, 'endpoint mailbox message3') }),
        confirmed: record.confirmed,
        rejected: record.rejected,
        ...(record.pairingId === undefined ? {} : { pairingId: parsePersonalPairingId(record.pairingId) }),
        ...(record.sealedRelayAuthority === undefined
          ? {}
          : { sealedRelayAuthority: decodeBytes(record.sealedRelayAuthority, 'endpoint mailbox sealed authority') }),
        ...(record.settledAt === undefined
          ? {}
          : { settledAt: asSafeInteger(record.settledAt, 'endpoint mailbox pending settledAt') }),
      }
    }),
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
    ...(record.awaitingFinish === true ? { awaitingFinish: true } : {}),
    ...(record.finishDigest === undefined ? {} : { finishDigest: encodeBytes(record.finishDigest) }),
  }
}

function decodePending(value: unknown): PendingPairingRecord {
  const record = asRecord(value, 'pending pairing')
  return {
    ...decodeCompletion(record),
    cleanup: decodeCleanup(record.cleanup),
    ...(record.activationCleanup === undefined ? {} : { activationCleanup: decodeCleanup(record.activationCleanup) }),
    ...(record.awaitingFinish === true ? { awaitingFinish: true } : {}),
    ...(record.finishDigest === undefined ? {} : { finishDigest: decodeBytes(record.finishDigest, 'finishDigest') }),
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
    ...(record.keyReference === undefined ? {} : { keyReference: record.keyReference }),
    ...(record.cleanup === undefined ? {} : { cleanup: encodeCleanup(record.cleanup) }),
    ...(record.endpointPendingPairingId === undefined ? {} : { endpointPendingPairingId: record.endpointPendingPairingId }),
    ...(record.endpointRouteId === undefined ? {} : { endpointRouteId: record.endpointRouteId }),
    ...(record.endpointCredentialDigest === undefined ? {} : { endpointCredentialDigest: encodeBytes(record.endpointCredentialDigest) }),
    ...(record.endpointDesktopCredentialDigest === undefined ? {} : {
      endpointDesktopCredentialDigest: encodeBytes(record.endpointDesktopCredentialDigest),
    }),
    ...(record.endpointRelayRevision === undefined ? {} : { endpointRelayRevision: record.endpointRelayRevision }),
  }
}

function decodeStoredPairing(value: unknown): StoredPersonalPairing {
  const record = asRecord(value, 'stored pairing')
  rejectUnsupportedKeys(record, [
    'id', 'devicePrincipal', 'device', 'pairedAt', 'lastAccessAt', 'online',
    'desktopInstallationId', 'keyReference', 'cleanup', 'endpointPendingPairingId',
    'endpointRouteId', 'endpointCredentialDigest', 'endpointDesktopCredentialDigest',
    'endpointRelayRevision',
  ], 'stored pairing')
  const pairing: StoredPersonalPairing = {
    ...decodePairingView(record),
    desktopInstallationId: parseInstallationId(record.desktopInstallationId),
    ...(record.keyReference === undefined ? {} : { keyReference: parsePersonalPairingKeyReference(record.keyReference) }),
    ...(record.cleanup === undefined ? {} : { cleanup: decodeCleanup(record.cleanup) }),
    ...(record.endpointPendingPairingId === undefined
      ? {}
      : { endpointPendingPairingId: parsePendingPairingId(record.endpointPendingPairingId) }),
    ...(record.endpointRouteId === undefined ? {} : { endpointRouteId: parseRelayRouteId(record.endpointRouteId) }),
    ...(record.endpointCredentialDigest === undefined
      ? {}
      : { endpointCredentialDigest: decodeFixedBytes(
        record.endpointCredentialDigest, 'stored pairing endpoint credential digest', 32,
      ) }),
    ...(record.endpointDesktopCredentialDigest === undefined
      ? {}
      : { endpointDesktopCredentialDigest: decodeFixedBytes(
        record.endpointDesktopCredentialDigest, 'stored pairing endpoint Desktop credential digest', 32,
      ) }),
    ...(record.endpointRelayRevision === undefined
      ? {}
      : { endpointRelayRevision: positiveSafeInteger(
        record.endpointRelayRevision, 'stored pairing endpoint Relay revision',
      ) }),
  }
  const hasEndpointConfirmation = pairing.endpointCredentialDigest !== undefined
    || pairing.endpointDesktopCredentialDigest !== undefined || pairing.endpointRelayRevision !== undefined
  if (hasEndpointConfirmation && (pairing.endpointCredentialDigest === undefined
    || pairing.endpointDesktopCredentialDigest === undefined || pairing.endpointRelayRevision === undefined)) {
    throw new TypeError('stored pairing endpoint confirmation is incomplete')
  }
  if (pairing.endpointCredentialDigest !== undefined && pairing.endpointDesktopCredentialDigest !== undefined) {
    assertDistinctCredentialDigests(
      pairing.endpointDesktopCredentialDigest, pairing.endpointCredentialDigest, 'stored pairing endpoint',
    )
  }
  return pairing
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
    ...(invitation.desktopStaticPublicKey === undefined
      ? {}
      : { desktopStaticPublicKey: encodeBytes(invitation.desktopStaticPublicKey) }),
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
    ...(record.desktopStaticPublicKey === undefined
      ? {}
      : { desktopStaticPublicKey: decodeFixedBytes(record.desktopStaticPublicKey, 'desktopStaticPublicKey', 32) }),
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

function decodeFixedBytes(value: unknown, name: string, length: number): Uint8Array {
  const bytes = decodeBytes(value, name)
  if (bytes.byteLength !== length) throw new TypeError(`${name} must contain ${String(length)} bytes`)
  return bytes
}

function assertDistinctCredentialDigests(left: Uint8Array, right: Uint8Array, name: string): void {
  if (left.every((byte, index) => byte === right[index])) {
    throw new TypeError(`${name} credential digests must be distinct`)
  }
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

function rejectUnsupportedKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  const supported = new Set(keys)
  if (Object.keys(record).some(key => !supported.has(key))) {
    throw new TypeError(`${name} contains unsupported fields`)
  }
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
