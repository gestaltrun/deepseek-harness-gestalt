import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseDevicePrincipalId,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parsePersonalPairingKeyReference,
  parseRelayConnectionToken,
  parseRelayCredentialFingerprint,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayPairingSelector, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyPairingTransactionState,
  encodePairingTransactionState,
} from '../src/pairing-state-codec.ts'
import { PostgresPersonalPairingAuthorityStore, type PlatformSqlPool } from '../src/postgres-pairing-store.ts'
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

  it('fails revocation when PostgreSQL leaves Mobile authority behind', async () => {
    const underlying = createMemoryPlatformSqlPool()
    let retainDeletion = false
    const pool: PlatformSqlPool = {
      query: async (sql, values) => retainDeletion && sql.toLowerCase().includes('delete from remote_access_mobile_pairings')
        ? { rows: [], rowCount: 0 }
        : await underlying.query(sql, values),
      connect: async () => await underlying.connect(),
    }
    const store = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    const authority = {
      accountId: ACCOUNT,
      desktopInstallationId: DESKTOP,
      mobileInstallationId: MOBILE,
      pendingPairingId: parsePendingPairingId('pending-retained'),
      pairingId: parsePersonalPairingId('pairing-retained'),
    }
    await store.confirmMobilePairing(authority)
    retainDeletion = true

    await expect(store.revokeMobilePairing(authority.pairingId))
      .rejects.toThrow('left Mobile authority registered')
    expect(await store.getMobilePairing(authority.pendingPairingId)).toEqual(authority)
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

  it('recovers an unversioned transaction on its first mutation and rejects explicit unknown versions', async () => {
    const pool = createMemoryPlatformSqlPool()
    const store = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    await store.migrate()
    await pool.query(
      `INSERT INTO remote_access_pairing_transactions (database_identity, state)
       VALUES ($1, $2::jsonb)`,
      ['gestalt', JSON.stringify(legacyPairingTransactionDocument())],
    )

    await store.runPairingTransaction(async (state) => {
      expect(state.pairings.get(parsePersonalPairingId('pairing-legacy'))?.device.name).toBe('Preserved phone')
      expect(state.completions.size).toBe(0)
      expect(state.pending.size).toBe(0)
      expect(state.settledPending.get(parsePendingPairingId('pending-legacy'))?.outcome).toBe('disposed')
      state.blobSequence.next = 9
    })
    const migrated = await pool.query(
      `SELECT state FROM remote_access_pairing_transactions
        WHERE database_identity = $1`,
      ['gestalt'],
    )
    expect(migrated.rows[0]?.state).toMatchObject({ formatVersion: 1, blobSequence: { next: 9 } })

    const rejected = new PostgresPersonalPairingAuthorityStore('unknown-version', pool)
    await pool.query(
      `INSERT INTO remote_access_pairing_transactions (database_identity, state)
       VALUES ($1, $2::jsonb)`,
      ['unknown-version', JSON.stringify({
        ...encodePairingTransactionState(emptyPairingTransactionState()) as object,
        formatVersion: 99,
      })],
    )
    const operation = vi.fn()
    await expect(rejected.runPairingTransaction(operation)).rejects.toThrow(/unsupported/)
    expect(operation).not.toHaveBeenCalled()
  })

  it('rolls back the prepared document when the final database commit fails', async () => {
    const underlying = createMemoryPlatformSqlPool()
    let failCommit = true
    const pool: PlatformSqlPool = {
      query: async (sql, values) => await underlying.query(sql, values),
      async connect() {
        const client = await underlying.connect()
        return {
          release: () => { client.release() },
          query: async (sql, values) => {
            if (failCommit && sql.trim().toLowerCase() === 'commit') {
              failCommit = false
              throw new Error('final commit failed')
            }
            return await client.query(sql, values)
          },
        }
      },
    }
    const store = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    await store.migrate()
    await expect(store.runPairingTransaction(async (state) => {
      state.principalIds.add('principal-uncommitted' as never)
    })).rejects.toThrow('final commit failed')
    await store.runPairingTransaction(async (state) => {
      expect(state.principalIds.has('principal-uncommitted' as never)).toBe(false)
    })
  })

  it('retains endpoint revocation digests and step progress across store restart', async () => {
    const pool = createMemoryPlatformSqlPool()
    const pendingPairingId = parsePendingPairingId('pending-revocation-restart')
    const writer = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    await writer.migrate()
    await writer.runPairingTransaction(async (state) => {
      state.endpointPublicationRevocations.set(pendingPairingId, {
        accountId: ACCOUNT,
        desktopInstallationId: DESKTOP,
        mobileInstallationId: MOBILE,
        pendingPairingId,
        pairingId: parsePersonalPairingId('pairing-revocation-restart'),
        routeId: parseRelayRouteId('route-revocation-restart'),
        desktopCredentialDigest: new Uint8Array(32).fill(21),
        credentialDigest: new Uint8Array(32).fill(22),
        desktopRevoked: false,
        mobileRevoked: false,
        authorityRevoked: false,
        removeStoredPairing: true,
        pairingRemoved: false,
      })
    })

    const recovered = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    await recovered.runPairingTransaction(async (state) => {
      const revocation = state.endpointPublicationRevocations.get(pendingPairingId)
      expect(revocation?.desktopCredentialDigest).toEqual(new Uint8Array(32).fill(21))
      expect(revocation?.credentialDigest).toEqual(new Uint8Array(32).fill(22))
      if (revocation === undefined) throw new Error('revocation recovery record is absent')
      revocation.desktopRevoked = true
    })
    const restarted = new PostgresPersonalPairingAuthorityStore('gestalt', pool)
    await restarted.runPairingTransaction(async (state) => {
      expect(state.endpointPublicationRevocations.get(pendingPairingId)).toMatchObject({
        desktopRevoked: true,
        mobileRevoked: false,
        authorityRevoked: false,
        removeStoredPairing: true,
        pairingRemoved: false,
      })
    })
  })
})

