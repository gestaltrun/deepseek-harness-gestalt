import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseAttachmentBlobReservationId,
  parseDevicePrincipalId,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parsePersonalPairingKeyReference,
  type CompletionReplayRecord,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { describe, expect, it } from 'vitest'
import {
  decodePairingTransactionState,
  emptyPairingTransactionState,
  encodePairingTransactionState,
} from '../src/pairing-state-codec.ts'

describe('pairing transaction codec', () => {
  it('round-trips empty state and rejects an invalid document', () => {
    const empty = emptyPairingTransactionState()
    const encoded = encodePairingTransactionState(empty) as Record<string, unknown>
    expect(encoded.formatVersion).toBe(1)
    expect(decodePairingTransactionState(encoded)).toEqual(empty)
    expect(() => decodePairingTransactionState({ ...encoded, formatVersion: 2 })).toThrow(/unsupported/)
    expect(() => decodePairingTransactionState({ ...encoded, formatVersion: {} })).toThrow(/safe integer/)
    expect(decodePairingTransactionState(undefined).challenges.size).toBe(0)
    expect(() => decodePairingTransactionState('nope')).toThrow(/object/)
    expect(() => decodePairingTransactionState({
      ...encodePairingTransactionState(empty) as object,
      settledChallenges: [['id', { outcome: 'unknown' }]],
    })).toThrow(/outcome/)
  })

  it('persists publication compensation progress without retaining plaintext authority', () => {
    const state = emptyPairingTransactionState()
    const pendingPairingId = parsePendingPairingId('pending-revocation')
    state.endpointPublicationRevocations.set(pendingPairingId, {
      accountId: parsePlatformAccountId('account-one'),
      desktopInstallationId: parseInstallationId('desktop-one'),
      mobileInstallationId: parseInstallationId('mobile-one'),
      pendingPairingId,
      pairingId: parsePersonalPairingId('pairing-one'),
      routeId: parseRelayRouteId('route-one'),
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      credentialDigest: new Uint8Array(32).fill(2),
      desktopRevoked: true,
      mobileRevoked: false,
      authorityRevoked: false,
      removeStoredPairing: true,
      pairingRemoved: false,
    })

    const encoded = encodePairingTransactionState(state)
    expect(JSON.stringify(encoded)).not.toContain('relayCredential')
    expect(decodePairingTransactionState(encoded).endpointPublicationRevocations.get(pendingPairingId))
      .toMatchObject({
        desktopRevoked: true, mobileRevoked: false, authorityRevoked: false,
        removeStoredPairing: true, pairingRemoved: false,
      })

    const equal = structuredClone(encoded) as Record<string, unknown>
    const revocations = equal.endpointPublicationRevocations
    if (!Array.isArray(revocations) || !Array.isArray(revocations[0])) throw new Error('revocation fixture is invalid')
    const revocation = revocations[0][1] as Record<string, unknown>
    revocation.credentialDigest = revocation.desktopCredentialDigest
    expect(() => decodePairingTransactionState(equal)).toThrow('credential digests must be distinct')

    const short = structuredClone(encoded) as Record<string, unknown>
    const shortRevocations = short.endpointPublicationRevocations
    if (!Array.isArray(shortRevocations) || !Array.isArray(shortRevocations[0])) {
      throw new Error('revocation fixture is invalid')
    }
    ;(shortRevocations[0][1] as Record<string, unknown>).credentialDigest = { $b: 'AQ' }
    expect(() => decodePairingTransactionState(short)).toThrow('must contain 32 bytes')

    for (const field of ['removeStoredPairing', 'pairingRemoved'] as const) {
      const missing = structuredClone(encoded) as Record<string, unknown>
      const missingRevocations = missing.endpointPublicationRevocations
      if (!Array.isArray(missingRevocations) || !Array.isArray(missingRevocations[0])) {
        throw new Error('revocation fixture is invalid')
      }
      const missingRevocation = missingRevocations[0][1] as Record<string, unknown>
      if (field === 'removeStoredPairing') delete missingRevocation.removeStoredPairing
      else delete missingRevocation.pairingRemoved
      expect(() => decodePairingTransactionState(missing)).toThrow('completion flags are invalid')
    }
  })

  it('preserves bytes, orphan cleanup identity, and quota windows', () => {
    const cleanup = { resource: Uint8Array.of(9, 8, 7) }
    const state = emptyPairingTransactionState()
    state.challenges.set(parsePairingChallengeId('challenge-one'), {
      invitation: {
        challengeId: parsePairingChallengeId('challenge-one'),
        invitationSecret: Uint8Array.from({ length: 32 }, (_, index) => index),
        desktopFingerprint: 'fp',
        desktopStaticPublicKey: new Uint8Array(32).fill(7),
        rendezvousId: parsePairingRendezvousId('rendezvous-one'),
        expiresAt: 1_787_027_200_000,
        protocolMajor: 1,
      },
      accountId: 'account-one',
      desktopInstallationId: parseInstallationId('desktop-one'),
      cleanup,
    })
    state.orphanPendingCleanups.set(cleanup, {
      accountId: 'account-one',
      desktopInstallationId: parseInstallationId('desktop-one'),
      mobileInstallationId: parseInstallationId('mobile-one'),
      cleanup,
    })
    state.accountChallengeAt.set('account-one', [10, 20])
    state.blobs.set('blob-1', { accountId: 'account-one', bytes: 32, expiresAt: 1_787_027_200_000 })
    state.blobSequence.next = 4
    const decoded = decodePairingTransactionState(
      JSON.parse(JSON.stringify(encodePairingTransactionState(state))) as unknown,
    )
    const challenge = decoded.challenges.get(parsePairingChallengeId('challenge-one'))
    expect(challenge?.invitation.invitationSecret).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index))
    expect(challenge?.invitation.desktopStaticPublicKey).toEqual(new Uint8Array(32).fill(7))
    const [orphanCleanup, orphan] = [...decoded.orphanPendingCleanups][0] ?? []
    expect(orphanCleanup).toBe(orphan?.cleanup)
    expect(decoded.accountChallengeAt.get('account-one')).toEqual([10, 20])
    expect(decoded.blobs.get(parseAttachmentBlobReservationId('blob-1'))?.expiresAt).toBe(1_787_027_200_000)
    expect(decoded.blobSequence.next).toBe(4)
  })

  it('persists only opaque endpoint mailbox messages and never Desktop private state', () => {
    const state = emptyPairingTransactionState()
    const desktopPrivateSentinel = Uint8Array.from({ length: 32 }, () => 213)
    state.endpointMailbox = {
      challenges: [{
        challengeId: parsePairingChallengeId('challenge-mailbox'),
        accountId: parsePlatformAccountId('account-one'),
        desktopInstallationId: parseInstallationId('desktop-one'),
        expiresAt: 1_787_027_200_000,
        completionId: parsePairingCompletionId('completion-mailbox'),
        pendingPairingId: parsePendingPairingId('pending-mailbox'),
      }],
      pending: [{
        pendingPairingId: parsePendingPairingId('pending-mailbox'),
        completionId: parsePairingCompletionId('completion-mailbox'),
        challengeId: parsePairingChallengeId('challenge-mailbox'),
        accountId: parsePlatformAccountId('account-one'),
        desktopInstallationId: parseInstallationId('desktop-one'),
        mobileInstallationId: parseInstallationId('mobile-one'),
        device: { name: 'Alice phone', platform: 'ios' },
        expiresAt: 1_787_027_200_000,
        message1: Uint8Array.of(11),
        message2: Uint8Array.of(22),
        message3: Uint8Array.of(33),
        confirmed: true,
        rejected: false,
        pairingId: parsePersonalPairingId('pairing-mailbox'),
        sealedRelayAuthority: Uint8Array.of(44),
      }],
    }
    const encoded = encodePairingTransactionState(state)
    expect(JSON.stringify(encoded)).not.toContain(Buffer.from(desktopPrivateSentinel).toString('base64url'))
    expect(JSON.stringify(encoded)).not.toMatch(/psk|invitationPayload/iu)
    expect(decodePairingTransactionState(encoded).endpointMailbox).toEqual(state.endpointMailbox)

    const leaked = structuredClone(encoded)
    if (typeof leaked !== 'object' || leaked === null || Array.isArray(leaked)) throw new Error('encoded fixture is invalid')
    const endpointMailbox: unknown = Reflect.get(leaked, 'endpointMailbox')
    if (typeof endpointMailbox !== 'object' || endpointMailbox === null || Array.isArray(endpointMailbox)) {
      throw new Error('encoded endpoint mailbox fixture is invalid')
    }
    const challenges: unknown = Reflect.get(endpointMailbox, 'challenges')
    const challenge: unknown = Array.isArray(challenges) ? challenges[0] : undefined
    if (typeof challenge !== 'object' || challenge === null || Array.isArray(challenge)) {
      throw new Error('encoded endpoint challenge fixture is invalid')
    }
    Reflect.set(challenge, 'invitationPayload', { $b: Buffer.alloc(32, 9).toString('base64url') })
    expect(() => decodePairingTransactionState(leaked)).toThrow('unsupported fields')
  })

  it('round-trips a confirmed pairing and rejects the removed Platform bearer grant field', () => {
    const state = emptyPairingTransactionState()
    state.pairings.set(parsePersonalPairingId('pairing-one'), {
      id: parsePersonalPairingId('pairing-one'),
      devicePrincipal: {
        id: parseDevicePrincipalId('principal-one'),
        accountId: parsePlatformAccountId('account-one'),
        installationId: parseInstallationId('mobile-one'),
        authority: 'companion-surface',
      },
      device: { name: 'Phone', platform: 'ios' },
      pairedAt: 2,
      lastAccessAt: 3,
      online: false,
      desktopInstallationId: parseInstallationId('desktop-one'),
      keyReference: parsePersonalPairingKeyReference('key-one'),
      cleanup: { resource: Uint8Array.of(1) },
      endpointPendingPairingId: parsePendingPairingId('pending-endpoint-one'),
      endpointRouteId: parseRelayRouteId('route-endpoint-one'),
      endpointDesktopCredentialDigest: new Uint8Array(32).fill(1),
      endpointCredentialDigest: new Uint8Array(32).fill(2),
      endpointRelayRevision: 1,
    })
    state.completions.set(parsePairingCompletionId('completion-one'), {
      accountId: 'account-one',
      desktopInstallationId: parseInstallationId('desktop-one'),
      mobileInstallationId: parseInstallationId('mobile-one'),
      challengeId: parsePairingChallengeId('challenge-one'),
      requestDigest: new Uint8Array(32).fill(7),
      challengeCleanup: {},
      view: {
        pendingPairingId: parsePendingPairingId('pending-one'),
        authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
        desktopHandshake: Uint8Array.of(4, 5),
        device: { name: 'Phone', platform: 'android' },
      },
      completedAt: 9,
    })
    const completion = state.completions.get(parsePairingCompletionId('completion-one'))
    if (completion === undefined) throw new Error('pairing codec fixture requires a completion')
    state.pending.set(parsePendingPairingId('pending-one'), {
      ...completion,
      cleanup: { resource: Uint8Array.of(6) },
      awaitingFinish: true,
      finishDigest: new Uint8Array(32).fill(8),
    })
    const encoded = encodePairingTransactionState(state)
    const decoded = decodePairingTransactionState(encoded)
    const legacy = structuredClone(encoded)
    if (typeof legacy !== 'object' || legacy === null || Array.isArray(legacy)) {
      throw new Error('encoded pairing state fixture is invalid')
    }
    const pairings = (legacy as Record<string, unknown>).pairings
    if (!Array.isArray(pairings) || !Array.isArray(pairings[0])) throw new Error('encoded pairing fixture is invalid')
    Reflect.set(pairings[0][1] as object, 'mobileGrant', { credential: 'legacy-bearer' })
    expect(() => decodePairingTransactionState(legacy)).toThrow('unsupported fields')

    const invalidDigest = structuredClone(encoded) as Record<string, unknown>
    const invalidPairings = invalidDigest.pairings
    if (!Array.isArray(invalidPairings) || !Array.isArray(invalidPairings[0])) {
      throw new Error('encoded pairing fixture is invalid')
    }
    const invalidPairing = invalidPairings[0][1] as Record<string, unknown>
    invalidPairing.endpointCredentialDigest = invalidPairing.endpointDesktopCredentialDigest
    expect(() => decodePairingTransactionState(invalidDigest)).toThrow('credential digests must be distinct')

    const invalidRevision = structuredClone(encoded) as Record<string, unknown>
    const revisionPairings = invalidRevision.pairings
    if (!Array.isArray(revisionPairings) || !Array.isArray(revisionPairings[0])) {
      throw new Error('encoded pairing fixture is invalid')
    }
    ;(revisionPairings[0][1] as Record<string, unknown>).endpointRelayRevision = 0
    expect(() => decodePairingTransactionState(invalidRevision)).toThrow('positive safe integer')
    expect(decoded.completions.get(parsePairingCompletionId('completion-one'))?.view.device.platform).toBe('android')
    expect(decoded.completions.get(parsePairingCompletionId('completion-one'))?.requestDigest)
      .toEqual(new Uint8Array(32).fill(7))
    expect(decoded.pending.get(parsePendingPairingId('pending-one'))).toMatchObject({
      awaitingFinish: true,
      finishDigest: new Uint8Array(32).fill(8),
    })
  })

  it('recovers legacy replay records without losing confirmed pairings or cleanup ownership', () => {
    const state = emptyPairingTransactionState()
    const pairingId = parsePersonalPairingId('pairing-legacy')
    const principalId = parseDevicePrincipalId('principal-legacy')
    state.pairings.set(pairingId, {
      id: pairingId,
      devicePrincipal: {
        id: principalId,
        accountId: parsePlatformAccountId('account-one'),
        installationId: parseInstallationId('mobile-one'),
        authority: 'companion-surface',
      },
      device: { name: 'Preserved phone', platform: 'ios' },
      pairedAt: 2,
      lastAccessAt: 3,
      online: false,
      desktopInstallationId: parseInstallationId('desktop-one'),
      keyReference: parsePersonalPairingKeyReference('key-legacy'),
      cleanup: { resource: Uint8Array.of(1) },
    })
    state.principalIds.add(principalId)
    const completion = replayRecord('completion', 'challenge-completion', 'pending-completion', 10)
    const pending = replayRecord('pending', 'challenge-pending', 'pending-legacy', 11)
    state.settledChallenges.set(parsePairingChallengeId('challenge-completion'), {
      accountId: 'account-one',
      desktopInstallationId: parseInstallationId('desktop-one'),
      outcome: 'completed',
      cleanup: { resource: Uint8Array.of(2) },
      settledAt: 10,
    })
    state.completions.set(parsePairingCompletionId('completion-legacy'), completion)
    state.pending.set(parsePendingPairingId('pending-legacy'), {
      ...pending,
      cleanup: { resource: Uint8Array.of(4) },
      activationCleanup: { resource: Uint8Array.of(5) },
    })
    const unversioned = unversionedDocument(state)
    const preserved = decodePairingTransactionState(unversioned)
    expect(preserved.completions.size).toBe(1)
    expect(preserved.pending.size).toBe(1)
    const legacy = structuredClone(unversioned)
    for (const [, record] of [...legacy.completions, ...legacy.pending]) delete record.requestDigest
    for (const [, record] of [...legacy.completions, ...legacy.pending]) record.view = 'discarded replay view'
    expect(() => decodePairingTransactionState({ ...legacy, formatVersion: 1 }))
      .toThrow('completion.requestDigest must be an object')

    const recovered = decodePairingTransactionState(legacy)

    expect(recovered.pairings.get(pairingId)?.device.name).toBe('Preserved phone')
    expect(recovered.principalIds).toEqual(new Set([principalId]))
    expect(recovered.completions.size).toBe(0)
    expect(recovered.pending.size).toBe(0)
    expect(recovered.settledChallenges.get(parsePairingChallengeId('challenge-completion'))).toMatchObject({
      outcome: 'completed',
      cleanup: { resource: Uint8Array.of(2) },
    })
    expect(recovered.settledChallenges.get(parsePairingChallengeId('challenge-pending'))).toMatchObject({
      outcome: 'completed',
      cleanup: { resource: Uint8Array.of(2) },
    })
    expect(recovered.settledPending.get(parsePendingPairingId('pending-legacy'))).toMatchObject({
      outcome: 'disposed',
      cleanup: { resource: Uint8Array.of(4) },
      activeCleanup: { resource: Uint8Array.of(5) },
    })
    expect(encodePairingTransactionState(recovered)).toMatchObject({ formatVersion: 1 })
  })

  it('rejects malformed or ownership-inconsistent legacy recovery records', () => {
    const malformed = unversionedDocument(emptyPairingTransactionState())
    malformed.completions = [['broken'] as never]
    expect(() => decodePairingTransactionState(malformed)).toThrow(/entries must be pairs/)

    const active = emptyPairingTransactionState()
    const activeReplay = replayRecord('active', 'challenge-active', 'pending-active', 10)
    active.completions.set(parsePairingCompletionId('completion-active'), activeReplay)
    active.challenges.set(activeReplay.challengeId, {
      invitation: {
        challengeId: activeReplay.challengeId,
        invitationSecret: new Uint8Array(32),
        desktopFingerprint: 'fingerprint',
        rendezvousId: parsePairingRendezvousId('rendezvous-active'),
        expiresAt: 20,
        protocolMajor: 1,
      },
      accountId: activeReplay.accountId,
      desktopInstallationId: activeReplay.desktopInstallationId,
      cleanup: {},
    })
    const activeDocument = unversionedDocument(active)
    stripReplayDigests(activeDocument)
    expect(() => decodePairingTransactionState(activeDocument)).toThrow(/active and completed challenge/)

    const duplicatePending = emptyPairingTransactionState()
    const pendingReplay = replayRecord('duplicate', 'challenge-duplicate', 'pending-duplicate', 10)
    const pendingId = parsePendingPairingId('pending-duplicate')
    duplicatePending.pending.set(pendingId, { ...pendingReplay, cleanup: {} })
    duplicatePending.settledPending.set(pendingId, {
      accountId: pendingReplay.accountId,
      desktopInstallationId: pendingReplay.desktopInstallationId,
      mobileInstallationId: pendingReplay.mobileInstallationId,
      outcome: 'disposed',
      cleanup: {},
      settledAt: 10,
    })
    const duplicatePendingDocument = unversionedDocument(duplicatePending)
    stripReplayDigests(duplicatePendingDocument)
    expect(() => decodePairingTransactionState(duplicatePendingDocument)).toThrow(/duplicate pending/)

    for (const inconsistent of inconsistentSettledChallenges()) {
      expect(() => decodePairingTransactionState(inconsistent)).toThrow(/completed challenge state is inconsistent/)
    }
  })
})

