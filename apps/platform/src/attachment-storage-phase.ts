/** Shared PostgreSQL authority phase for the two-step attachment-storage rollout. */

import type { PlatformSqlClient, PlatformSqlPool } from './postgres-pairing-store.ts'
import { validateOssObjectPrefix } from './oss-config.ts'

/** Storage authority understood by the fixed-base drain, PostgreSQL bridge, and OSS store. */
export type AttachmentStoragePhase = 'legacy' | 'bridge' | 'oss'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remote_attachment_storage_phase (
  database_identity text PRIMARY KEY,
  phase text NOT NULL CHECK (phase IN ('legacy', 'bridge', 'oss'))
);
`

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
  lock = false,
): Promise<AttachmentStoragePhase> {
  const selected = await client.query(
    `SELECT phase FROM remote_attachment_storage_phase
      WHERE database_identity = $1${lock ? ' FOR UPDATE' : ''}`,
    [databaseIdentity],
  )
  const phase = selected.rows[0]?.phase
  if (phase !== 'legacy' && phase !== 'bridge' && phase !== 'oss') {
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
 */
export async function completeAttachmentStorageCutover(
  pool: PlatformSqlPool,
  databaseIdentity: string,
  target: Exclude<AttachmentStoragePhase, 'legacy'>,
  objectPrefix: string,
): Promise<void> {
  const prefix = validateOssObjectPrefix(objectPrefix)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`remote-attachments:${databaseIdentity}`])
    const current = await readAttachmentStoragePhase(client, databaseIdentity, true)
    if (target === 'bridge' && current !== 'legacy' && current !== 'bridge') {
      throw new TypeError('PostgreSQL bridge cutover cannot replace OSS authority')
    }
    if (target === 'oss' && current !== 'bridge' && current !== 'oss') {
      throw new TypeError('OSS cutover requires completed PostgreSQL bridge authority')
    }
    if (target === 'oss') await removeAttachmentStorageLegacyDuplicates(client, databaseIdentity, prefix)
    await client.query(
      'UPDATE remote_attachment_storage_phase SET phase = $2 WHERE database_identity = $1',
      [databaseIdentity, target],
    )
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {
      /* rollback after a failed authority transition is best-effort */
    }
    throw error
  } finally {
    client.release()
  }
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
): Promise<void> {
  const selected = await client.query(
    `SELECT object.capability_digest, object.object_key
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
  for (const row of selected.rows) validateObjectBinding(row, objectPrefix)
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

function validateObjectBinding(row: Record<string, unknown>, objectPrefix: string): void {
  if (!(row.capability_digest instanceof Uint8Array) || row.capability_digest.byteLength !== 32
    || typeof row.object_key !== 'string'
    || row.object_key !== `${objectPrefix}/${Buffer.from(row.capability_digest).toString('hex')}`) {
    throw new TypeError('OSS remote attachment cutover row is invalid')
  }
}
