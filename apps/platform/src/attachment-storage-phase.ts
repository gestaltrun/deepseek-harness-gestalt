/** Shared PostgreSQL authority phase for the two-step attachment-storage rollout. */

import type { PlatformSqlClient, PlatformSqlPool } from './postgres-pairing-store.ts'
import { validateOssObjectPrefix } from './oss-config.ts'
import {
  parseAttachmentBlobReservationId,
  parsePersonalPairingId,
  type AttachmentBlobReservationCleanup,
  type AttachmentBlobReservationId,
} from '@deepseek-ai/dsh-remote-access'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'

/** Storage authority understood by the fixed-base drain, PostgreSQL bridge, and OSS store. */
export type AttachmentStoragePhase = 'legacy' | 'draining' | 'bridge' | 'oss'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remote_attachment_storage_phase (
  database_identity text PRIMARY KEY,
  phase text NOT NULL CHECK (phase IN ('legacy', 'draining', 'bridge', 'oss'))
);
CREATE TABLE IF NOT EXISTS remote_attachment_legacy_deliveries (
  database_identity text NOT NULL,
  capability_digest bytea NOT NULL,
  claim_token bytea NOT NULL,
  expires_at bigint NOT NULL,
  quota_reservation_id text,
  PRIMARY KEY (database_identity, capability_digest)
);
CREATE TABLE IF NOT EXISTS remote_attachment_quota_releases (
  database_identity text NOT NULL,
  reservation_id text NOT NULL,
  PRIMARY KEY (database_identity, reservation_id)
);
`

/** Deployment bounds and cleanup authority required by a storage cutover. */
export interface AttachmentStorageCutoverOptions {
  maxBlobBytes: number
  quotaCleanup: AttachmentBlobReservationCleanup
}

/** Create the deployment-scoped phase in fixed-base compatibility mode. */
export async function migrateAttachmentStoragePhase(
  pool: PlatformSqlPool,
  databaseIdentity: string,
): Promise<AttachmentStoragePhase> {
  await pool.query(SCHEMA)
  await pool.query(
    `INSERT INTO remote_attachment_storage_phase (database_identity, phase)
     VALUES ($1, 'legacy') ON CONFLICT (database_identity) DO NOTHING`,
    [databaseIdentity],
  )
  return await readAttachmentStoragePhase(pool, databaseIdentity)
}

/** Read the committed deployment-scoped storage authority. */
export async function readAttachmentStoragePhase(
  client: PlatformSqlClient,
  databaseIdentity: string,
  lock: 'none' | 'share' | 'update' = 'none',
): Promise<AttachmentStoragePhase> {
  const lockClause = lock === 'share' ? ' FOR SHARE' : lock === 'update' ? ' FOR UPDATE' : ''
  const selected = await client.query(
    `SELECT phase FROM remote_attachment_storage_phase
      WHERE database_identity = $1${lockClause}`,
    [databaseIdentity],
  )
  const phase = selected.rows[0]?.phase
  if (phase !== 'legacy' && phase !== 'draining' && phase !== 'bridge' && phase !== 'oss') {
    throw new TypeError('remote attachment storage phase is invalid')
  }
  return phase
}

/**
 * Complete one irreversible rollout phase after every replacement is serving.
 * @param pool - shared PostgreSQL authority.
 * @param databaseIdentity - deployment namespace.
 * @param target - bridge or final OSS authority.
 * @param objectPrefix - validated private OSS namespace.
 * @param options - deployment byte ceiling and quota cleanup authority.
 */
export async function completeAttachmentStorageCutover(
  pool: PlatformSqlPool,
  databaseIdentity: string,
  target: 'bridge' | 'oss',
  objectPrefix: string,
  options: AttachmentStorageCutoverOptions,
): Promise<void> {
  const prefix = validateOssObjectPrefix(objectPrefix)
  const maxBlobBytes = validateMaxBlobBytes(options.maxBlobBytes)
  const client = await pool.connect()
  let advisoryLockHeld = false
  let advisoryIdentity: string | undefined
  try {
    if (target === 'bridge') {
      await beginLegacyDrain(client, databaseIdentity)
      advisoryIdentity = legacyDrainLockIdentity(databaseIdentity)
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [advisoryIdentity])
      advisoryLockHeld = true
      await finishLegacyDrain(client, databaseIdentity, maxBlobBytes)
    } else {
      advisoryIdentity = `remote-attachments:${databaseIdentity}`
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [advisoryIdentity])
      advisoryLockHeld = true
      await client.query('BEGIN')
      const current = await readAttachmentStoragePhase(client, databaseIdentity, 'update')
      if (current !== 'bridge' && current !== 'oss') {
        throw new TypeError('OSS cutover requires completed PostgreSQL bridge authority')
      }
      await removeAttachmentStorageLegacyDuplicates(client, databaseIdentity, prefix, maxBlobBytes)
      await client.query(
        'UPDATE remote_attachment_storage_phase SET phase = $2 WHERE database_identity = $1',
        [databaseIdentity, target],
      )
      await client.query('COMMIT')
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {
      /* rollback after a failed authority transition is best-effort */
    }
    throw error
  } finally {
    try {
      if (advisoryLockHeld) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [advisoryIdentity])
      }
    } catch {
      /* connection release also drops the cutover advisory lock */
    }
    client.release()
  }
  await releasePendingAttachmentQuota(pool, databaseIdentity, options.quotaCleanup)
}

/**
 * Database lock identity held by each fixed-base-compatible response.
 * @param databaseIdentity - deployment namespace.
 * @returns advisory-lock identity distinct from attachment capacity serialization.
 */
export function legacyDrainLockIdentity(databaseIdentity: string): string {
  return `remote-attachments-legacy-drain:${databaseIdentity}`
}

async function beginLegacyDrain(client: PlatformSqlClient, databaseIdentity: string): Promise<void> {
  await client.query('BEGIN')
  const current = await readAttachmentStoragePhase(client, databaseIdentity, 'update')
  if (current !== 'legacy' && current !== 'draining' && current !== 'bridge') {
    throw new TypeError('PostgreSQL bridge cutover cannot replace OSS authority')
  }
  if (current === 'legacy') {
    await client.query(
      "UPDATE remote_attachment_storage_phase SET phase = 'draining' WHERE database_identity = $1",
      [databaseIdentity],
    )
  }
  await client.query('COMMIT')
}

async function finishLegacyDrain(
  client: PlatformSqlClient,
  databaseIdentity: string,
  maxBlobBytes: number,
): Promise<void> {
  await client.query('BEGIN')
  const current = await readAttachmentStoragePhase(client, databaseIdentity, 'update')
  if (current !== 'draining' && current !== 'bridge') {
    throw new TypeError('PostgreSQL bridge drain phase is invalid')
  }
  if (current === 'draining') {
    await reconcileLegacyDeliveries(client, databaseIdentity, maxBlobBytes)
    await client.query(
      "UPDATE remote_attachment_storage_phase SET phase = 'bridge' WHERE database_identity = $1",
      [databaseIdentity],
    )
  }
  await client.query('COMMIT')
}

/**
 * Remove unclaimed bridge ciphertext only after validating its OSS metadata binding.
 * @param client - transaction client.
 * @param databaseIdentity - deployment namespace.
 * @param objectPrefix - validated private OSS namespace.
 * @returns completion after duplicate metadata is OSS-owned.
 */
export async function removeAttachmentStorageLegacyDuplicates(
  client: PlatformSqlClient,
  databaseIdentity: string,
  objectPrefix: string,
  maxBlobBytes: number,
): Promise<void> {
  const selected = await client.query(
    `SELECT
            object.capability_digest AS object_capability_digest,
            legacy.capability_digest AS legacy_capability_digest,
            object.pairing_id AS object_pairing_id,
            legacy.pairing_id AS legacy_pairing_id,
            object.object_key,
            object.byte_length AS object_byte_length,
            legacy.ciphertext AS legacy_ciphertext,
            object.expires_at AS object_expires_at,
            legacy.expires_at AS legacy_expires_at,
            object.quota_reservation_id AS object_quota_reservation_id,
            legacy.quota_reservation_id AS legacy_quota_reservation_id,
            object.claim_token AS object_claim_token,
            legacy.claim_token AS legacy_claim_token
       FROM remote_attachment_objects AS object
       JOIN remote_attachment_blobs AS legacy
         ON legacy.database_identity = object.database_identity
        AND legacy.capability_digest = object.capability_digest
      WHERE object.database_identity = $1
        AND object.legacy_authority
        AND object.claim_token IS NULL
        AND legacy.claim_token IS NULL
      FOR UPDATE OF object, legacy`,
    [databaseIdentity],
  )
  for (const row of selected.rows) validateObjectBinding(row, objectPrefix, maxBlobBytes)
  await client.query(
    `DELETE FROM remote_attachment_blobs AS legacy
      USING remote_attachment_objects AS object
      WHERE legacy.database_identity = $1
        AND object.database_identity = legacy.database_identity
        AND object.capability_digest = legacy.capability_digest
        AND object.legacy_authority
        AND object.claim_token IS NULL
        AND legacy.claim_token IS NULL`,
    [databaseIdentity],
  )
  await client.query(
    `UPDATE remote_attachment_objects
        SET legacy_authority = false
      WHERE database_identity = $1 AND legacy_authority AND claim_token IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM remote_attachment_blobs AS legacy
           WHERE legacy.database_identity = remote_attachment_objects.database_identity
             AND legacy.capability_digest = remote_attachment_objects.capability_digest
        )`,
    [databaseIdentity],
  )
}

function validateObjectBinding(row: Record<string, unknown>, objectPrefix: string, maxBlobBytes: number): void {
  const objectDigest = row.object_capability_digest
  const legacyDigest = row.legacy_capability_digest
  const objectLength = Number(row.object_byte_length)
  const objectExpiry = Number(row.object_expires_at)
  const legacyExpiry = Number(row.legacy_expires_at)
  if (!(objectDigest instanceof Uint8Array) || objectDigest.byteLength !== 32
    || !(legacyDigest instanceof Uint8Array) || legacyDigest.byteLength !== 32
    || !sameBytes(objectDigest, legacyDigest)
    || typeof row.object_pairing_id !== 'string' || typeof row.legacy_pairing_id !== 'string'
    || parsePersonalPairingId(row.object_pairing_id) !== parsePersonalPairingId(row.legacy_pairing_id)
    || typeof row.object_key !== 'string'
    || row.object_key !== `${objectPrefix}/${Buffer.from(objectDigest).toString('hex')}`
    || !Number.isSafeInteger(objectLength) || objectLength <= 0 || objectLength > maxBlobBytes
    || !(row.legacy_ciphertext instanceof Uint8Array) || row.legacy_ciphertext.byteLength !== objectLength
    || !Number.isSafeInteger(objectExpiry) || objectExpiry <= 0
    || objectExpiry !== legacyExpiry
    || reservationId(row.object_quota_reservation_id) !== reservationId(row.legacy_quota_reservation_id)
    || (row.object_claim_token !== null && row.object_claim_token !== undefined)
    || (row.legacy_claim_token !== null && row.legacy_claim_token !== undefined)) {
    throw new TypeError('OSS remote attachment cutover row is invalid')
  }
}

async function reconcileLegacyDeliveries(
  client: PlatformSqlClient,
  databaseIdentity: string,
  maxBlobBytes: number,
): Promise<void> {
  const locked = await client.query(
    `SELECT 1 FROM remote_attachment_legacy_deliveries
      WHERE database_identity = $1
      FOR UPDATE`,
    [databaseIdentity],
  )
  if (locked.rows.length === 0) return
  const selected = await client.query(
    `SELECT delivery.capability_digest, delivery.claim_token, delivery.expires_at,
            delivery.quota_reservation_id, blob.pairing_id, blob.ciphertext,
            blob.expires_at AS blob_expires_at, blob.quota_reservation_id AS blob_quota_reservation_id
       FROM remote_attachment_legacy_deliveries AS delivery
       LEFT JOIN remote_attachment_blobs AS blob
         ON blob.database_identity = delivery.database_identity
        AND blob.capability_digest = delivery.capability_digest
      WHERE delivery.database_identity = $1
      `,
    [databaseIdentity],
  )
  for (const row of selected.rows) validateLegacyDelivery(row, maxBlobBytes)
  const removed = await client.query(
    `DELETE FROM remote_attachment_blobs AS blob
      USING remote_attachment_legacy_deliveries AS delivery
      WHERE blob.database_identity = $1
        AND delivery.database_identity = blob.database_identity
        AND delivery.capability_digest = blob.capability_digest
      RETURNING blob.quota_reservation_id`,
    [databaseIdentity],
  )
  await client.query(
    'DELETE FROM remote_attachment_legacy_deliveries WHERE database_identity = $1',
    [databaseIdentity],
  )
  for (const id of reservationIds(removed.rows)) await recordAttachmentQuotaRelease(client, databaseIdentity, id)
  for (const row of selected.rows) {
    const id = optionalReservationId(row.quota_reservation_id)
    if (id !== undefined) await recordAttachmentQuotaRelease(client, databaseIdentity, id)
  }
}

function validateLegacyDelivery(row: Record<string, unknown>, maxBlobBytes: number): void {
  const digest = row.capability_digest
  const expiresAt = Number(row.expires_at)
  const blobExpiresAt = Number(row.blob_expires_at)
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32
    || !(row.claim_token instanceof Uint8Array) || row.claim_token.byteLength !== 32
    || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new TypeError('legacy attachment delivery claim is invalid')
  }
  if (row.ciphertext === null || row.ciphertext === undefined) return
  if (typeof row.pairing_id !== 'string' || parsePersonalPairingId(row.pairing_id) === ''
    || !(row.ciphertext instanceof Uint8Array) || row.ciphertext.byteLength === 0
    || row.ciphertext.byteLength > maxBlobBytes
    || blobExpiresAt !== expiresAt
    || optionalReservationId(row.quota_reservation_id) !== optionalReservationId(row.blob_quota_reservation_id)) {
    throw new TypeError('legacy attachment delivery claim is invalid')
  }
}

/** Record quota cleanup in the same transaction that removes attachment authority. */
export async function recordAttachmentQuotaRelease(
  client: PlatformSqlClient,
  databaseIdentity: string,
  reservationId: AttachmentBlobReservationId,
): Promise<void> {
  await client.query(
    `INSERT INTO remote_attachment_quota_releases (database_identity, reservation_id)
     VALUES ($1,$2) ON CONFLICT (database_identity, reservation_id) DO NOTHING`,
    [databaseIdentity, reservationId],
  )
}

/** Retry every committed quota cleanup and remove each successful outbox row. */
export async function releasePendingAttachmentQuota(
  pool: PlatformSqlPool,
  databaseIdentity: string,
  quotaCleanup: AttachmentBlobReservationCleanup,
): Promise<void> {
  const pending = await pool.query(
    `SELECT reservation_id AS quota_reservation_id
       FROM remote_attachment_quota_releases
      WHERE database_identity = $1 ORDER BY reservation_id`,
    [databaseIdentity],
  )
  for (const reservationId of reservationIds(pending.rows)) {
    await quotaCleanup.release(reservationId)
    await pool.query(
      'DELETE FROM remote_attachment_quota_releases WHERE database_identity = $1 AND reservation_id = $2',
      [databaseIdentity, reservationId],
    )
  }
}

function validateMaxBlobBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes) {
    throw new TypeError('attachment storage cutover maxBlobBytes exceeds the protocol ceiling')
  }
  return value
}

function optionalReservationId(value: unknown): AttachmentBlobReservationId | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError('attachment quota reservation id is invalid')
  return parseAttachmentBlobReservationId(value)
}

function reservationIds(rows: readonly Record<string, unknown>[]): AttachmentBlobReservationId[] {
  return rows.flatMap((row) => {
    const value = optionalReservationId(row.quota_reservation_id)
    return value === undefined ? [] : [value]
  })
}

function reservationId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError('OSS remote attachment cutover row is invalid')
  return parseAttachmentBlobReservationId(value)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}
