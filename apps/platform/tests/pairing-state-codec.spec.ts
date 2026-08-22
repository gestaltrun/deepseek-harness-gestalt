import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseDevicePrincipalId,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parsePersonalPairingKeyReference,
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
    expect(decodePairingTransactionState(encodePairingTransactionState(empty))).toEqual(empty)
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
})
