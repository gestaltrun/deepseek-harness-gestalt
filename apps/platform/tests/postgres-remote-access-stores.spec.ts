import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parsePairingChallengeId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parseRelayConnectionToken,
  parseRelayCredentialFingerprint,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { describe, expect, it } from 'vitest'
import { PostgresPersonalPairingAuthorityStore } from '../src/postgres-pairing-store.ts'
import { PostgresRelayRouteStore } from '../src/postgres-route-store.ts'
import { createMemoryPlatformSqlPool } from './memory-sql.ts'

const ACCOUNT = parsePlatformAccountId('account-one')
const DESKTOP = parseInstallationId('desktop-one')
const MOBILE = parseInstallationId('mobile-one')

describe('PostgresPersonalPairingAuthorityStore', () => {
  it('keeps an existing Desktop route, records revocation, and isolates database identities', async () => {
    const pool = createMemoryPlatformSqlPool()
    const store = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    const other = new PostgresPersonalPairingAuthorityStore('other', pool)
    await store.migrate()
    await other.migrate()
    const first = await store.enableDesktop(ACCOUNT, DESKTOP, parseRelayRouteId('route-a'))
    const second = await store.enableDesktop(ACCOUNT, DESKTOP, parseRelayRouteId('route-b'))
    expect(first).toBe('route-a')
    expect(second).toBe('route-a')
    expect(await store.getDesktop(ACCOUNT, DESKTOP)).toEqual({ enabled: true, routeId: 'route-a' })
    expect(await other.getDesktop(ACCOUNT, DESKTOP)).toEqual({ enabled: false })
    const revoked = await store.disableDesktop(ACCOUNT, DESKTOP)
    expect(revoked).toEqual(['route-a'])
    expect(await store.getDesktop(ACCOUNT, DESKTOP)).toEqual({ enabled: false })
    await store.completeRouteRevocation(ACCOUNT, DESKTOP, parseRelayRouteId('route-a'))
    expect(await store.getDesktop(ACCOUNT, DESKTOP)).toEqual({ enabled: false })
  })

  it('persists confirmed Mobile authority across stores and rejects a colliding commit', async () => {
    const pool = createMemoryPlatformSqlPool()
    const writer = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    const reader = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    await writer.migrate()
    const pending = parsePendingPairingId('pending-one')
    const authority = {
      accountId: ACCOUNT,
      desktopInstallationId: DESKTOP,
      mobileInstallationId: MOBILE,
      pendingPairingId: pending,
      pairingId: parsePersonalPairingId('pairing-one'),
      credentialFingerprint: parseRelayCredentialFingerprint('credential-fingerprint-one'),
      lastAccessAt: 100,
      sealedRelayAuthority: Uint8Array.of(1, 2, 3),
    }
    await writer.confirmMobilePairing(authority)
    await writer.confirmMobilePairing(authority)
    expect(await reader.getMobilePairing(pending)).toEqual(authority)
    const tokenA = parseRelayConnectionToken('connection-a')
    const tokenB = parseRelayConnectionToken('connection-b')
    await writer.recordRelayLease({
      credentialFingerprint: authority.credentialFingerprint,
      connectionToken: tokenA,
      expiresAt: 500,
      accessedAt: 200,
    })
    await reader.recordRelayLease({
      credentialFingerprint: authority.credentialFingerprint,
      connectionToken: tokenB,
      expiresAt: 600,
      accessedAt: 250,
    })
    expect(await reader.getPersonalPairingActivity(authority.pairingId, 300))
      .toEqual({ lastAccessAt: 250, online: true })
    await writer.releaseRelayLease({
      credentialFingerprint: authority.credentialFingerprint,
      connectionToken: tokenA,
      observedAt: 300,
    })
    expect(await reader.getPersonalPairingActivity(authority.pairingId, 300))
      .toEqual({ lastAccessAt: 250, online: true })
    await reader.releaseRelayLease({
      credentialFingerprint: authority.credentialFingerprint,
      connectionToken: tokenB,
      observedAt: 300,
    })
    expect(await reader.getPersonalPairingActivity(authority.pairingId, 300))
      .toEqual({ lastAccessAt: 250, online: false })
    await writer.recordRelayLease({
      credentialFingerprint: authority.credentialFingerprint,
      connectionToken: tokenA,
      expiresAt: 700,
      accessedAt: 400,
    })
    expect(await reader.getPersonalPairingActivity(authority.pairingId, 700))
      .toEqual({ lastAccessAt: 400, online: false })
    await expect(writer.confirmMobilePairing({
      ...authority,
      pairingId: parsePersonalPairingId('pairing-other'),
    })).rejects.toMatchObject({ code: 'PAIRING_ID_COLLISION' })
    await writer.disableDesktop(ACCOUNT, DESKTOP)
    expect(await reader.getMobilePairing(pending)).toBeUndefined()
    await writer.confirmMobilePairing(authority)
    await writer.revokeMobilePairing(parsePersonalPairingId('pairing-one'))
    expect(await reader.getMobilePairing(pending)).toBeUndefined()
    await writer.confirmMobilePairing(authority)
    await expect(reader.confirmMobilePairing({
      ...authority,
      mobileInstallationId: parseInstallationId('mobile-other'),
    })).rejects.toMatchObject({ code: 'PAIRING_ID_COLLISION' })
    expect(await reader.getMobilePairing(pending)).toEqual(authority)
  })

  it('serializes exclusive pairing transactions and rolls back a failed mutation', async () => {
    const pool = createMemoryPlatformSqlPool()
    const store = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    await store.migrate()
    const order: string[] = []
    const first = store.runPairingTransaction(async (state) => {
      order.push('first-start')
      state.challenges.set(parsePairingChallengeId('challenge-one'), {
        invitation: {
          challengeId: parsePairingChallengeId('challenge-one'),
          invitationSecret: new Uint8Array(32),
          desktopFingerprint: 'fp',
          rendezvousId: parsePairingRendezvousId('rendezvous-one'),
          expiresAt: 1,
          protocolMajor: 1,
        },
        accountId: 'account-one',
        desktopInstallationId: DESKTOP,
        cleanup: {},
      })
      await delay(20)
      order.push('first-end')
    })
    const second = store.runPairingTransaction(async (state) => {
      order.push('second')
      expect(state.challenges.size).toBe(1)
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
    await expect(store.runPairingTransaction(async (state) => {
      state.principalIds.add('principal-drop' as never)
      throw new Error('pairing transaction failed')
    })).rejects.toThrow('pairing transaction failed')
    await store.runPairingTransaction(async (state) => {
      expect(state.principalIds.size).toBe(0)
      expect(state.challenges.size).toBe(1)
    })
  })
})

describe('PostgresRelayRouteStore', () => {
  it('rotates, issues, authorizes, and revokes endpoint credentials', async () => {
    const pool = createMemoryPlatformSqlPool()
    const store = new PostgresRelayRouteStore('gestalt', pool)
    await store.migrate()
    const routeId = parseRelayRouteId('route-one')
    const desktop = Uint8Array.of(1, 1, 1)
    const mobile = Uint8Array.of(2, 2, 2)
    const replacement = Uint8Array.of(3, 3, 3)
    expect(await store.issue(routeId, 'mobile', mobile)).toBeUndefined()
    expect(await store.rotate(routeId, 'desktop', desktop)).toBe(1)
    expect(await store.issue(routeId, 'mobile', mobile)).toBe(1)
    expect(await store.authorize(routeId, 'desktop', desktop)).toBe(1)
    expect(await store.authorize(routeId, 'mobile', mobile)).toBe(1)
    expect(await store.rotate(routeId, 'desktop', replacement)).toBe(2)
    expect(await store.authorize(routeId, 'desktop', desktop)).toBeUndefined()
    expect(await store.authorize(routeId, 'desktop', replacement)).toBe(2)
    expect(await store.authorize(routeId, 'mobile', mobile)).toBe(2)
    expect(await store.revokeCredential(routeId, 'mobile', mobile)).toBe(3)
    expect(await store.authorize(routeId, 'mobile', mobile)).toBeUndefined()
    expect(await store.revoke(routeId)).toBe(4)
    expect(await store.issue(routeId, 'mobile', mobile)).toBeUndefined()
    expect(await store.authorize(routeId, 'desktop', replacement)).toBeUndefined()
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