function replayRecord(
  suffix: string,
  challengeId: string,
  pendingPairingId: string,
  completedAt: number,
): CompletionReplayRecord {
  return {
    accountId: 'account-one',
    desktopInstallationId: parseInstallationId('desktop-one'),
    mobileInstallationId: parseInstallationId('mobile-one'),
    challengeId: parsePairingChallengeId(challengeId),
    requestDigest: new Uint8Array(32).fill(7),
    challengeCleanup: { resource: Uint8Array.of(2) },
    view: {
      pendingPairingId: parsePendingPairingId(pendingPairingId),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      desktopHandshake: Uint8Array.of(3),
      device: { name: `Legacy ${suffix}`, platform: 'android' },
    },
    completedAt,
  }
}

interface EncodedTransactionDocument {
  formatVersion?: unknown
  completions: Array<[string, Record<string, unknown>]>
  pending: Array<[string, Record<string, unknown>]>
}

function unversionedDocument(state: ReturnType<typeof emptyPairingTransactionState>): EncodedTransactionDocument {
  const document = JSON.parse(JSON.stringify(encodePairingTransactionState(state))) as EncodedTransactionDocument
  delete document.formatVersion
  return document
}

function stripReplayDigests(document: EncodedTransactionDocument): void {
  for (const [, record] of [...document.completions, ...document.pending]) delete record.requestDigest
}

