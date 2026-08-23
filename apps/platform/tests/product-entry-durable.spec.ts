import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseAccountProofJti, parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  PersonalPairingProvider,
  parseAttachmentBlobReservationId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parseRelayCredentialFingerprint,
  parseRelayConnectionToken,
  parseRelayInstanceId,
  type PairingHandshakeProvider,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayAttachmentId, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { apply as applyRemoteAttachmentsHttp } from '@deepseek-ai/dsh-remote-attachments/http'
import type { RemoteAttachmentStoreService } from '@deepseek-ai/dsh-remote-attachments'
import type { RemoteAttachmentAuthority } from '@deepseek-ai/dsh-remote-attachments/http'
import pg from 'pg'
import { createClient } from 'redis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectRedis } from '../src/redis-bus.ts'
import { launchOperatedPlatform } from '../src/launch.ts'
import {
  completeAttachmentStorageCutover,
  migrateAttachmentStoragePhase,
  releasePendingAttachmentQuota,
} from '../src/attachment-storage-phase.ts'
import { OssRemoteAttachmentStore } from '../src/oss-attachment-store.ts'
import type { OssObjectClient } from '../src/oss-client.ts'
import { PostgresRemoteAttachmentStore } from '../src/postgres-attachment-store.ts'
import {
  PostgresPersonalPairingAuthorityStore,
  type PlatformSqlPool,
} from '../src/postgres-pairing-store.ts'
import { OperatedRemoteAttachmentAuthority } from '../src/remote-attachment-authority.ts'
import {
  FIXED_BASE_ATTACHMENT_CONSUMER_SHA,
  FIXED_BASE_ATTACHMENT_HTTP_SOURCE_SHA256,
  buildFixedBaseAttachmentHttp,
} from './fixtures/fixed-base-b2e93/build.ts'

const durableProgramsAvailable = commandAvailable('initdb')
  && commandAvailable('postgres')
  && commandAvailable('redis-server')
  && commandAvailable('openssl')
const cleanups: Array<() => Promise<void>> = []
const CUTOVER_OPTIONS = { maxBlobBytes: 1024, quotaCleanup: { release: async () => {} } }

afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason as unknown)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'durable Platform fixture cleanup failed')
})

