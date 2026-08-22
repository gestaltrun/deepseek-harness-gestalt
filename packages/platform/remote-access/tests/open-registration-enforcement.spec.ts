import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AccountProof } from '@deepseek-ai/dsh-platform-account'
import { parseAccountProofJti, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  ACCOUNT_DAILY_QUOTA_WINDOW_MS,
  MemoryPersonalPairingAuthorityStore,
  MemoryPlatformCapacityGate,
  OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  OPEN_REGISTRATION_QUOTAS,
  PAIRING_CHALLENGE_QUOTA_WINDOW_MS,
  PAIRING_REPLAY_RETENTION_MS,
  PersonalPairingProvider,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  retryAfterSecondsUntil,
  type PairingHandshakeProvider,
} from '../src/index.ts'

const NOW = Date.parse('2026-08-19T10:00:00.000Z')

describe('open-registration enforcement', () => {
  it('accepts ten hourly account challenges and thirty hourly IP challenges, then rejects with retry timing', async () => {
    const now = { value: NOW }
    const provider = uniqueProvider(now)
    for (const account of ['account-a', 'account-b', 'account-c']) {
      const desktop = authentication(`desktop-${account}`, account)
      await provider.setMobileAccess({ desktop, enabled: true })
      for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour; index += 1) {
        const challenge = await provider.createChallenge({
          desktop,
          rendezvousId: parsePairingRendezvousId(`${account}-${String(index)}`),
          clientIp: '203.0.113.10',
        })
        await provider.cancelChallenge({ desktop, challengeId: challenge.challengeId })
      }
    }
    const extra = authentication('desktop-account-d', 'account-d')
    await provider.setMobileAccess({ desktop: extra, enabled: true })
    await expect(provider.createChallenge({
      desktop: extra,
      rendezvousId: parsePairingRendezvousId('ip-over'),
      clientIp: '203.0.113.10',
    })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: Math.ceil(PAIRING_CHALLENGE_QUOTA_WINDOW_MS / 1_000),
    })
    const isolated = authentication('desktop-account-e', 'account-e')
    await provider.setMobileAccess({ desktop: isolated, enabled: true })
    const otherIp = await provider.createChallenge({
      desktop: isolated,
      rendezvousId: parsePairingRendezvousId('other-ip'),
      clientIp: '198.51.100.8',
    })
    expect(otherIp.challengeId.length).toBeGreaterThan(0)
  })

  it('rejects the eleventh hourly challenge for one account and still lists an established pairing', async () => {
    const now = { value: NOW }
    const provider = uniqueProvider(now)
    const desktop = authentication('desktop-installation', 'account-one')
    const mobile = authentication('mobile-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    const first = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('keep'),
      clientIp: '192.0.2.10',
    })
    const pending = await provider.completeChallenge({
      mobile,
      completionId: parsePairingCompletionId('keep'),
      oneTimeLink: first.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    const pairing = await provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    for (let index = 1; index < OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour; index += 1) {
      const challenge = await provider.createChallenge({
        desktop,
        rendezvousId: parsePairingRendezvousId(`hourly-${String(index)}`),
        clientIp: '192.0.2.11',
      })
      await provider.cancelChallenge({ desktop, challengeId: challenge.challengeId })
    }
    await expect(provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('hourly-over'),
      clientIp: '192.0.2.12',
    })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: Math.ceil(PAIRING_CHALLENGE_QUOTA_WINDOW_MS / 1_000),
    })
    expect(await provider.listPersonalPairings(desktop)).toMatchObject([{ id: pairing.id }])
    now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS + 1
    const restored = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('hourly-restored'),
      clientIp: '192.0.2.13',
    })
    expect(restored.challengeId.length).toBeGreaterThan(0)
  })

  it('accepts fifty Personal Pairings and rejects the fifty-first', async () => {
    const now = { value: NOW }
    const provider = uniqueProvider(now)
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.personalPairings; index += 1) {
      if (index > 0 && index % 4 === 0) now.value += PAIRING_REPLAY_RETENTION_MS + 1
      if (index > 0 && index % OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour === 0) {
        now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS + 1
      }
      const challenge = await provider.createChallenge({
        desktop,
        rendezvousId: parsePairingRendezvousId(`pair-${String(index)}`),
        clientIp: '192.0.2.20',
      })
      const pending = await provider.completeChallenge({
        mobile: authentication(`mobile-${String(index)}`, 'account-one'),
        completionId: parsePairingCompletionId(`pair-${String(index)}`),
        oneTimeLink: challenge.oneTimeLink,
        mobileHandshake: Uint8Array.of(9),
      })
      await provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    }
    now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS + 1
    const extra = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('pair-over'),
      clientIp: '192.0.2.20',
    })
    const pending = await provider.completeChallenge({
      mobile: authentication('mobile-over', 'account-one'),
      completionId: parsePairingCompletionId('pair-over'),
      oneTimeLink: extra.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    await expect(provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId }))
      .rejects.toMatchObject({
        code: 'QUOTA',
        retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
      })
  }, 30_000)

  it('enforces concurrent, per-blob, and daily blob ceilings', async () => {
    const now = { value: NOW }
    const provider = uniqueProvider(now)
    const owner = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop: owner, enabled: true })
    const held: string[] = []
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.concurrentBlobs; index += 1) {
      held.push((await provider.admitAttachmentBlob({ owner, bytes: 1 })).reservationId)
    }
    await expect(provider.admitAttachmentBlob({ owner, bytes: 1 })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })
    await provider.releaseAttachmentBlob({ owner, reservationId: held[0] as string })
    const exactLimit = await provider.admitAttachmentBlob({
      owner,
      bytes: OPEN_REGISTRATION_QUOTAS.blobBytes,
    })
    expect(exactLimit.reservationId.length).toBeGreaterThan(0)
    await expect(provider.admitAttachmentBlob({
      owner,
      bytes: OPEN_REGISTRATION_QUOTAS.blobBytes + 1,
    })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })

    const isolated = uniqueProvider(now)
    await isolated.setMobileAccess({ desktop: owner, enabled: true })
    await expect(isolated.admitAttachmentBlob({
      owner,
      bytes: OPEN_REGISTRATION_QUOTAS.blobBytes + 1,
    })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })

    const daily = uniqueProvider(now)
    await daily.setMobileAccess({ desktop: owner, enabled: true })
    const blobBytes = OPEN_REGISTRATION_QUOTAS.blobBytes
    const dailyLimit = OPEN_REGISTRATION_QUOTAS.blobBytesPerAccountPerDay
    const fullBlobs = Math.trunc(dailyLimit / blobBytes)
    for (let index = 0; index < fullBlobs; index += 1) {
      const admitted = await daily.admitAttachmentBlob({ owner, bytes: blobBytes })
      await daily.releaseAttachmentBlob({ owner, reservationId: admitted.reservationId })
    }
    const remainder = dailyLimit - fullBlobs * blobBytes
    if (remainder > 0) {
      const admitted = await daily.admitAttachmentBlob({ owner, bytes: remainder })
      await daily.releaseAttachmentBlob({ owner, reservationId: admitted.reservationId })
    }
    await expect(daily.admitAttachmentBlob({ owner, bytes: 1 })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: retryAfterSecondsUntil(NOW, ACCOUNT_DAILY_QUOTA_WINDOW_MS, now.value),
    })
    now.value += ACCOUNT_DAILY_QUOTA_WINDOW_MS + 1
    const afterDailyWindow = await daily.admitAttachmentBlob({ owner, bytes: 1 })
    expect(afterDailyWindow.reservationId.length).toBeGreaterThan(0)
    await expect(daily.admitAttachmentBlob({ owner, bytes: -1 })).rejects.toBeInstanceOf(TypeError)
    await expect(daily.releaseAttachmentBlob({ owner, reservationId: 'missing' })).rejects.toBeInstanceOf(TypeError)

  })

  it('sheds new pairing and blob acquisition at capacity while an established pairing remains listed', async () => {
    const gate = new MemoryPlatformCapacityGate(1, 4_500)
    const provider = uniqueProvider({ value: NOW }, gate)
    const desktop = authentication('desktop-installation', 'account-one')
    const mobile = authentication('mobile-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('keep-capacity'),
      clientIp: '192.0.2.30',
    })
    const pending = await provider.completeChallenge({
      mobile,
      completionId: parsePairingCompletionId('keep-capacity'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    const pairing = await provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    expect(gate.tryAcquire()).toBe(true)
    await expect(provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('shed'),
      clientIp: '192.0.2.30',
    })).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY', retryAfter: 5 })
    await expect(provider.admitAttachmentBlob({ owner: desktop, bytes: 1 }))
      .rejects.toMatchObject({ code: 'PLATFORM_CAPACITY', retryAfter: 5 })
    expect(await provider.listPersonalPairings(desktop)).toMatchObject([{ id: pairing.id }])
  })

  it('rejects the eleventh challenge and sixth blob through a second shared-authority provider', async () => {
    const now = { value: NOW }
    const authority = new MemoryPersonalPairingAuthorityStore()
    const first = uniqueProvider(now, undefined, authority, 'a-')
    const second = uniqueProvider(now, undefined, authority, 'b-')
    const desktopA = authentication('desktop-a', 'account-shared')
    const desktopB = authentication('desktop-b', 'account-shared')
    await first.setMobileAccess({ desktop: desktopA, enabled: true })
    await second.setMobileAccess({ desktop: desktopB, enabled: true })
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour; index += 1) {
      const challenge = await first.createChallenge({
        desktop: desktopA,
        rendezvousId: parsePairingRendezvousId(`shared-${String(index)}`),
        clientIp: '192.0.2.80',
      })
      await first.cancelChallenge({ desktop: desktopA, challengeId: challenge.challengeId })
    }
    await expect(second.createChallenge({
      desktop: desktopB,
      rendezvousId: parsePairingRendezvousId('shared-over'),
      clientIp: '192.0.2.81',
    })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: Math.ceil(PAIRING_CHALLENGE_QUOTA_WINDOW_MS / 1_000),
    })

    const held: string[] = []
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.concurrentBlobs; index += 1) {
      held.push((await first.admitAttachmentBlob({ owner: desktopA, bytes: 1 })).reservationId)
    }
    await expect(second.admitAttachmentBlob({ owner: desktopB, bytes: 1 })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })
    await first.releaseAttachmentBlob({ owner: desktopA, reservationId: held[0] as string })

  })

  it('rejects a Pairing Challenge when the client IP is missing', async () => {
    const provider = uniqueProvider({ value: NOW })
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    await expect(provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('missing-ip'),
      clientIp: '',
    })).rejects.toBeInstanceOf(TypeError)
    await expect(provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('undefined-ip'),
      clientIp: undefined as unknown as string,
    })).rejects.toBeInstanceOf(TypeError)
  })
})