function inconsistentSettledChallenges(): EncodedTransactionDocument[] {
  return [
    { accountId: 'account-other' },
    { desktopInstallationId: 'desktop-other' },
    { outcome: 'expired' },
    { cleanup: {} },
    { cleanup: { resource: { $b: 'AgM' } } },
    { cleanup: { resource: { $b: 'Aw' } } },
  ].map((change) => {
    const state = emptyPairingTransactionState()
    const replay = replayRecord('inconsistent', 'challenge-inconsistent', 'pending-inconsistent', 10)
    state.completions.set(parsePairingCompletionId('completion-inconsistent'), replay)
    state.settledChallenges.set(replay.challengeId, {
      accountId: replay.accountId,
      desktopInstallationId: replay.desktopInstallationId,
      outcome: 'completed',
      cleanup: { resource: Uint8Array.of(2) },
      settledAt: 10,
    })
    const document = unversionedDocument(state)
    stripReplayDigests(document)
    const settledChallenges = documentAsRecord(document).settledChallenges as Array<[string, Record<string, unknown>]>
    const settled = settledChallenges[0]?.[1]
    if (settled === undefined) throw new Error('settled challenge fixture is missing')
    Object.assign(settled, change)
    return document
  })
}

function documentAsRecord(document: EncodedTransactionDocument): Record<string, unknown> {
  return document as unknown as Record<string, unknown>
}