describe.skipIf(!durableProgramsAvailable)('operated Platform resource entry with disposable durable fixtures', () => {
  it('keeps legacy PostgreSQL and OSS binaries mutually readable during rolling deployment', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const oldContext = new Context()
    const newContext = new Context()
    cleanups.push(async () => { await oldContext.fiber.dispose(); await newContext.fiber.dispose() })
    const pairing = parsePersonalPairingId('pairing-rolling-attachment')
    const oldStore = new PostgresRemoteAttachmentStore(oldContext, 'attachment-rolling-fixture', pool, {
      maxBlobBytes: 1024, capabilityLifetimeMs: 1_000, maxRetainedBlobs: 4,
      quotaCleanup: { release: async () => {} },
    })
    await oldStore.migrate()
    await completeAttachmentStorageCutover(
      pool,
      'attachment-rolling-fixture',
      'bridge',
      'remote-attachments/rolling-fixture',
      CUTOVER_OPTIONS,
    )
    const now = Date.now()
    const oldGrant = await oldStore.publish({ pairingId: pairing, ciphertext: Uint8Array.of(1, 2), now })
    const objects = new Map<string, Uint8Array>()
    const newStore = new OssRemoteAttachmentStore(newContext, 'attachment-rolling-fixture', pool, memoryOssClient(objects), {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 4,
      objectPrefix: 'remote-attachments/rolling-fixture',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 2,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async () => {} },
      inactivePairingIds: async () => [],
    })
    await newStore.migrate()

    await expect(newStore.inspect({ pairingId: pairing, capability: oldGrant.capability, now: now + 1 }))
      .resolves.toEqual(Uint8Array.of(1, 2))
    const oldConsumption = await newStore.consume({ pairingId: pairing, capability: oldGrant.capability, now: now + 2 })
    expect(oldConsumption.ciphertext).toEqual(Uint8Array.of(1, 2))
    await oldConsumption.complete()

    const newGrant = await newStore.publish({ pairingId: pairing, ciphertext: Uint8Array.of(3, 4), now: now + 3 })
    await expect(oldStore.inspect({ pairingId: pairing, capability: newGrant.capability, now: now + 4 }))
      .resolves.toEqual(Uint8Array.of(3, 4))
    const newConsumption = await oldStore.consume({ pairingId: pairing, capability: newGrant.capability, now: now + 5 })
    expect(newConsumption.ciphertext).toEqual(Uint8Array.of(3, 4))
    await newConsumption.complete()
    await expect(newStore.consume({ pairingId: pairing, capability: newGrant.capability, now: now + 6 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })

    const atomicGrant = await newStore.publish({ pairingId: pairing, ciphertext: Uint8Array.of(5, 6), now: now + 7 })
    const atomicConsumers = await Promise.allSettled([
      oldStore.consume({ pairingId: pairing, capability: atomicGrant.capability, now: now + 8 }),
      newStore.consume({ pairingId: pairing, capability: atomicGrant.capability, now: now + 8 }),
    ])
    expect(atomicConsumers.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(atomicConsumers.filter(result => result.status === 'rejected')).toHaveLength(1)
    const atomicWinner = atomicConsumers.find(result => result.status === 'fulfilled')
    if (atomicWinner?.status !== 'fulfilled') throw new Error('bridge and OSS did not elect one consumer')
    await atomicWinner.value.complete()
  }, 60_000)

  it('removes only bridge duplicates and publishes object-only ciphertext after OSS cutover', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const postgresContext = new Context()
    const ossContext = new Context()
    const refusedContext = new Context()
    cleanups.push(async () => {
      await postgresContext.fiber.dispose()
      await ossContext.fiber.dispose()
      await refusedContext.fiber.dispose()
    })
    const databaseIdentity = 'attachment-oss-cutover-fixture'
    const objectPrefix = 'remote-attachments/oss-cutover-fixture'
    const pairingId = parsePersonalPairingId('pairing-oss-cutover')
    const now = Date.now()
    const bridge = new PostgresRemoteAttachmentStore(postgresContext, databaseIdentity, pool, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 8,
      quotaCleanup: { release: async () => {} },
    })
    await bridge.migrate()
    const legacyOnly = await bridge.publish({ pairingId, ciphertext: Uint8Array.of(1), now })
    await completeAttachmentStorageCutover(pool, databaseIdentity, 'bridge', objectPrefix, CUTOVER_OPTIONS)
    const objects = new Map<string, Uint8Array>()
    const oss = new OssRemoteAttachmentStore(ossContext, databaseIdentity, pool, memoryOssClient(objects), {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 8,
      objectPrefix,
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 1,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async () => {} },
      inactivePairingIds: async () => [],
    })
    await oss.migrate()
    const duplicate = await oss.publish({ pairingId, ciphertext: Uint8Array.of(2), now: now + 1 })
    expect((await pool.query(
      'SELECT COUNT(*)::int AS count FROM remote_attachment_blobs WHERE database_identity = $1',
      [databaseIdentity],
    )).rows).toEqual([{ count: 2 }])
    const activeClaim = Buffer.alloc(32, 9)
    await pool.query(
      'UPDATE remote_attachment_objects SET claim_token = $2 WHERE database_identity = $1',
      [databaseIdentity, activeClaim],
    )
    await pool.query(
      `UPDATE remote_attachment_blobs SET claim_token = $2
        WHERE database_identity = $1 AND capability_digest IN (
          SELECT capability_digest FROM remote_attachment_objects WHERE database_identity = $1
        )`,
      [databaseIdentity, activeClaim],
    )

    await completeAttachmentStorageCutover(pool, databaseIdentity, 'oss', objectPrefix, CUTOVER_OPTIONS)
    expect((await pool.query(
      `SELECT legacy_authority FROM remote_attachment_objects
        WHERE database_identity = $1 ORDER BY expires_at`,
      [databaseIdentity],
    )).rows).toEqual([{ legacy_authority: true }])
    await pool.query(
      'UPDATE remote_attachment_objects SET claim_token = NULL WHERE database_identity = $1',
      [databaseIdentity],
    )
    await pool.query(
      'UPDATE remote_attachment_blobs SET claim_token = NULL WHERE database_identity = $1',
      [databaseIdentity],
    )
    await expect(oss.inspect({ pairingId, capability: legacyOnly.capability, now: now + 2 }))
      .resolves.toEqual(Uint8Array.of(1))
    await expect(oss.inspect({ pairingId, capability: duplicate.capability, now: now + 2 }))
      .resolves.toEqual(Uint8Array.of(2))

    const objectOnly = await oss.publish({ pairingId, ciphertext: Uint8Array.of(3), now: now + 3 })
    const persisted = await pool.query<{ blobs: number; objects: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM remote_attachment_blobs WHERE database_identity = $1) AS blobs,
         (SELECT COUNT(*)::int FROM remote_attachment_objects WHERE database_identity = $1) AS objects`,
      [databaseIdentity],
    )
    expect(persisted.rows).toEqual([{ blobs: 1, objects: 2 }])
    expect((await pool.query(
      'SELECT legacy_authority FROM remote_attachment_objects WHERE database_identity = $1 ORDER BY expires_at',
      [databaseIdentity],
    )).rows).toEqual([{ legacy_authority: false }, { legacy_authority: false }])
    await expect(oss.inspect({ pairingId, capability: objectOnly.capability, now: now + 4 }))
      .resolves.toEqual(Uint8Array.of(3))

    const refused = new PostgresRemoteAttachmentStore(refusedContext, databaseIdentity, pool, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 8,
      quotaCleanup: { release: async () => {} },
    })
    await expect(refused.migrate()).rejects.toThrow('OSS authority')
  }, 60_000)

  it('proves the fixed-base HTTP consumer must be drained before the atomic bridge contract', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    const pairingId = parsePersonalPairingId('pairing-fixed-base-overlap')
    const bridge = new PostgresRemoteAttachmentStore(context, 'attachment-fixed-base-overlap', pool, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 60_000,
      maxRetainedBlobs: 4,
      quotaCleanup: { release: async () => {} },
    })
    await bridge.migrate()
    const ciphertext = Uint8Array.of(8, 6, 7, 5)
    const grant = await bridge.publish({ pairingId, ciphertext, now: Date.now() })
    let reportInspected!: () => void
    const inspected = new Promise<void>((resolve) => { reportInspected = resolve })
    let releaseFixedBase!: () => void
    const fixedBaseMayWrite = new Promise<void>((resolve) => { releaseFixedBase = resolve })
    const artifact = await buildFixedBaseAttachmentHttp()
    cleanups.push(async () => { await artifact.dispose() })
    const inspect = bridge.inspect.bind(bridge)
    bridge.inspect = async (input) => {
      const value = await inspect(input)
      reportInspected()
      await fixedBaseMayWrite
      return value
    }
    const predecessorOrigin = await startAttachmentHttpWith(
      (context, config) => { artifact.apply(context, config) },
      bridge,
      { authenticate: async () => pairingId },
    )
    const fixedBaseResponse = fetch(`${predecessorOrigin}/v1/remote-attachments/consume`, {
      method: 'POST', body: JSON.stringify({ capability: grant.capability }),
    })
    await Promise.race([
      inspected,
      fixedBaseResponse.then(async (response) => {
        throw new Error(`fixed-base HTTP exited before inspect: ${String(response.status)} ${await response.clone().text()}`)
      }),
    ])

    const bridgeOrigin = await startAttachmentHttp(bridge, {
      authenticate: async () => ({
        pairingId,
        admit: async () => ({
          id: parseAttachmentBlobReservationId('fixed-base-unused'),
          expiresAt: Number.MAX_SAFE_INTEGER,
          release: async () => {},
        }),
      }),
    })
    const bridgeResponse = await fetch(`${bridgeOrigin}/v1/remote-attachments/consume`, {
      method: 'POST', body: JSON.stringify({ capability: grant.capability }),
    })
    releaseFixedBase()
    const oldResponse = await fixedBaseResponse

    const fixedBaseSource = await readFile(new URL('./fixtures/fixed-base-b2e93/http.ts.fixture', import.meta.url))
    expect(FIXED_BASE_ATTACHMENT_CONSUMER_SHA).toBe('b2e93d3c835043ffb204942bbfe122d67eb2ebae')
    expect(createHash('sha256').update(fixedBaseSource).digest('hex'))
      .toBe(FIXED_BASE_ATTACHMENT_HTTP_SOURCE_SHA256)
    expect([oldResponse.status, bridgeResponse.status]).toEqual([200, 200])
    expect(new Uint8Array(await oldResponse.arrayBuffer())).toEqual(ciphertext)
    expect(new Uint8Array(await bridgeResponse.arrayBuffer())).toEqual(ciphertext)

    await completeAttachmentStorageCutover(
      pool,
      'attachment-fixed-base-overlap',
      'bridge',
      'remote-attachments/fixed-base-overlap',
      CUTOVER_OPTIONS,
    )
    const atomicGrant = await bridge.publish({ pairingId, ciphertext, now: Date.now() })
    const firstOrigin = await startAttachmentHttp(bridge, {
      authenticate: async () => ({
        pairingId,
        admit: async () => ({
          id: parseAttachmentBlobReservationId('fixed-base-first'),
          expiresAt: Number.MAX_SAFE_INTEGER,
          release: async () => {},
        }),
      }),
    })
    const secondOrigin = await startAttachmentHttp(bridge, {
      authenticate: async () => ({
        pairingId,
        admit: async () => ({
          id: parseAttachmentBlobReservationId('fixed-base-second'),
          expiresAt: Number.MAX_SAFE_INTEGER,
          release: async () => {},
        }),
      }),
    })
    const atomicResponses = await Promise.all([firstOrigin, secondOrigin].map(async origin => await fetch(
      `${origin}/v1/remote-attachments/consume`,
      { method: 'POST', body: JSON.stringify({ capability: atomicGrant.capability }) },
    )))
    expect(atomicResponses.map(response => response.status).sort()).toEqual([200, 404])
  }, 60_000)

  it('holds the shared phase barrier until an active legacy response settles', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    const databaseIdentity = 'attachment-phase-barrier-fixture'
    const pairingId = parsePersonalPairingId('pairing-phase-barrier')
    const store = new PostgresRemoteAttachmentStore(context, databaseIdentity, pool, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 500,
      maxRetainedBlobs: 4,
      quotaCleanup: { release: async () => {} },
    })
    await store.migrate()
    const first = await store.publish({ pairingId, ciphertext: Uint8Array.of(1), now: Date.now() - 475 })
    const activeLegacy = await store.consume({
      pairingId,
      capability: first.capability,
      now: first.expiresAt - 1,
    })
    await delay(75)
    expect(Date.now()).toBeGreaterThanOrEqual(first.expiresAt)
    const second = await store.publish({ pairingId, ciphertext: Uint8Array.of(2), now: Date.now() })
    let cutoverFinished = false
    const cutover = completeAttachmentStorageCutover(
      pool,
      databaseIdentity,
      'bridge',
      'remote-attachments/phase-barrier',
      CUTOVER_OPTIONS,
    ).then(() => { cutoverFinished = true })
    await delay(50)
    expect(cutoverFinished).toBe(false)
    let crossingFinished = false
    const crossing = store.consume({ pairingId, capability: second.capability, now: Date.now() })
      .then((consumption) => { crossingFinished = true; return consumption })
    await delay(50)
    expect(crossingFinished).toBe(false)

    await activeLegacy.complete()
    await cutover
    const atomic = await crossing
    expect(atomic.ciphertext).toEqual(Uint8Array.of(2))
    let loser: unknown = 'fulfilled'
    try {
      await store.consume({ pairingId, capability: second.capability, now: Date.now() })
    } catch (error: unknown) {
      loser = error
    }
    expect(loser).toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
    await atomic.complete()
  }, 60_000)

  it.each(['delete-fail', 'commit-unknown', 'crash'] as const)(
    'does not redeliver a legacy response after %s leaves settlement uncertain',
    async (failure) => {
      const postgres = await startPostgresFixture()
      const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
      cleanups.push(async () => { await pool.end() })
      const context = new Context()
      const bridgeContext = new Context()
      cleanups.push(async () => { await context.fiber.dispose(); await bridgeContext.fiber.dispose() })
      const databaseIdentity = `attachment-legacy-uncertain-${failure}`
      const pairingId = parsePersonalPairingId(`pairing-legacy-uncertain-${failure}`)
      const reservationId = parseAttachmentBlobReservationId(`quota-legacy-uncertain-${failure}`)
      const fault = legacySettlementFaultPool(pool, failure)
      const store = new PostgresRemoteAttachmentStore(context, databaseIdentity, fault.pool, {
        maxBlobBytes: 1024,
        capabilityLifetimeMs: 60_000,
        maxRetainedBlobs: 4,
        quotaCleanup: { release: async () => {} },
      })
      await store.migrate()
      const grant = await store.publish({
        pairingId,
        ciphertext: Uint8Array.of(4, 9),
        now: Date.now(),
        quota: { id: reservationId, expiresAt: Number.MAX_SAFE_INTEGER, release: async () => {} },
      })
      fault.arm()
      const delivered = await store.consume({ pairingId, capability: grant.capability, now: Date.now() })
      expect(delivered.ciphertext).toEqual(Uint8Array.of(4, 9))
      if (failure === 'crash') {
        await pool.query('SELECT pg_terminate_backend($1)', [await fault.legacyBackendPid])
      } else {
        await expect(delivered.complete()).rejects.toThrow(failure)
      }

      const uncertain = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM remote_attachment_blobs WHERE database_identity = $1) AS blobs,
           (SELECT COUNT(*)::int FROM remote_attachment_legacy_deliveries WHERE database_identity = $1) AS deliveries`,
        [databaseIdentity],
      )
      expect(uncertain.rows).toEqual([{ blobs: 1, deliveries: 1 }])
      const released: string[] = []
      let releaseAttempts = 0
      const cutover = async (): Promise<void> => {
        await completeAttachmentStorageCutover(
          pool,
          databaseIdentity,
          'bridge',
          `remote-attachments/${failure}`,
          {
            maxBlobBytes: 1024,
            quotaCleanup: {
              release: async (id) => {
                releaseAttempts += 1
                if (failure === 'commit-unknown' && releaseAttempts === 1) {
                  throw new Error('quota release unavailable')
                }
                released.push(id)
              },
            },
          },
        )
      }
      if (failure === 'commit-unknown') {
        await expect(cutover()).rejects.toThrow('quota release unavailable')
        expect((await pool.query(
          'SELECT phase FROM remote_attachment_storage_phase WHERE database_identity = $1',
          [databaseIdentity],
        )).rows).toEqual([{ phase: 'bridge' }])
        await expect(cutover()).resolves.toBeUndefined()
      } else {
        await expect(cutover()).resolves.toBeUndefined()
      }
      const bridge = new PostgresRemoteAttachmentStore(bridgeContext, databaseIdentity, pool, {
        maxBlobBytes: 1024,
        capabilityLifetimeMs: 60_000,
        maxRetainedBlobs: 4,
        quotaCleanup: { release: async () => {} },
      })
      await expect(bridge.consume({ pairingId, capability: grant.capability, now: Date.now() }))
        .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
      const retained = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM remote_attachment_blobs WHERE database_identity = $1) AS blobs,
           (SELECT COUNT(*)::int FROM remote_attachment_legacy_deliveries WHERE database_identity = $1) AS deliveries,
           (SELECT COUNT(*)::int FROM remote_attachment_quota_releases WHERE database_identity = $1) AS releases`,
        [databaseIdentity],
      )
      expect(retained.rows).toEqual([{ blobs: 0, deliveries: 0, releases: 0 }])
      expect(released).toEqual([reservationId])
    },
    60_000,
  )

  it.each([
    'expired-consume',
    'complete',
    'expired-abandon',
    'revoke',
    'expired-inspect',
  ] as const)('retains a retryable quota release after %s metadata removal', async (operation) => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    const databaseIdentity = `attachment-quota-outbox-${operation}`
    const pairingId = parsePersonalPairingId(`pairing-quota-outbox-${operation}`)
    const reservationId = parseAttachmentBlobReservationId(`quota-outbox-${operation}`)
    let cleanupUnavailable = false
    const failedCleanup = vi.fn(async () => {
      if (cleanupUnavailable) throw new Error('quota cleanup unavailable')
    })
    const store = new PostgresRemoteAttachmentStore(context, databaseIdentity, pool, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 100,
      maxRetainedBlobs: 4,
      quotaCleanup: { release: failedCleanup },
    })
    await store.migrate()
    await completeAttachmentStorageCutover(
      pool,
      databaseIdentity,
      'bridge',
      `remote-attachments/quota-outbox-${operation}`,
      { maxBlobBytes: 1024, quotaCleanup: { release: async () => {} } },
    )
    const grant = await store.publish({
      pairingId,
      ciphertext: Uint8Array.of(7),
      now: 100,
      quota: { id: reservationId, expiresAt: Number.MAX_SAFE_INTEGER, release: async () => {} },
    })
    cleanupUnavailable = true

    let removal: Promise<unknown>
    switch (operation) {
      case 'expired-consume':
        removal = store.consume({ pairingId, capability: grant.capability, now: 200 })
        break
      case 'complete': {
        const consumption = await store.consume({ pairingId, capability: grant.capability, now: 101 })
        removal = consumption.complete()
        break
      }
      case 'expired-abandon': {
        const consumption = await store.consume({ pairingId, capability: grant.capability, now: 101 })
        removal = consumption.abandon(200)
        break
      }
      case 'revoke':
        removal = store.revoke({ pairingId, capability: grant.capability })
        break
      case 'expired-inspect':
        removal = store.inspect({ pairingId, capability: grant.capability, now: 200 })
        break
    }
    await expect(removal).rejects.toThrow('quota cleanup unavailable')

    const capabilityDigest = createHash('sha256').update(grant.capability).digest()
    const retained = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM remote_attachment_blobs
           WHERE database_identity = $1 AND capability_digest = $2) AS blobs,
         (SELECT COUNT(*)::int FROM remote_attachment_quota_releases
           WHERE database_identity = $1 AND reservation_id = $3) AS releases`,
      [databaseIdentity, capabilityDigest, reservationId],
    )
    expect(retained.rows).toEqual([{ blobs: 0, releases: 1 }])
    expect(failedCleanup).toHaveBeenCalledTimes(1)

    const recovered: string[] = []
    await releasePendingAttachmentQuota(pool, databaseIdentity, {
      release: async (id) => { recovered.push(id) },
    })
    expect(recovered).toEqual([reservationId])
    expect((await pool.query(
      'SELECT COUNT(*)::int AS count FROM remote_attachment_quota_releases WHERE database_identity = $1',
      [databaseIdentity],
    )).rows).toEqual([{ count: 0 }])
  }, 60_000)

  it('returns a committed publish while retaining failed retired-quota cleanup for the next operation', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    const databaseIdentity = 'attachment-publish-quota-outbox'
    const pairingId = parsePersonalPairingId('pairing-publish-quota-outbox')
    const reservationId = parseAttachmentBlobReservationId('quota-publish-outbox')
    let cleanupAttempts = 0
    const store = new PostgresRemoteAttachmentStore(context, databaseIdentity, pool, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 100,
      maxRetainedBlobs: 4,
      quotaCleanup: {
        release: async () => {
          cleanupAttempts += 1
          if (cleanupAttempts === 1) throw new Error('quota cleanup unavailable')
        },
      },
    })
    await store.migrate()
    await completeAttachmentStorageCutover(
      pool,
      databaseIdentity,
      'bridge',
      'remote-attachments/publish-quota-outbox',
      { maxBlobBytes: 1024, quotaCleanup: { release: async () => {} } },
    )
    await store.publish({
      pairingId,
      ciphertext: Uint8Array.of(1),
      now: 100,
      quota: { id: reservationId, expiresAt: Number.MAX_SAFE_INTEGER, release: async () => {} },
    })

    const grant = await store.publish({ pairingId, ciphertext: Uint8Array.of(2), now: 200 })
    expect(grant).toMatchObject({ byteLength: 1, expiresAt: 300 })
    expect((await pool.query(
      'SELECT reservation_id FROM remote_attachment_quota_releases WHERE database_identity = $1',
      [databaseIdentity],
    )).rows).toEqual([{ reservation_id: reservationId }])

    const consumption = await store.consume({ pairingId, capability: grant.capability, now: 201 })
    expect(consumption.ciphertext).toEqual(Uint8Array.of(2))
    expect(cleanupAttempts).toBe(2)
    expect((await pool.query(
      'SELECT COUNT(*)::int AS count FROM remote_attachment_quota_releases WHERE database_identity = $1',
      [databaseIdentity],
    )).rows).toEqual([{ count: 0 }])
    await consumption.complete()
  }, 60_000)

  it.each([
    'crash-after-intent',
    'intent-rollback-readback-fail',
    'main-rollback-readback-fail',
    'main-committed-readback-fail',
  ] as const)('reconciles PostgreSQL publish fencing after %s', async (failure) => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const firstContext = new Context()
    const restartContext = new Context()
    cleanups.push(async () => { await firstContext.fiber.dispose(); await restartContext.fiber.dispose() })
    const databaseIdentity = `attachment-publish-fence-${failure}`
    const pairingId = parsePersonalPairingId(`pairing-publish-fence-${failure}`)
    const reservationId = parseAttachmentBlobReservationId(`quota-publish-fence-${failure}`)
    const fault = postgresPublishFaultPool(pool, failure)
    const first = new PostgresRemoteAttachmentStore(firstContext, databaseIdentity, fault, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 100,
      maxRetainedBlobs: 2,
      quotaCleanup: { release: async () => {} },
    })
    await first.migrate()
    await completeAttachmentStorageCutover(
      pool,
      databaseIdentity,
      'bridge',
      `remote-attachments/publish-fence-${failure}`,
      { maxBlobBytes: 1024, quotaCleanup: { release: async () => {} } },
    )
    await expect(first.publish({
      pairingId,
      ciphertext: Uint8Array.of(3),
      now: 100,
      quota: { id: reservationId, expiresAt: Number.MAX_SAFE_INTEGER, release: async () => {} },
    })).rejects.toThrow('PostgreSQL attachment publish outcome is uncertain')

    const beforeRestart = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM remote_attachment_postgres_publish_intents
           WHERE database_identity = $1) AS intents,
         (SELECT COUNT(*)::int FROM remote_attachment_blobs
           WHERE database_identity = $1) AS blobs`,
      [databaseIdentity],
    )
    expect(beforeRestart.rows).toEqual([failure === 'main-committed-readback-fail'
      ? { intents: 0, blobs: 1 }
      : { intents: 1, blobs: 0 }])

    const released: string[] = []
    const restarted = new PostgresRemoteAttachmentStore(restartContext, databaseIdentity, pool, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 100,
      maxRetainedBlobs: 2,
      quotaCleanup: { release: async (id) => { released.push(id) } },
    })
    await restarted.migrate()
    if (failure === 'main-committed-readback-fail') {
      expect(released).toEqual([])
      await restarted.publish({ pairingId, ciphertext: Uint8Array.of(4), now: 200 })
    }
    expect(released).toEqual([reservationId])
    expect((await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM remote_attachment_postgres_publish_intents
           WHERE database_identity = $1) AS intents,
         (SELECT COUNT(*)::int FROM remote_attachment_quota_releases
           WHERE database_identity = $1) AS releases`,
      [databaseIdentity],
    )).rows).toEqual([{ intents: 0, releases: 0 }])
  }, 60_000)

  it('expires durable Account quota after recovery INSERT rollback, unreadable outcome, and cleanup failure', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const databaseIdentity = 'attachment-recovery-lease-fixture'
    const pairingState = new PostgresPersonalPairingAuthorityStore(databaseIdentity, pool)
    await pairingState.migrate()
    const now = { value: 100 }
    const firstContext = new Context()
    const restartContext = new Context()
    cleanups.push(async () => { await firstContext.fiber.dispose(); await restartContext.fiber.dispose() })
    const accountId = parsePlatformAccountId('account-recovery-lease')
    const installationId = parseInstallationId('desktop-recovery-lease')
    const owner = {
      accessToken: 'recovery-lease-access',
      proof: { jti: parseAccountProofJti('recovery-lease-proof'), issuedAt: 1, signature: 'signature' },
    }
    const providerOptions = {
      account: { currentInstallation: async () => ({
        account: { id: accountId, githubId: 1, githubLogin: 'recovery', avatarUrl: 'https://avatars.example/recovery' },
        installation: { id: installationId, kind: 'desktop' as const,
          presentation: { name: 'Recovery Desktop', platform: 'linux' as const } },
      }) },
      handshake: disabledPairingHandshake(),
      authority: pairingState,
      clock: { now: () => now.value },
      attachmentReservationLifetimeMs: 100,
      pairingLinkOrigin: 'https://platform.example/pair',
    }
    const firstProvider = new PersonalPairingProvider(firstContext, providerOptions)
    const reservation = await firstProvider.admitAttachmentBlob({ owner, bytes: 1 })
    expect(reservation.expiresAt).toBe(200)
    const cleanup = vi.fn(async () => { throw new Error('quota cleanup unavailable') })
    const store = new PostgresRemoteAttachmentStore(
      firstContext,
      databaseIdentity,
      postgresPublishFaultPool(pool, 'recovery-rollback-readback-fail'),
      {
        maxBlobBytes: 1024,
        capabilityLifetimeMs: 100,
        maxRetainedBlobs: 2,
        quotaCleanup: { release: async () => {} },
      },
    )
    await store.migrate()
    await expect(store.publish({
      pairingId: parsePersonalPairingId('pairing-recovery-lease'),
      ciphertext: Uint8Array.of(5),
      now: 100,
      quota: { id: reservation.reservationId, expiresAt: reservation.expiresAt, release: cleanup },
    })).rejects.toThrow('PostgreSQL attachment publish outcome is uncertain')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(await pairingState.runPairingTransaction(
      state => Promise.resolve(state.blobs.has(reservation.reservationId)),
    )).toBe(true)
    expect((await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM remote_attachment_postgres_publish_intents
           WHERE database_identity = $1) AS intents,
         (SELECT COUNT(*)::int FROM remote_attachment_blobs WHERE database_identity = $1) AS blobs,
         (SELECT COUNT(*)::int FROM remote_attachment_quota_releases
           WHERE database_identity = $1) AS releases`,
      [databaseIdentity],
    )).rows).toEqual([{ intents: 0, blobs: 0, releases: 0 }])

    await firstContext.fiber.dispose()
    now.value = 200
    const restarted = new PersonalPairingProvider(restartContext, providerOptions)
    await restarted.admitAttachmentBlob({ owner, bytes: 1 })
    expect(await pairingState.runPairingTransaction(
      state => Promise.resolve(state.blobs.has(reservation.reservationId)),
    )).toBe(false)
  }, 60_000)

  it('claims one OSS capability atomically across operated Platform instances', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const firstContext = new Context()
    const secondContext = new Context()
    cleanups.push(async () => { await firstContext.fiber.dispose(); await secondContext.fiber.dispose() })
    const pairing = parsePersonalPairingId('pairing-atomic-oss')
    const objects = new Map<string, Uint8Array>()
    const options = {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 4,
      objectPrefix: 'remote-attachments/atomic-fixture',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 2,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async () => {} },
      inactivePairingIds: async () => [],
    }
    const first = new OssRemoteAttachmentStore(firstContext, 'attachment-atomic-fixture', pool, memoryOssClient(objects), options)
    const second = new OssRemoteAttachmentStore(secondContext, 'attachment-atomic-fixture', pool, memoryOssClient(objects), options)
    await prepareBridgePhase(pool, 'attachment-atomic-fixture', options.objectPrefix)
    await first.migrate()
    const grant = await first.publish({ pairingId: pairing, ciphertext: Uint8Array.of(5, 6), now: 100 })

    const results = await Promise.allSettled([
      first.consume({ pairingId: pairing, capability: grant.capability, now: 101 }),
      second.consume({ pairingId: pairing, capability: grant.capability, now: 101 }),
    ])
    const winners = results.filter(result => result.status === 'fulfilled')
    const losers = results.filter(result => result.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ reason: { code: 'ATTACHMENT_CAPABILITY_INVALID' } })
    if (winners[0]?.status !== 'fulfilled') throw new Error('one OSS consumer must win')
    expect(winners[0].value.ciphertext).toEqual(Uint8Array.of(5, 6))
    await winners[0].value.complete()
  }, 60_000)

  it('actively sweeps expired and pairing-revoked OSS blobs and releases their quota reservations', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    const pairingA = parsePersonalPairingId('pairing-sweep-a')
    const pairingB = parsePersonalPairingId('pairing-sweep-b')
    const pairingC = parsePersonalPairingId('pairing-sweep-c')
    let active = [pairingA, pairingB]
    let now = 100
    const ticks: Array<() => void> = []
    const objects = new Map<string, Uint8Array>()
    const released: string[] = []
    const sweepCandidates: Array<readonly string[]> = []
    let releaseCandidateSnapshot!: () => void
    const candidateSnapshotReleased = new Promise<void>((resolve) => { releaseCandidateSnapshot = resolve })
    let reportCandidateSnapshot!: () => void
    const candidateSnapshotReported = new Promise<void>((resolve) => { reportCandidateSnapshot = resolve })
    const store = new OssRemoteAttachmentStore(context, 'attachment-sweep-fixture', pool, memoryOssClient(objects), {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 10,
      maxRetainedBlobs: 4,
      objectPrefix: 'remote-attachments/sweep-fixture',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 2,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async (reservationId) => { released.push(reservationId) } },
      inactivePairingIds: async (candidates) => {
        sweepCandidates.push(candidates)
        if (candidates.length === 2) {
          reportCandidateSnapshot()
          await candidateSnapshotReleased
        }
        return candidates.filter(pairingId => !active.includes(pairingId))
      },
      clock: { now: () => now },
      schedule: (handler) => {
        ticks.push(handler)
        return { unref: () => {}, cancel: () => {} }
      },
    })
    await prepareBridgePhase(pool, 'attachment-sweep-fixture', 'remote-attachments/sweep-fixture')
    await store.migrate()
    await store.publish({
      pairingId: pairingA, ciphertext: Uint8Array.of(1), now,
      quota: {
        id: parseAttachmentBlobReservationId('quota-sweep-a'),
        expiresAt: Number.MAX_SAFE_INTEGER,
        release: async () => {},
      },
    })
    await store.publish({
      pairingId: pairingB, ciphertext: Uint8Array.of(2), now,
      quota: {
        id: parseAttachmentBlobReservationId('quota-sweep-b'),
        expiresAt: Number.MAX_SAFE_INTEGER,
        release: async () => {},
      },
    })

    active = [pairingA]
    ticks[0]?.()
    await candidateSnapshotReported
    await store.publish({ pairingId: pairingC, ciphertext: Uint8Array.of(3), now })
    releaseCandidateSnapshot()
    await vi.waitFor(async () => { expect(await store.observe()).toHaveLength(2) })
    expect(sweepCandidates).toContainEqual([pairingA, pairingB])
    await vi.waitFor(() => { expect(released).toContain('quota-sweep-b') })
    now = 110
    await vi.waitFor(() => { expect(ticks).toHaveLength(2) })
    ticks[1]?.()
    await vi.waitFor(async () => { expect(await store.observe()).toHaveLength(0) })
    await vi.waitFor(() => { expect(released).toEqual(expect.arrayContaining(['quota-sweep-a', 'quota-sweep-b'])) })
    expect(objects.size).toBe(0)
  }, 60_000)

  it('reconciles an expired durable publish intent after a process restart', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const firstContext = new Context()
    const secondContext = new Context()
    cleanups.push(async () => { await firstContext.fiber.dispose(); await secondContext.fiber.dispose() })
    const objects = new Map<string, Uint8Array>()
    const prefix = 'remote-attachments/intent-restart'
    const digest = Buffer.alloc(32, 7)
    const objectKey = `${prefix}/${digest.toString('hex')}`
    const first = new OssRemoteAttachmentStore(firstContext, 'intent-restart-fixture', pool, memoryOssClient(objects), {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 10,
      maxRetainedBlobs: 4,
      objectPrefix: prefix,
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 1,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async () => {} },
      inactivePairingIds: async () => [],
      clock: { now: () => 100 },
      schedule: () => ({ unref: () => {}, cancel: () => {} }),
    })
    await prepareBridgePhase(pool, 'intent-restart-fixture', prefix)
    await first.migrate()
    objects.set(objectKey, Uint8Array.of(4, 2))
    await pool.query(
      `INSERT INTO remote_attachment_publish_intents (
         database_identity, capability_digest, pairing_id, object_key, byte_length, expires_at, quota_reservation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ['intent-restart-fixture', digest, 'pairing-intent-restart', objectKey, 2, 110, 'quota-intent-restart'],
    )
    await firstContext.fiber.dispose()

    const released: string[] = []
    const second = new OssRemoteAttachmentStore(secondContext, 'intent-restart-fixture', pool, memoryOssClient(objects), {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 10,
      maxRetainedBlobs: 4,
      objectPrefix: prefix,
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 1,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async (reservationId) => { released.push(reservationId) } },
      inactivePairingIds: async () => [],
      clock: { now: () => 111 },
      schedule: () => ({ unref: () => {}, cancel: () => {} }),
    })
    await second.migrate()

    await vi.waitFor(() => { expect(objects.has(objectKey)).toBe(false) })
    await vi.waitFor(() => { expect(released).toEqual(['quota-intent-restart']) })
    const intent = await pool.query(
      'SELECT capability_digest FROM remote_attachment_publish_intents WHERE database_identity = $1',
      ['intent-restart-fixture'],
    )
    expect(intent.rows).toHaveLength(0)
  }, 60_000)

  it('waits for an active durable sweep before store disposal becomes quiescent', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const context = new Context()
    const pairingId = parsePersonalPairingId('pairing-sweep-dispose')
    let tick!: () => void
    let blockSweep = false
    let reportBlocked!: () => void
    const blocked = new Promise<void>((resolve) => { reportBlocked = resolve })
    let releaseSweep!: () => void
    const sweepReleased = new Promise<void>((resolve) => { releaseSweep = resolve })
    const store = new OssRemoteAttachmentStore(context, 'sweep-dispose-fixture', pool, memoryOssClient(), {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 4,
      objectPrefix: 'remote-attachments/sweep-dispose',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 1,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async () => {} },
      inactivePairingIds: async () => {
        if (blockSweep) { reportBlocked(); await sweepReleased }
        return []
      },
      schedule: (handler) => { tick = handler; return { unref: () => {}, cancel: () => {} } },
    })
    await prepareBridgePhase(pool, 'sweep-dispose-fixture', 'remote-attachments/sweep-dispose')
    await store.migrate()
    await store.publish({ pairingId, ciphertext: Uint8Array.of(1), now: 100 })
    blockSweep = true
    tick()
    await blocked
    let disposed = false
    const disposing = context.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseSweep()
    await disposing
    expect(disposed).toBe(true)
  }, 60_000)

  it('does not make a publish wait for expired OSS object deletion', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    const pairing = parsePersonalPairingId('pairing-nonblocking-cleanup')
    const objects = new Map<string, Uint8Array>()
    let unblockDelete: (() => void) | undefined
    const blockedDelete = new Promise<void>((resolve) => { unblockDelete = resolve })
    let firstDelete = true
    let deletionStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { deletionStarted = resolve })
    const base = memoryOssClient(objects)
    const objectClient: OssObjectClient = {
      ...base,
      deleteObject: async (key) => {
        if (firstDelete) {
          firstDelete = false
          deletionStarted?.()
          await blockedDelete
        }
        objects.delete(key)
      },
    }
    const store = new OssRemoteAttachmentStore(context, 'attachment-nonblocking-fixture', pool, objectClient, {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 10,
      maxRetainedBlobs: 4,
      objectPrefix: 'remote-attachments/nonblocking-fixture',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 1,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async () => {} },
      inactivePairingIds: async () => [],
      clock: { now: () => 100 },
      schedule: () => ({ unref: () => {}, cancel: () => {} }),
    })
    await prepareBridgePhase(pool, 'attachment-nonblocking-fixture', 'remote-attachments/nonblocking-fixture')
    await store.migrate()
    await store.publish({ pairingId: pairing, ciphertext: Uint8Array.of(1), now: 100 })
    const replacement = await store.publish({ pairingId: pairing, ciphertext: Uint8Array.of(2), now: 110 })

    expect(replacement.byteLength).toBe(1)
    await started
    expect(objects.size).toBe(2)
    unblockDelete?.()
    await vi.waitFor(() => { expect(objects.size).toBe(1) })
  }, 60_000)

  it('shares OSS ciphertext through PostgreSQL one-time capability authority', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const firstContext = new Context()
    const secondContext = new Context()
    cleanups.push(async () => { await firstContext.fiber.dispose(); await secondContext.fiber.dispose() })
    const objects = new Map<string, Uint8Array>()
    const objectClient = memoryOssClient(objects)
    const options = {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 1,
      objectPrefix: 'remote-attachments/fixture',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 2,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async () => {} },
      inactivePairingIds: async () => [],
    }
    const first = new OssRemoteAttachmentStore(firstContext, 'oss-fixture', pool, objectClient, options)
    const second = new OssRemoteAttachmentStore(secondContext, 'oss-fixture', pool, objectClient, options)
    await prepareBridgePhase(pool, 'oss-fixture', options.objectPrefix)
    await first.migrate()
    const pairing = parsePersonalPairingId('pairing-shared-oss')
    const otherPairing = parsePersonalPairingId('pairing-other-oss')
    const grant = await first.publish({ pairingId: pairing, ciphertext: Uint8Array.of(1, 2, 3), now: 100 })

    await expect(second.inspect({ pairingId: otherPairing, capability: grant.capability, now: 101 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PAIRING_MISMATCH' })
    await expect(second.publish({ pairingId: pairing, ciphertext: Uint8Array.of(4), now: 101 }))
      .rejects.toMatchObject({ code: 'PLATFORM_CAPACITY', retryAfter: 1 })
    expect(objects.size).toBe(1)
    const consumed = await second.consume({ pairingId: pairing, capability: grant.capability, now: 102 })
    expect(consumed.ciphertext).toEqual(Uint8Array.of(1, 2, 3))
    await consumed.complete()
    await expect(first.consume({ pairingId: pairing, capability: grant.capability, now: 103 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
    expect(objects.size).toBe(0)

    const expired = await second.publish({ pairingId: pairing, ciphertext: Uint8Array.of(5), now: 200 })
    await expect(first.inspect({ pairingId: pairing, capability: expired.capability, now: 1_200 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' })
    expect(objects.size).toBe(0)
    await expect(second.inspect({ pairingId: pairing, capability: expired.capability, now: 1_201 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })

    const expiredConsume = await first.publish({ pairingId: pairing, ciphertext: Uint8Array.of(6), now: 300 })
    await expect(second.consume({ pairingId: pairing, capability: expiredConsume.capability, now: 1_300 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' })
    expect(objects.size).toBe(0)
    await expect(first.inspect({ pairingId: pairing, capability: expiredConsume.capability, now: 1_301 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
  }, 60_000)

  it('shares single-use encrypted attachment capabilities across Platform instances', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const firstContext = new Context()
    const secondContext = new Context()
    cleanups.push(async () => { await firstContext.fiber.dispose(); await secondContext.fiber.dispose() })
    const options = {
      maxBlobBytes: 1024, capabilityLifetimeMs: 1_000, maxRetainedBlobs: 1,
      quotaCleanup: { release: async () => {} },
    }
    const first = new PostgresRemoteAttachmentStore(firstContext, 'attachment-fixture', pool, options)
    const second = new PostgresRemoteAttachmentStore(secondContext, 'attachment-fixture', pool, options)
    await first.migrate()
    await completeAttachmentStorageCutover(
      pool,
      'attachment-fixture',
      'bridge',
      'remote-attachments/postgres-fixture',
      CUTOVER_OPTIONS,
    )
    const pairing = parsePersonalPairingId('pairing-shared-attachment')
    const otherPairing = parsePersonalPairingId('pairing-other-attachment')
    const grant = await first.publish({ pairingId: pairing, ciphertext: Uint8Array.of(1, 2, 3), now: 100 })

    await expect(second.inspect({ pairingId: otherPairing, capability: grant.capability, now: 101 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PAIRING_MISMATCH' })
    await expect(second.publish({ pairingId: pairing, ciphertext: Uint8Array.of(4), now: 101 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPACITY' })
    const initialConsumption = await second.consume({ pairingId: pairing, capability: grant.capability, now: 101 })
    expect(initialConsumption.ciphertext).toEqual(Uint8Array.of(1, 2, 3))
    await initialConsumption.complete()
    await expect(first.consume({ pairingId: pairing, capability: grant.capability, now: 102 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
    const retryGrant = await first.publish({ pairingId: pairing, ciphertext: Uint8Array.of(9), now: 125 })
    const failedDelivery = await first.consume({ pairingId: pairing, capability: retryGrant.capability, now: 126 })
    await failedDelivery.abandon(127)
    const retriedDelivery = await second.consume({ pairingId: pairing, capability: retryGrant.capability, now: 128 })
    expect(retriedDelivery.ciphertext).toEqual(Uint8Array.of(9))
    await retriedDelivery.complete()
    const contested = await first.publish({ pairingId: pairing, ciphertext: Uint8Array.of(6), now: 150 })
    const consumers = await Promise.allSettled([
      first.consume({ pairingId: pairing, capability: contested.capability, now: 151 }),
      second.consume({ pairingId: pairing, capability: contested.capability, now: 151 }),
    ])
    expect(consumers.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(consumers.filter(result => result.status === 'rejected')).toHaveLength(1)
    const contestedConsumption = consumers.find(result => result.status === 'fulfilled')
    if (contestedConsumption?.status !== 'fulfilled') throw new Error('concurrent consume had no winner')
    await contestedConsumption.value.complete()
    const publishers = await Promise.allSettled([
      first.publish({ pairingId: pairing, ciphertext: Uint8Array.of(7), now: 175 }),
      second.publish({ pairingId: pairing, ciphertext: Uint8Array.of(8), now: 175 }),
    ])
    expect(publishers.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(publishers.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM remote_attachment_blobs WHERE database_identity = $1) AS blobs,
         (SELECT COUNT(*)::int FROM remote_attachment_postgres_publish_intents
           WHERE database_identity = $1) AS intents`,
      ['attachment-fixture'],
    )).rows).toEqual([{ blobs: 1, intents: 0 }])
    const capacityGrant = publishers.find(result => result.status === 'fulfilled')
    if (capacityGrant?.status !== 'fulfilled') throw new Error('concurrent capacity did not retain one blob')
    const capacityConsumption = await first.consume({
      pairingId: pairing,
      capability: capacityGrant.value.capability,
      now: 176,
    })
    await capacityConsumption.complete()
    const expired = await second.publish({ pairingId: pairing, ciphertext: Uint8Array.of(5), now: 200 })
    await expect(first.inspect({ pairingId: pairing, capability: expired.capability, now: 1_200 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' })
  }, 60_000)

  it('uploads to OSS on one operated HTTP instance and admits one concurrent consume across two instances', async () => {
    const postgres = await startPostgresFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    cleanups.push(async () => { await pool.end() })
    const firstContext = new Context()
    const secondContext = new Context()
    cleanups.push(async () => { await firstContext.fiber.dispose(); await secondContext.fiber.dispose() })
    const pairings = new PostgresPersonalPairingAuthorityStore('attachment-http-fixture', pool)
    await pairings.migrate()
    const accountId = parsePlatformAccountId('account-attachment-http')
    const mobileInstallationId = parseInstallationId('mobile-attachment-http')
    const pairingId = parsePersonalPairingId('pairing-attachment-http')
    const objects = new Map<string, Uint8Array>()
    const quotaReleases: string[] = []
    const options = {
      maxBlobBytes: 1024,
      capabilityLifetimeMs: 1_000,
      maxRetainedBlobs: 4,
      objectPrefix: 'remote-attachments/http-fixture',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 2,
      capacityRetryAfterSeconds: 1,
      quotaCleanup: { release: async (reservationId: string) => { quotaReleases.push(reservationId) } },
      inactivePairingIds: async () => [],
    }
    const first = new OssRemoteAttachmentStore(
      firstContext, 'attachment-http-fixture', pool, memoryOssClient(objects), options,
    )
    const second = new OssRemoteAttachmentStore(
      secondContext, 'attachment-http-fixture', pool, memoryOssClient(objects), options,
    )
    await prepareBridgePhase(pool, 'attachment-http-fixture', options.objectPrefix)
    await first.migrate()
    await pairings.confirmMobilePairing({
      accountId,
      desktopInstallationId: parseInstallationId('desktop-attachment-http'),
      mobileInstallationId,
      pendingPairingId: parsePendingPairingId('pending-attachment-http'),
      pairingId,
      credentialFingerprint: parseRelayCredentialFingerprint('credential-attachment-http'),
      lastAccessAt: 1,
      sealedRelayAuthority: Uint8Array.of(9),
    })
    await expect(pairings.filterConfirmedPairingIds([
      pairingId,
      parsePersonalPairingId('pairing-attachment-missing'),
    ])).resolves.toEqual([pairingId])
    const account = {
      currentInstallation: vi.fn(async () => ({
        account: { id: accountId, githubId: 1, githubLogin: 'fixture', avatarUrl: 'https://avatars.example/fixture' },
        installation: { id: mobileInstallationId, kind: 'mobile' as const,
          presentation: { name: 'Real phone', platform: 'ios' as const } },
      })),
    }
    const authority = new OperatedRemoteAttachmentAuthority(account, pairings, {
      admitAttachmentBlob: async () => ({
        reservationId: parseAttachmentBlobReservationId('attachment-http-quota'),
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
      releaseAttachmentBlob: async () => {},
    })
    const firstOrigin = await startAttachmentHttp(first, authority)
    const secondOrigin = await startAttachmentHttp(second, authority)
    const headers = {
      authorization: 'Bearer current-access',
      'x-gestalt-proof-jti': 'proof-http',
      'x-gestalt-proof-issued-at': '1234',
      'x-gestalt-proof-signature': 'signature-http',
      'x-gestalt-pairing-selector': pairingId,
    }
    const ciphertext = Uint8Array.of(11, 22, 33, 44)
    const uploaded = await fetch(`${firstOrigin}/v1/remote-attachments`, {
      method: 'POST', headers, body: ciphertext,
    })
    expect(uploaded.status).toBe(201)
    const grant = await uploaded.json() as { capability: string }
    const consumeRequest = (origin: string): Promise<Response> => fetch(`${origin}/v1/remote-attachments/consume`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: grant.capability }),
    })
    const consumed = await Promise.all([consumeRequest(firstOrigin), consumeRequest(secondOrigin)])
    const statuses = consumed.map(response => response.status).sort()
    if (statuses[0] !== 200 || statuses[1] !== 404) {
      throw new Error(`operated attachment consume statuses ${statuses.join(',')}: ${
        (await Promise.all(consumed.map(async response => await response.clone().text()))).join(' | ')}`)
    }
    const winner = consumed.find(response => response.status === 200)
    if (winner === undefined) throw new Error('one operated HTTP consume must win')
    expect(new Uint8Array(await winner.arrayBuffer())).toEqual(ciphertext)
    await expect(pairings.ownsConfirmedPairing(accountId, mobileInstallationId, pairingId)).resolves.toBe(true)
    await vi.waitFor(() => { expect(quotaReleases).toEqual(['attachment-http-quota']) })
    expect(objects.size).toBe(0)
    expect(account.currentInstallation).toHaveBeenCalledTimes(3)
  }, 60_000)

  it('launches the product composition with GitHub OAuth, PostgreSQL authority, and Redis coordination', async () => {
    const postgres = await startPostgresFixture()
    const redis = await startRedisFixture()
    const pool = new pg.Pool({ host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres' })
    const postgresConfigs: unknown[] = []
    const redisConfigs: unknown[] = []
    const githubFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'github-fixture-token', scope: '' }))
      .mockResolvedValueOnce(json({
        id: 298347,
        login: 'durable-fixture-account',
        avatar_url: 'https://avatars.example/durable-fixture-account',
      }))
    await prepareBridgePhase(pool, 'product-entry-fixture', 'remote-attachments/fixture')
    const running = await launchOperatedPlatform({
      env: operatedFixtureEnv(),
      publicIndex: join(import.meta.dirname, '..', 'public', 'index.html'),
      adapters: {
        createPostgres(config) {
          postgresConfigs.push(config)
          return pool
        },
        async connectRedis(config) {
          redisConfigs.push(config)
          return await connectRedis({
            host: '127.0.0.1', port: redis.port,
            username: 'fixture', password: 'fixture-secret', tls: false,
          })
        },
        createOssClient: async () => memoryOssClient(),
        githubFetch,
      },
    })
    cleanups.push(async () => { await running.close() })
    expect(postgresConfigs).toEqual([expect.objectContaining({ ssl: { rejectUnauthorized: true } })])
    expect(redisConfigs).toHaveLength(2)
    expect(redisConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({ tls: true, username: 'fixture' }),
    ]))

    const publicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
    const attempt = await running.context.platformAccount.beginLogin({
      installationId: parseInstallationId('desktop-oauth-fixture'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      publicKey,
    })
    const authorization = new URL(attempt.authorizationUrl)
    expect(authorization.origin + authorization.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(authorization.searchParams.get('client_id')).toBe('github-client-fixture')
    expect(authorization.searchParams.get('redirect_uri'))
      .toBe('https://platform.fixture.example/v1/account/oauth/github/callback')
    await running.context.platformAccount.completeGitHubCallback({
      code: 'github-code-fixture',
      state: authorization.searchParams.get('state') ?? '',
    })
    expect(githubFetch).toHaveBeenCalledTimes(2)
    const storedAttempt = await pool.query<{ identity: { login: string; providerSubject: number } }>(
      'SELECT identity FROM account_attempts WHERE id = $1',
      [attempt.id],
    )
    expect(storedAttempt.rows[0]?.identity).toEqual(expect.objectContaining({
      login: 'durable-fixture-account', providerSubject: 298347,
    }))

    const accountId = parsePlatformAccountId('account-fixture')
    const installationId = parseInstallationId('desktop-fixture')
    const routeId = parseRelayRouteId('route-fixture')
    await expect(running.remoteAccess.authority.enableDesktop(accountId, installationId, routeId))
      .resolves.toBe(routeId)
    await expect(running.remoteAccess.authority.getDesktop(accountId, installationId))
      .resolves.toEqual({ enabled: true, routeId })

    const stopCoordinator = await running.remoteAccess.coordinator.listen(
      parseRelayInstanceId('instance-observer'),
      async () => {},
    )
    cleanups.push(stopCoordinator)
    const directory = {
      routeId,
      attachmentId: parseRelayAttachmentId('attachment-fixture'),
      endpoint: 'desktop' as const,
      instanceId: parseRelayInstanceId('instance-observer'),
      connectionToken: parseRelayConnectionToken('connection-fixture'),
      revision: 1,
      expiresAt: Date.now() + 60_000,
    }
    await running.remoteAccess.coordinator.register(directory)
    await expect(running.remoteAccess.coordinator.locate(routeId, directory.attachmentId)).resolves.toEqual(directory)

    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename LIKE ANY($1)
        ORDER BY tablename`,
      [['account_%', 'remote_access_%', 'remote_attachment_%']],
    )
    expect(tables.rows.map(row => row.tablename)).toEqual(expect.arrayContaining([
      'account_accounts',
      'account_attempts',
      'account_sessions',
      'remote_access_desktops',
      'remote_access_mobile_pairings',
      'remote_access_pairing_transactions',
      'remote_access_route_authorities',
      'remote_access_routes',
      'remote_attachment_objects',
    ]))
  }, 60_000)

  it('drains HTTP, PostgreSQL, and Redis owners before the boot entry exits on SIGTERM', async () => {
    const tls = await createTlsFixture()
    const postgres = await startPostgresFixture(tls)
    const redis = await startRedisFixture(tls)
    const port = await freePort()
    const ca = await readFile(tls.cert, 'utf8')
    const postgresObserver = new pg.Pool({
      host: '127.0.0.1', port: postgres.port, user: 'fixture', database: 'postgres',
      ssl: { ca, rejectUnauthorized: true },
    })
    cleanups.push(async () => { await postgresObserver.end() })
    const redisObserver = createClient({
      username: 'fixture',
      password: 'fixture-secret',
      socket: { host: '127.0.0.1', port: redis.port, tls: true, ca },
    })
    await redisObserver.connect()
    cleanups.push(async () => { await redisObserver.quit() })
    await prepareBridgePhase(postgresObserver, 'postgres', 'remote-attachments/fixture')
    const child = spawn(process.execPath, [
      '--import', 'tsx/esm',
      '--import', join(import.meta.dirname, 'fixtures', 'oss-metadata-fetch.ts'),
      join(import.meta.dirname, '..', 'src', 'boot.ts'),
    ], {
      cwd: join(import.meta.dirname, '..', '..', '..'),
      env: {
        ...process.env,
        ...operatedFixtureEnv(),
        NODE_EXTRA_CA_CERTS: tls.cert,
        PLATFORM_POSTGRES_DATABASE: 'postgres',
        PLATFORM_POSTGRES_HOST: '127.0.0.1',
        PLATFORM_POSTGRES_PORT: String(postgres.port),
        PLATFORM_REDIS_HOST: '127.0.0.1',
        PLATFORM_REDIS_PASSWORD: 'fixture-secret',
        PLATFORM_REDIS_PORT: String(redis.port),
        PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr = captureStderr(child)
    cleanups.push(async () => { await stopChild(child) })
    await waitForHttp(port, child, stderr)
    await expect(postgresClientCount(postgresObserver)).resolves.toBeGreaterThanOrEqual(1)
    await expect(redisClientCount(redisObserver)).resolves.toBeGreaterThanOrEqual(3)

    const exited = childExit(child)
    expect(child.kill('SIGTERM')).toBe(true)
    await expect(Promise.race([
      exited,
      delay(10_000).then(() => { throw new Error('Platform entry did not exit after SIGTERM') }),
    ])).resolves.toEqual({ code: 0, signal: null })

    await expect(httpAvailable(port)).resolves.toBe(false)
    await expect(postgresClientCount(postgresObserver)).resolves.toBe(0)
    await expect(redisClientCount(redisObserver)).resolves.toBe(1)
    expect(stderr()).toContain('platform: listening on 127.0.0.1:')
  }, 60_000)
})

function operatedFixtureEnv(): NodeJS.Dict<string> {
  return {
    PLATFORM_ENVIRONMENT: 'production',
    PLATFORM_ORIGIN: 'https://platform.fixture.example',
    PLATFORM_GITHUB_CLIENT_ID: 'github-client-fixture',
    PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret-fixture',
    PLATFORM_GITHUB_CALLBACK: 'https://platform.fixture.example/v1/account/oauth/github/callback',
    PLATFORM_GITHUB_CREDENTIAL_REFERENCE: 'credentials://github-oauth/fixture',
    PLATFORM_POSTGRES_HOST: 'postgres.operated.fixture',
    PLATFORM_POSTGRES_USER: 'fixture',
    PLATFORM_POSTGRES_PASSWORD: 'postgres-secret-fixture',
    PLATFORM_POSTGRES_DATABASE: 'product-entry-fixture',
    PLATFORM_IDENTITY_NAMESPACE: 'identity-fixture',
    PLATFORM_REDIS_HOST: 'redis.operated.fixture',
    PLATFORM_REDIS_USER: 'fixture',
    PLATFORM_REDIS_PASSWORD: 'redis-secret-fixture',
    PLATFORM_OSS_ENDPOINT: 'oss-cn-hangzhou-internal.aliyuncs.com',
    PLATFORM_OSS_BUCKET: 'gestalt-secret',
    PLATFORM_OSS_AUTH: 'ecs-ram-role/gestalt-vpc',
    PLATFORM_OSS_OBJECT_PREFIX: 'remote-attachments/fixture',
    PLATFORM_OSS_TIMEOUT_MS: '10000',
    PLATFORM_RELAY_REDIS_KEY_PREFIX: 'gestalt:relay:fixture',
    PLATFORM_RELAY_INSTANCE_ID: 'instance-fixture',
    PLATFORM_RELAY_CAPACITY_RETRY_AFTER_MS: '1000',
    PLATFORM_RELAY_DELIVERY_ACK_TIMEOUT_MS: '5000',
    PLATFORM_RELAY_DIRECTORY_TTL_MS: '60000',
    PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS: '45000',
    PLATFORM_RELAY_MAX_BUFFERED_CIPHERTEXT_BYTES: '1048576',
    PLATFORM_RELAY_MAX_CONNECTIONS: '10000',
    PLATFORM_RELAY_MAX_PENDING_DELIVERIES: '10000',
    PLATFORM_RELAY_MAX_PENDING_CHALLENGES: '10000',
    PLATFORM_RELAY_ATTACH_TIMEOUT_MS: '10000',
    PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES: '104857600',
    PLATFORM_REMOTE_ATTACHMENT_CAPABILITY_LIFETIME_MS: '900000',
    PLATFORM_REMOTE_ATTACHMENT_MAX_RETAINED_BLOBS: '10000',
    PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'oss',
    PLATFORM_REMOTE_ATTACHMENT_SWEEP_INTERVAL_MS: '60000',
    PLATFORM_REMOTE_ATTACHMENT_CLEANUP_CONCURRENCY: '8',
    PLATFORM_TOKEN_SIGNING_KEY: 'ab'.repeat(32),
    PLATFORM_POLLING_SIGNING_KEY: 'cd'.repeat(32),
    PLATFORM_POSTGRES_SSL: 'require',
    PLATFORM_REDIS_TLS: '1',
    PLATFORM_LISTEN_HOST: '127.0.0.1',
    PORT: '0',
  }
}

async function prepareBridgePhase(
  pool: pg.Pool,
  databaseIdentity: string,
  objectPrefix: string,
): Promise<void> {
  await migrateAttachmentStoragePhase(pool, databaseIdentity)
  await completeAttachmentStorageCutover(pool, databaseIdentity, 'bridge', objectPrefix, CUTOVER_OPTIONS)
}

async function startAttachmentHttp(
  store: RemoteAttachmentStoreService,
  authority: RemoteAttachmentAuthority,
): Promise<string> {
  return await startAttachmentHttpWith(applyRemoteAttachmentsHttp, store, authority)
}

async function startAttachmentHttpWith(
  apply: (context: Context, config: { origin: string }) => void,
  store: RemoteAttachmentStoreService,
  authority: unknown,
): Promise<string> {
  const routes = new Map<string, {
    handler(req: IncomingMessage, res: ServerResponse): Promise<void>
  }>()
  const context = {
    remoteAttachments: store,
    remoteAttachmentAuthority: authority,
    webServer: {
      register(route: { path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(register: () => () => void) { register() },
  } as unknown as Context
  apply(context, { origin: 'https://mobile.example' })
  const server = createHttpServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (route === undefined) { res.writeHead(404).end(); return }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('attachment HTTP fixture did not bind')
  return `http://127.0.0.1:${String(address.port)}`
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function memoryOssClient(objects = new Map<string, Uint8Array>()): OssObjectClient {
  return {
    putObject: async (key, ciphertext) => { objects.set(key, new Uint8Array(ciphertext)) },
    getObject: async (key, expectedByteLength) => {
      const value = objects.get(key)
      if (value === undefined) throw new Error('fixture OSS object is absent')
      if (value.byteLength !== expectedByteLength) throw new Error('fixture OSS object length mismatch')
      return new Uint8Array(value)
    },
    deleteObject: async (key) => { objects.delete(key) },
  }
}

type LegacySettlementFailure = 'delete-fail' | 'commit-unknown' | 'crash'

function disabledPairingHandshake(): PairingHandshakeProvider {
  const unavailable = (): Promise<never> => Promise.reject(new Error('pairing handshake is unavailable'))
  return {
    createChallenge: unavailable,
    completeChallenge: unavailable,
    activatePairing: unavailable,
    destroyChallenge: () => {},
    destroyPendingPairing: () => {},
    destroyPairing: () => {},
  }
}

type PostgresPublishFailure =
  | 'recovery-rollback-readback-fail'
  | 'crash-after-intent'
  | 'intent-rollback-readback-fail'
  | 'main-rollback-readback-fail'
  | 'main-committed-readback-fail'

function postgresPublishFaultPool(base: pg.Pool, failure: PostgresPublishFailure): PlatformSqlPool {
  return {
    query: async (sql: string, values?: unknown[]) => await base.query(sql, values),
    connect: async () => {
      const client = await base.connect()
      let publisher = false
      let transactionNumber = 0
      let backendPid: number | undefined
      let recoveryReadbackMustFail = false
      let intentReadbackMustFail = false
      let mainReadbackMustFail = false
      let released = false
      return {
        query: async (sql: string, values?: unknown[]) => {
          if (sql === 'SELECT pg_advisory_lock(hashtext($1))') {
            const result = await client.query(sql, values)
            publisher = true
            const selected = await client.query('SELECT pg_backend_pid() AS pid')
            const pid = (selected.rows as Array<Record<string, unknown>>)[0]?.pid
            if (typeof pid !== 'number') throw new TypeError('publish fixture backend pid is invalid')
            backendPid = pid
            if (failure === 'crash-after-intent') client.on('error', () => {})
            return result
          }
          if (publisher && sql === 'BEGIN') transactionNumber += 1
          if (publisher && transactionNumber === 1
            && failure === 'recovery-rollback-readback-fail'
            && sql.includes('INSERT INTO remote_attachment_postgres_publish_intents')) {
            recoveryReadbackMustFail = true
            throw new Error('recovery transaction rolled back')
          }
          if (publisher && recoveryReadbackMustFail
            && sql.includes('FROM remote_attachment_postgres_publish_intents')) {
            throw new Error('recovery readback unavailable')
          }
          if (publisher && transactionNumber === 2
            && failure === 'intent-rollback-readback-fail'
            && sql.includes("SET stage = 'intent'")) {
            intentReadbackMustFail = true
            throw new Error('intent transaction rolled back')
          }
          if (publisher && intentReadbackMustFail
            && sql.includes('FROM remote_attachment_postgres_publish_intents')) {
            throw new Error('intent readback unavailable')
          }
          if (publisher && transactionNumber === 3
            && failure === 'main-rollback-readback-fail'
            && sql.includes('INSERT INTO remote_attachment_blobs')) {
            mainReadbackMustFail = true
            throw new Error('main publish transaction rolled back')
          }
          if (publisher && transactionNumber === 3
            && failure === 'main-committed-readback-fail' && sql === 'COMMIT') {
            await client.query(sql, values)
            mainReadbackMustFail = true
            throw new Error('main publish COMMIT outcome is unknown')
          }
          if (publisher && mainReadbackMustFail
            && sql.includes('SELECT capability_digest')
            && sql.includes('FROM remote_attachment_blobs')) {
            throw new Error('main publish readback unavailable')
          }
          if (publisher && transactionNumber === 2 && failure === 'crash-after-intent' && sql === 'COMMIT') {
            await client.query(sql, values)
            if (backendPid === undefined) throw new TypeError('publish fixture backend pid is unavailable')
            await base.query('SELECT pg_terminate_backend($1)', [backendPid])
            throw new Error('publisher crashed after durable intent')
          }
          return await client.query(sql, values)
        },
        release: () => {
          if (released) return
          released = true
          client.release(failure === 'crash-after-intent')
        },
      }
    },
  }
}

function legacySettlementFaultPool(
  base: pg.Pool,
  failure: LegacySettlementFailure,
): { pool: PlatformSqlPool; arm(): void; legacyBackendPid: Promise<number> } {
  let armed = false
  let reportLegacyBackendPid!: (pid: number) => void
  const legacyBackendPid = new Promise<number>((resolve) => { reportLegacyBackendPid = resolve })
  const pool = {
    query: async (sql: string, values?: unknown[]) => await base.query(sql, values),
    connect: async () => {
      const client = await base.connect()
      let failedClientReleased = false
      let legacyResponse = false
      let settlement = false
      return {
        query: async (sql: string, values?: unknown[]) => {
          if (armed && sql.includes('pg_advisory_lock_shared')) {
            const result = await client.query(sql, values)
            legacyResponse = true
            if (failure === 'crash') {
              client.on('error', () => {
                if (failedClientReleased) return
                failedClientReleased = true
                client.release(true)
              })
            }
            const selected = await client.query('SELECT pg_backend_pid() AS pid')
            const backendPid = (selected.rows as Array<Record<string, unknown>>)[0]?.pid
            if (typeof backendPid !== 'number') throw new TypeError('legacy fixture backend pid is invalid')
            reportLegacyBackendPid(backendPid)
            return result
          }
          if (armed && legacyResponse && sql === 'BEGIN') settlement = true
          if (armed && settlement && failure === 'delete-fail'
            && sql.includes('DELETE FROM remote_attachment_blobs AS blob')) {
            throw new Error('delete-fail')
          }
          if (armed && settlement && failure === 'commit-unknown' && sql === 'COMMIT') {
            throw new Error('commit-unknown')
          }
          return await client.query(sql, values)
        },
        release: () => { client.release() },
      }
    },
  } as unknown as PlatformSqlPool
  return { pool, arm: () => { armed = true }, legacyBackendPid }
}

function commandAvailable(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

interface TlsFixture {
  cert: string
  key: string
}

async function createTlsFixture(): Promise<TlsFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-operated-tls-'))
  const cert = join(root, 'server.crt')
  const key = join(root, 'server.key')
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { encoding: 'utf8' })
  if (generated.status !== 0) throw new Error(`TLS fixture failed: ${generated.stderr}`)
  await chmod(key, 0o600)
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  return { cert, key }
}

async function startPostgresFixture(tls?: TlsFixture): Promise<{ port: number }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-operated-postgres-'))
  const data = join(root, 'data')
  const initialized = spawnSync('initdb', [
    '-D', data, '-A', 'trust', '-U', 'fixture', '--no-locale', '--encoding=UTF8',
  ], { encoding: 'utf8' })
  if (initialized.status !== 0) throw new Error(`initdb fixture failed: ${initialized.stderr}`)
  const port = await freePort()
  const child = spawn('postgres', [
    '-D', data, '-h', '127.0.0.1', '-p', String(port),
    ...(tls === undefined ? [] : [
      '-c', 'ssl=on', '-c', `ssl_cert_file=${tls.cert}`, '-c', `ssl_key_file=${tls.key}`,
    ]),
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const stderr = captureStderr(child)
  cleanups.push(async () => {
    await stopChild(child)
    await rm(root, { recursive: true, force: true })
  })
  await waitForPostgres(port, stderr, tls)
  return { port }
}

async function startRedisFixture(tls?: TlsFixture): Promise<{ port: number }> {
  const port = await freePort()
  const child = spawn('redis-server', [
    '--bind', '127.0.0.1', '--port', tls === undefined ? String(port) : '0',
    ...(tls === undefined ? [] : [
      '--tls-port', String(port), '--tls-cert-file', tls.cert, '--tls-key-file', tls.key,
      '--tls-ca-cert-file', tls.cert, '--tls-auth-clients', 'no',
    ]),
    '--save', '', '--appendonly', 'no',
    '--user', 'default', 'off', '--user', 'fixture', 'on', '>fixture-secret', '~*', '&*', '+@all',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const stderr = captureStderr(child)
  cleanups.push(async () => { await stopChild(child) })
  await waitForPort(port, child, stderr)
  return { port }
}

async function waitForPostgres(port: number, stderr: () => string, tls?: TlsFixture): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const probe = new pg.Client({
      host: '127.0.0.1', port, user: 'fixture', database: 'postgres',
      ...(tls === undefined ? {} : { ssl: { ca: await readFile(tls.cert, 'utf8'), rejectUnauthorized: true } }),
    })
    try {
      await probe.connect()
      await probe.end()
      return
    } catch {
      await probe.end().catch(() => {})
      await delay(50)
    }
  }
  throw new Error(`PostgreSQL fixture did not become ready: ${stderr()}`)
}

async function waitForPort(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`durable fixture exited early: ${stderr()}`)
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = createServer().listen({ host: '127.0.0.1', port, exclusive: true })
      socket.once('error', () => { resolveOpen(true) })
      socket.once('listening', () => { socket.close(() => { resolveOpen(false) }) })
    })
    if (open) return
    await delay(50)
  }
  throw new Error(`durable fixture port did not become ready: ${stderr()}`)
}

function captureStderr(child: ChildProcess): () => string {
  let output = ''
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  return () => output.slice(-4_000)
}

async function stopChild(child: ChildProcess): Promise<void> {
  const exited = childExit(child)
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited
    return
  }
  child.kill('SIGTERM')
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }, 5_000)
  try {
    await Promise.race([
      exited,
      delay(10_000).then(() => { throw new Error('durable fixture did not exit after SIGKILL') }),
    ])
  } finally {
    clearTimeout(escalation)
  }
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => { resolveExit({ code, signal }) }
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off('exit', onExit)
      resolveExit({ code: child.exitCode, signal: child.signalCode })
    }
  })
}

async function waitForHttp(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Platform entry exited before listen: ${stderr()}`)
    if (await httpAvailable(port)) return
    await delay(50)
  }
  throw new Error(`Platform entry did not listen: ${stderr()}`)
}

async function httpAvailable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(500),
    })
    return response.ok
  } catch {
    return false
  }
}

async function postgresClientCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(`
    SELECT count(*)::int AS count
    FROM pg_stat_activity
    WHERE client_addr = '127.0.0.1'::inet AND pid <> pg_backend_pid()
  `)
  return result.rows[0]?.count ?? 0
}

async function redisClientCount(client: ReturnType<typeof createClient>): Promise<number> {
  const list: unknown = await client.sendCommand(['CLIENT', 'LIST'])
  if (typeof list !== 'string') throw new TypeError('Redis CLIENT LIST fixture response must be text')
  return list.trim().split('\n').filter(Boolean).length
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('fixture failed to allocate a TCP port'))
        return
      }
      server.close((error) => { if (error === undefined) resolvePort(address.port); else reject(error) })
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
}