function uniqueProvider(
  now: { value: number },
  capacity?: MemoryPlatformCapacityGate,
  authority?: MemoryPersonalPairingAuthorityStore,
  idPrefix = '',
) {
  let id = 0
  return new PersonalPairingProvider(new Context(), {
    account: {
      currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => {
        const [accountId, installationId] = accessToken.split(':') as [string, string]
        return {
          account: {
            id: accountId as never,
            githubId: 1,
            githubLogin: accountId,
            avatarUrl: 'https://avatars.example/account',
          },
          installation: installationId.includes('mobile')
            ? {
              id: parseInstallationId(installationId),
              kind: 'mobile' as const,
              presentation: { name: `${installationId} installation`, platform: 'ios' as const },
            }
            : { id: parseInstallationId(installationId), kind: 'desktop' as const },
        }
      }),
    },
    handshake: handshakeProvider(),
    authority: authority ?? new MemoryPersonalPairingAuthorityStore(),
    clock: { now: () => now.value },
    randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index + 1),
    randomId: kind => `${kind}-${idPrefix}${String(++id)}`,
    pairingLinkOrigin: 'https://platform.example.com/pair',
    ...(capacity === undefined ? {} : { capacity }),
  })
}

function handshakeProvider(): PairingHandshakeProvider {
  return {
    createChallenge: vi.fn(async () => ({ desktopFingerprint: 'desktop-fingerprint', state: Uint8Array.of(1) })),
    completeChallenge: vi.fn(async () => ({
      handshakeHash: new Uint8Array(32),
      desktopHandshake: Uint8Array.of(2),
      pendingPairingKey: Uint8Array.of(3),
    })),
    activatePairing: vi.fn(async () => ({
      keyReference: `key-${crypto.randomUUID()}` as never,
      activePairingKey: Uint8Array.of(6),
    })),
    destroyChallenge: vi.fn(),
    destroyPendingPairing: vi.fn(),
    destroyPairing: vi.fn(),
  }
}

function authentication(installationId: string, accountId: string): {
  accessToken: string
  proof: AccountProof
} {
  return {
    accessToken: `${accountId}:${installationId}`,
    proof: { jti: parseAccountProofJti(crypto.randomUUID()), issuedAt: 1, signature: 'signature' },
  }
}