describe('PostgresRelayRouteStore', () => {
  it('atomically activates distinct pairing-scoped Desktop and Mobile digests', async () => {
    const underlying = createMemoryPlatformSqlPool()
    let failCommit = true
    const pool: PlatformSqlPool = {
      query: async (sql, values) => await underlying.query(sql, values),
      async connect() {
        const client = await underlying.connect()
        return {
          release: () => { client.release() },
          query: async (sql, values) => {
            if (failCommit && sql.trim().toLowerCase() === 'commit') {
              failCommit = false
              throw new Error('pairing authority commit failed')
            }
            return await client.query(sql, values)
          },
        }
      },
    }
    const store = new PostgresRelayRouteStore('gestalt', pool)
    await store.migrate()
    const routeId = parseRelayRouteId('route-pairing-scoped')
    const desktopOne = new Uint8Array(32).fill(1)
    const mobileOne = new Uint8Array(32).fill(2)
    await expect(store.registerPairing(
      routeId, parseRelayPairingSelector('pairing-one'), desktopOne, mobileOne,
    )).rejects.toThrow('pairing authority commit failed')
    expect(await store.authorize(routeId, 'desktop', desktopOne)).toBeUndefined()
    expect(await store.authorize(routeId, 'mobile', mobileOne)).toBeUndefined()

    expect(await store.registerPairing(
      routeId, parseRelayPairingSelector('pairing-one'), desktopOne, mobileOne,
    )).toBe(1)
    const desktopTwo = new Uint8Array(32).fill(3)
    const mobileTwo = new Uint8Array(32).fill(4)
    expect(await store.registerPairing(
      routeId, parseRelayPairingSelector('pairing-two'), desktopTwo, mobileTwo,
    )).toBe(1)
    expect(await store.authorize(routeId, 'desktop', desktopOne)).toEqual({
      revision: 1, pairingSelector: 'pairing-one',
    })
    expect(await store.authorize(routeId, 'mobile', mobileOne)).toEqual({
      revision: 1, pairingSelector: 'pairing-one',
    })
    expect(await store.authorize(routeId, 'desktop', desktopTwo)).toEqual({
      revision: 1, pairingSelector: 'pairing-two',
    })
    expect(await store.authorize(routeId, 'mobile', mobileTwo)).toEqual({
      revision: 1, pairingSelector: 'pairing-two',
    })

    const reusedPeer = new Uint8Array(32).fill(5)
    await expect(store.registerPairing(
      routeId, parseRelayPairingSelector('pairing-reuse'), desktopOne, reusedPeer,
    )).rejects.toThrow('already belongs to another Personal Pairing')
    expect(await store.authorize(routeId, 'mobile', reusedPeer)).toBeUndefined()
    await expect(store.registerPairing(
      routeId, parseRelayPairingSelector('pairing-equal'), reusedPeer, reusedPeer,
    )).rejects.toThrow('must be distinct')

    const shared = new Uint8Array(32).fill(6)
    const concurrent = await Promise.allSettled([
      store.registerPairing(
        routeId, parseRelayPairingSelector('pairing-concurrent-a'), shared, new Uint8Array(32).fill(7),
      ),
      store.registerPairing(
        routeId, parseRelayPairingSelector('pairing-concurrent-b'), shared, new Uint8Array(32).fill(8),
      ),
    ])
    expect(concurrent.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

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
    expect(await store.issue(routeId, 'mobile', mobile, parseRelayPairingSelector('pairing-one'))).toBe(1)
    expect(await store.authorize(routeId, 'desktop', desktop)).toEqual({ revision: 1 })
    expect(await store.authorize(routeId, 'mobile', mobile)).toEqual({
      revision: 1, pairingSelector: 'pairing-one',
    })
    expect(await store.rotate(routeId, 'desktop', replacement)).toBe(2)
    expect(await store.authorize(routeId, 'desktop', desktop)).toBeUndefined()
    expect(await store.authorize(routeId, 'desktop', replacement)).toEqual({ revision: 2 })
    expect(await store.authorize(routeId, 'mobile', mobile)).toEqual({
      revision: 2, pairingSelector: 'pairing-one',
    })
    expect(await store.revokeCredential(routeId, 'mobile', mobile)).toBe(3)
    expect(await store.authorize(routeId, 'mobile', mobile)).toBeUndefined()
    expect(await store.revoke(routeId)).toBe(4)
    expect(await store.issue(routeId, 'mobile', mobile)).toBeUndefined()
    expect(await store.authorize(routeId, 'desktop', replacement)).toBeUndefined()
  })

  it('rolls back revocation when PostgreSQL leaves a credential authority behind', async () => {
    const underlying = createMemoryPlatformSqlPool()
    let retainDeletion = false
    const pool: PlatformSqlPool = {
      query: async (sql, values) => await underlying.query(sql, values),
      async connect() {
        const client = await underlying.connect()
        return {
          release: () => { client.release() },
          query: async (sql, values) => retainDeletion
            && sql.toLowerCase().includes('delete from remote_access_route_authorities')
            ? { rows: [], rowCount: 0 }
            : await client.query(sql, values),
        }
      },
    }
    const store = new PostgresRelayRouteStore('gestalt', pool)
    const routeId = parseRelayRouteId('route-retained')
    const digest = new Uint8Array(32).fill(7)
    await store.rotate(routeId, 'desktop', digest)
    retainDeletion = true

    await expect(store.revokeCredential(routeId, 'desktop', digest))
      .rejects.toThrow('did not quiesce')
    expect(await store.authorize(routeId, 'desktop', digest)).toEqual({ revision: 1 })
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function legacyPairingTransactionDocument(): unknown {
  const state = emptyPairingTransactionState()
  const pairingId = parsePersonalPairingId('pairing-legacy')
  const principalId = parseDevicePrincipalId('principal-legacy')
  state.pairings.set(pairingId, {
    id: pairingId,
    devicePrincipal: {
      id: principalId,
      accountId: ACCOUNT,
      installationId: MOBILE,
      authority: 'companion-surface',
    },
    device: { name: 'Preserved phone', platform: 'ios' },
    pairedAt: 2,
    lastAccessAt: 3,
    online: false,
    desktopInstallationId: DESKTOP,
    keyReference: parsePersonalPairingKeyReference('key-legacy'),
    cleanup: { resource: Uint8Array.of(1) },
  })
  state.principalIds.add(principalId)
  const completion = {
    accountId: ACCOUNT,
    desktopInstallationId: DESKTOP,
    mobileInstallationId: MOBILE,
    challengeId: parsePairingChallengeId('challenge-legacy'),
    requestDigest: new Uint8Array(32).fill(7),
    challengeCleanup: {},
    view: {
      pendingPairingId: parsePendingPairingId('pending-legacy'),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'] as const,
      desktopHandshake: Uint8Array.of(3),
      device: { name: 'Legacy pending phone', platform: 'android' as const },
    },
    completedAt: 10,
  }
  state.completions.set(parsePairingCompletionId('completion-legacy'), completion)
  state.pending.set(parsePendingPairingId('pending-legacy'), {
    ...completion,
    cleanup: { resource: Uint8Array.of(4) },
  })
  const document = structuredClone(encodePairingTransactionState(state)) as {
    formatVersion?: unknown
    completions: Array<[string, Record<string, unknown>]>
    pending: Array<[string, Record<string, unknown>]>
  }
  delete document.formatVersion
  for (const [, record] of [...document.completions, ...document.pending]) delete record.requestDigest
  return document
}
