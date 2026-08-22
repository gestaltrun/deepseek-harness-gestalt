import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseDevicePrincipalId,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parsePersonalPairingKeyReference,
  type CompletionReplayRecord,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
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

  it('preserves bytes, orphan cleanup identity, and quota windows', () => {
    const cleanup = { resource: Uint8Array.of(9, 8, 7) }
    const state = emptyPairingTransactionState()
    state.challenges.set(parsePairingChallengeId('challenge-one'), {
      invitation: {
        challengeId: parsePairingChallengeId('challenge-one'),
        invitationSecret: Uint8Array.from({ length: 32 }, (_, index) => index),
        desktopFingerprint: 'fp',
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
    state.blobs.set('blob-1', { accountId: 'account-one', bytes: 32 })
    state.blobSequence.next = 4
    const decoded = decodePairingTransactionState(
      JSON.parse(JSON.stringify(encodePairingTransactionState(state))) as unknown,
    )
    const challenge = decoded.challenges.get(parsePairingChallengeId('challenge-one'))
    expect(challenge?.invitation.invitationSecret).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index))
    const [orphanCleanup, orphan] = [...decoded.orphanPendingCleanups][0] ?? []
    expect(orphanCleanup).toBe(orphan?.cleanup)
    expect(decoded.accountChallengeAt.get('account-one')).toEqual([10, 20])
    expect(decoded.blobSequence.next).toBe(4)
  })

  it('round-trips a confirmed pairing and Relay grant', () => {
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
      mobileGrant: {
        routeId: parseRelayRouteId('route-one'),
        endpoint: 'mobile',
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        revision: 2,
      },
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
    const decoded = decodePairingTransactionState(encodePairingTransactionState(state))
    expect(decoded.pairings.get(parsePersonalPairingId('pairing-one'))?.mobileGrant?.revision).toBe(2)
    expect(decoded.completions.get(parsePairingCompletionId('completion-one'))?.view.device.platform).toBe('android')
    expect(decoded.completions.get(parsePairingCompletionId('completion-one'))?.requestDigest)
      .toEqual(new Uint8Array(32).fill(7))
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
