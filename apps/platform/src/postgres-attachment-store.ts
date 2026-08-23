/** PostgreSQL ciphertext store shared by every operated Platform instance. */

import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  parseAttachmentBlobReservationId,
  parsePersonalPairingId,
  type AttachmentBlobReservationCleanup,
  type AttachmentBlobReservationId,
  type PersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import {
  RemoteAttachmentError,
  RemoteAttachmentStoreService,
  type RemoteAttachmentBlob,
  type RemoteAttachmentConsumption,
  type RemoteAttachmentGrant,
  type RemoteAttachmentQuotaReservation,
} from '@deepseek-ai/dsh-remote-attachments'
import {
  parseAttachmentCapability,
  REMOTE_PROTOCOL_LIMITS,
  type AttachmentCapability,
} from '@deepseek-ai/dsh-remote-protocol'
import type { PlatformSqlClient, PlatformSqlPool } from './postgres-pairing-store.ts'
import {
  legacyDrainLockIdentity,
  migrateAttachmentStoragePhase,
  recordAttachmentQuotaRelease,
  readAttachmentStoragePhase,
  releasePendingAttachmentQuota,
} from './attachment-storage-phase.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remote_attachment_blobs (
  database_identity text NOT NULL,
  capability_digest bytea NOT NULL,
  pairing_id text NOT NULL,
  ciphertext bytea NOT NULL,
  expires_at bigint NOT NULL,
  quota_reservation_id text,
  claim_token bytea,
  PRIMARY KEY (database_identity, capability_digest)
);
ALTER TABLE remote_attachment_blobs ADD COLUMN IF NOT EXISTS quota_reservation_id text;
ALTER TABLE remote_attachment_blobs ADD COLUMN IF NOT EXISTS claim_token bytea;
CREATE INDEX IF NOT EXISTS remote_attachment_blobs_expiry
  ON remote_attachment_blobs (database_identity, expires_at);
`

interface AttachmentRow {
  capability_digest: Uint8Array
  pairing_id: PersonalPairingId
  ciphertext: Uint8Array
  expires_at: number
  quota_reservation_id?: AttachmentBlobReservationId
  claim_token?: Uint8Array
}

/** Deployment bounds for the operated PostgreSQL attachment store. */
export interface PostgresRemoteAttachmentStoreOptions {
  maxBlobBytes: number
  capabilityLifetimeMs: number
  maxRetainedBlobs: number
  quotaCleanup: AttachmentBlobReservationCleanup
}

/** Durable pairing-scoped ciphertext store with one-time capability consumption. */
export class PostgresRemoteAttachmentStore extends RemoteAttachmentStoreService {
  readonly maxBlobBytes: number
  readonly capabilityLifetimeMs: number
  private readonly maxRetainedBlobs: number
  private readonly quotaCleanup: AttachmentBlobReservationCleanup

  /**
   * @param ctx - operated Platform context.
   * @param databaseIdentity - deployment namespace.
   * @param pool - shared PostgreSQL pool.
   * @param options - validated storage ceilings.
   */
  constructor(
    ctx: Context,
    private readonly databaseIdentity: string,
    private readonly pool: PlatformSqlPool,
    options: PostgresRemoteAttachmentStoreOptions,
  ) {
    super(ctx)
    this.maxBlobBytes = options.maxBlobBytes
    this.capabilityLifetimeMs = options.capabilityLifetimeMs
    this.maxRetainedBlobs = options.maxRetainedBlobs
    this.quotaCleanup = options.quotaCleanup
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes <= 0
      || this.maxBlobBytes > REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes) {
      throw new TypeError('PostgreSQL remote attachment maxBlobBytes exceeds the protocol ceiling')
    }
    if (!Number.isSafeInteger(this.capabilityLifetimeMs) || this.capabilityLifetimeMs <= 0
      || this.capabilityLifetimeMs > REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs) {
      throw new TypeError('PostgreSQL remote attachment capabilityLifetimeMs exceeds the protocol ceiling')
    }
    if (!Number.isSafeInteger(this.maxRetainedBlobs) || this.maxRetainedBlobs <= 0) {
      throw new TypeError('PostgreSQL remote attachment maxRetainedBlobs must be a positive integer')
    }
  }

  /** Create the shared ciphertext table before HTTP routes mount. */
  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA)
    const phase = await migrateAttachmentStoragePhase(this.pool, this.databaseIdentity)
    if (phase === 'oss') throw new TypeError('PostgreSQL attachment store cannot start under OSS authority')
    await this.flushQuotaReleases()
  }

  override async publish(input: {
    pairingId: PersonalPairingId
    ciphertext: Uint8Array
    now: number
    quota?: RemoteAttachmentQuotaReservation
  }): Promise<RemoteAttachmentGrant> {
    if (input.ciphertext.byteLength === 0) {
      await input.quota?.release()
      throw new RemoteAttachmentError('ATTACHMENT_EMPTY', 'Remote attachment ciphertext must not be empty')
    }
    if (input.ciphertext.byteLength > this.maxBlobBytes) {
      await input.quota?.release()
      throw new RemoteAttachmentError('ATTACHMENT_LIMIT_EXCEEDED', 'Remote attachment exceeds the per-blob byte ceiling')
    }
    const capability = parseAttachmentCapability(randomBytes(32).toString('base64url'))
    const capabilityDigest = digest(capability)
    const expiresAt = input.now + this.capabilityLifetimeMs
    try {
      await this.transaction(async (client) => {
        await this.lockCapacity(client)
        const retired = await client.query(
          `DELETE FROM remote_attachment_blobs
            WHERE database_identity = $1 AND expires_at <= $2
          RETURNING quota_reservation_id`,
          [this.databaseIdentity, input.now],
        )
        await this.recordQuotaReleases(client, retired.rows)
        const counted = await client.query(
          'SELECT COUNT(*)::text AS count FROM remote_attachment_blobs WHERE database_identity = $1',
          [this.databaseIdentity],
        )
        if (Number(counted.rows[0]?.count ?? 0) >= this.maxRetainedBlobs) {
          throw new RemoteAttachmentError('ATTACHMENT_CAPACITY', 'Remote attachment store is at capacity')
        }
        await client.query(
          `INSERT INTO remote_attachment_blobs (
             database_identity, capability_digest, pairing_id, ciphertext, expires_at,
             quota_reservation_id, claim_token
           ) VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
          [this.databaseIdentity, capabilityDigest, input.pairingId, Buffer.from(input.ciphertext), expiresAt,
            input.quota?.id ?? null],
        )
      })
    } catch (error) {
      let outcome: 'committed' | 'absent'
      try {
        outcome = await this.readPublishOutcome(capabilityDigest, input, expiresAt)
      } catch (readbackError) {
        throw new Error('PostgreSQL attachment publish outcome is uncertain', {
          cause: new AggregateError([error, readbackError]),
        })
      }
      if (outcome === 'committed') {
        return await this.finishCommittedPublish(capability, input.ciphertext.byteLength, expiresAt)
      }
      try { await input.quota?.release() } catch (cleanupError) {
        console.error('[platform] PostgreSQL attachment quota cleanup after publish failure failed:', cleanupError)
      }
      throw error
    }
    return await this.finishCommittedPublish(capability, input.ciphertext.byteLength, expiresAt)
  }

  override async inspect(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<Uint8Array> {
    await this.flushQuotaReleases()
    const outcome = await this.transaction(async (client) => {
      const row = await this.loadRequiredRow(client, input, true)
      if (input.now < row.expires_at) return { kind: 'available' as const, row }
      const removed = await client.query(
        `DELETE FROM remote_attachment_blobs
          WHERE database_identity = $1 AND capability_digest = $2
        RETURNING quota_reservation_id`,
        [this.databaseIdentity, digest(input.capability)],
      )
      await this.recordQuotaReleases(client, removed.rows)
      return { kind: 'expired' as const }
    })
    if (outcome.kind === 'expired') {
      await this.flushQuotaReleases()
      throw new RemoteAttachmentError('ATTACHMENT_EXPIRED', 'Remote attachment capability has expired')
    }
    const { row } = outcome
    if (row.claim_token !== undefined) {
      throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability is already in use')
    }
    return new Uint8Array(row.ciphertext)
  }

  override async consume(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<RemoteAttachmentConsumption> {
    await this.flushQuotaReleases()
    const legacy = await this.tryLegacyConsumption(input)
    if (legacy !== undefined) return legacy
    const token = randomBytes(32)
    const outcome = await this.transaction(async (client) => {
      const row = await this.loadRequiredRow(client, input, true)
      if (input.now >= row.expires_at) {
        const removed = await client.query(
          `DELETE FROM remote_attachment_blobs
            WHERE database_identity = $1 AND capability_digest = $2
          RETURNING quota_reservation_id`,
          [this.databaseIdentity, digest(input.capability)],
        )
        await this.recordQuotaReleases(client, removed.rows)
        return { kind: 'expired' as const }
      }
      const phase = await readAttachmentStoragePhase(client, this.databaseIdentity)
      if (phase === 'legacy') throw new TypeError('legacy attachment consume did not hold the phase barrier')
      if (phase === 'oss') throw new TypeError('PostgreSQL attachment store cannot consume under OSS authority')
      if (row.claim_token !== undefined) {
        throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability is already in use')
      }
      const claimed = await client.query(
        `UPDATE remote_attachment_blobs SET claim_token = $3
          WHERE database_identity = $1 AND capability_digest = $2 AND claim_token IS NULL`,
        [this.databaseIdentity, digest(input.capability), token],
      )
      if (claimed.rowCount !== 1) {
        throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability was already consumed')
      }
      return { kind: 'claimed' as const, row }
    })
    if (outcome.kind === 'expired') {
      await this.flushQuotaReleases()
      throw new RemoteAttachmentError('ATTACHMENT_EXPIRED', 'Remote attachment capability has expired')
    }
    const { row } = outcome
    let settled = false
    return {
      ciphertext: new Uint8Array(row.ciphertext),
      complete: async () => {
        if (settled) return
        settled = true
        await this.transaction(async (client) => {
          const removed = await client.query(
            `DELETE FROM remote_attachment_blobs
              WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3
            RETURNING quota_reservation_id`,
            [this.databaseIdentity, row.capability_digest, token],
          )
          await this.recordQuotaReleases(client, removed.rows)
        })
        await this.flushQuotaReleases()
      },
      abandon: async (now) => {
        if (settled) return
        settled = true
        if (now < row.expires_at) {
          await this.pool.query(
            `UPDATE remote_attachment_blobs SET claim_token = NULL
              WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3`,
            [this.databaseIdentity, row.capability_digest, token],
          )
          return
        }
        await this.transaction(async (client) => {
          const removed = await client.query(
            `DELETE FROM remote_attachment_blobs
              WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3
            RETURNING quota_reservation_id`,
            [this.databaseIdentity, row.capability_digest, token],
          )
          await this.recordQuotaReleases(client, removed.rows)
        })
        await this.flushQuotaReleases()
      },
    }
  }

  private async tryLegacyConsumption(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<RemoteAttachmentConsumption | undefined> {
    for (;;) {
      const client = await this.pool.connect()
      let advisoryLockHeld = false
      let clientReleased = false
      try {
        await client.query('BEGIN')
        const phase = await readAttachmentStoragePhase(client, this.databaseIdentity, 'update')
        if (phase === 'draining') {
          await client.query('ROLLBACK')
          client.release()
          await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
          continue
        }
        if (phase !== 'legacy') {
          await client.query('ROLLBACK')
          client.release()
          return undefined
        }
        const row = await this.loadRequiredRow(client, input, false)
        if (input.now >= row.expires_at) {
          const removed = await client.query(
            `DELETE FROM remote_attachment_blobs
              WHERE database_identity = $1 AND capability_digest = $2
            RETURNING quota_reservation_id`,
            [this.databaseIdentity, digest(input.capability)],
          )
          await client.query(
            `DELETE FROM remote_attachment_legacy_deliveries
              WHERE database_identity = $1 AND capability_digest = $2`,
            [this.databaseIdentity, row.capability_digest],
          )
          for (const reservationId of reservationIds(removed.rows)) {
            await recordAttachmentQuotaRelease(client, this.databaseIdentity, reservationId)
          }
          await client.query('COMMIT')
          client.release()
          clientReleased = true
          await releasePendingAttachmentQuota(this.pool, this.databaseIdentity, this.quotaCleanup)
          throw new RemoteAttachmentError('ATTACHMENT_EXPIRED', 'Remote attachment capability has expired')
        }
        if (row.claim_token !== undefined) {
          throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability is already in use')
        }
        const token = randomBytes(32)
        const admitted = await client.query(
          `INSERT INTO remote_attachment_legacy_deliveries (
             database_identity, capability_digest, claim_token, expires_at, quota_reservation_id
           ) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (database_identity, capability_digest) DO NOTHING`,
          [this.databaseIdentity, row.capability_digest, token, row.expires_at, row.quota_reservation_id ?? null],
        )
        if (admitted.rowCount !== 1) {
          throw new RemoteAttachmentError(
            'ATTACHMENT_CAPABILITY_INVALID',
            'Remote attachment capability is already in use',
          )
        }
        await client.query(
          'SELECT pg_advisory_lock_shared(hashtext($1))',
          [legacyDrainLockIdentity(this.databaseIdentity)],
        )
        advisoryLockHeld = true
        await client.query('COMMIT')
        return this.legacyConsumption(client, row, token)
      } catch (error) {
        if (clientReleased) throw error
        try { await client.query('ROLLBACK') } catch {
          /* rollback after a failed legacy consume admission is best-effort */
        }
        try {
          if (advisoryLockHeld) {
            await client.query(
              'SELECT pg_advisory_unlock_shared(hashtext($1))',
              [legacyDrainLockIdentity(this.databaseIdentity)],
            )
          }
        } catch {
          /* connection release also drops the legacy response lock */
        }
        client.release()
        throw error
      }
    }
  }

  private legacyConsumption(
    client: PlatformSqlClient & { release(): void },
    row: AttachmentRow,
    token: Uint8Array,
  ): RemoteAttachmentConsumption {
    let settled = false
    const settle = async (removeCiphertext: boolean): Promise<void> => {
      try {
        await client.query('BEGIN')
        if (removeCiphertext) {
          const removed = await client.query(
            `DELETE FROM remote_attachment_blobs AS blob
              USING remote_attachment_legacy_deliveries AS delivery
              WHERE blob.database_identity = $1
                AND blob.capability_digest = $2
                AND delivery.database_identity = blob.database_identity
                AND delivery.capability_digest = blob.capability_digest
                AND delivery.claim_token = $3
            RETURNING blob.quota_reservation_id`,
            [this.databaseIdentity, row.capability_digest, token],
          )
          for (const reservationId of reservationIds(removed.rows)) {
            await recordAttachmentQuotaRelease(client, this.databaseIdentity, reservationId)
          }
          if (row.quota_reservation_id !== undefined) {
            await recordAttachmentQuotaRelease(client, this.databaseIdentity, row.quota_reservation_id)
          }
        }
        await client.query(
          `DELETE FROM remote_attachment_legacy_deliveries
            WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3`,
          [this.databaseIdentity, row.capability_digest, token],
        )
        await client.query('COMMIT')
        await client.query(
          'SELECT pg_advisory_unlock_shared(hashtext($1))',
          [legacyDrainLockIdentity(this.databaseIdentity)],
        )
        client.release()
        await releasePendingAttachmentQuota(this.pool, this.databaseIdentity, this.quotaCleanup)
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {
          /* rollback after a failed legacy response settlement is best-effort */
        }
        try {
          await client.query(
            'SELECT pg_advisory_unlock_shared(hashtext($1))',
            [legacyDrainLockIdentity(this.databaseIdentity)],
          )
        } catch {
          /* connection release also drops the legacy response lock */
        }
        client.release()
        throw error
      }
    }
    return {
      ciphertext: new Uint8Array(row.ciphertext),
      complete: async () => {
        if (settled) return
        settled = true
        await settle(true)
      },
      abandon: async (now) => {
        if (settled) return
        settled = true
        await settle(now >= row.expires_at)
      },
    }
  }

  override async revoke(input: { pairingId: PersonalPairingId; capability: AttachmentCapability }): Promise<void> {
    await this.flushQuotaReleases()
    await this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id, claim_token
           FROM remote_attachment_blobs
          WHERE database_identity = $1 AND capability_digest = $2
          FOR UPDATE`,
        [this.databaseIdentity, digest(input.capability)],
      )
      const row = attachmentRow(selected.rows[0], this.maxBlobBytes)
      if (row === undefined) return
      if (row.pairing_id !== input.pairingId) throw pairingMismatch()
      const removed = await client.query(
        `DELETE FROM remote_attachment_blobs
          WHERE database_identity = $1 AND capability_digest = $2
        RETURNING quota_reservation_id`,
        [this.databaseIdentity, digest(input.capability)],
      )
      await this.recordQuotaReleases(client, removed.rows)
    })
    await this.flushQuotaReleases()
  }

  override async observe(): Promise<readonly RemoteAttachmentBlob[]> {
    const selected = await this.pool.query(
      `SELECT capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id, claim_token
         FROM remote_attachment_blobs
        WHERE database_identity = $1
        ORDER BY expires_at, pairing_id`,
      [this.databaseIdentity],
    )
    return selected.rows.map((value) => {
      const row = attachmentRow(value, this.maxBlobBytes)
      if (row === undefined) throw new TypeError('PostgreSQL remote attachment row is invalid')
      return {
        capabilityDigest: new Uint8Array(row.capability_digest),
        pairingId: row.pairing_id,
        ciphertext: new Uint8Array(row.ciphertext),
        expiresAt: row.expires_at,
      }
    })
  }

  private async loadRequiredRow(
    client: PlatformSqlClient,
    input: { pairingId: PersonalPairingId; capability: AttachmentCapability },
    lock: boolean,
  ): Promise<AttachmentRow> {
    const selected = await client.query(
      `SELECT capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id, claim_token
         FROM remote_attachment_blobs
        WHERE database_identity = $1 AND capability_digest = $2${lock ? ' FOR UPDATE' : ''}`,
      [this.databaseIdentity, digest(input.capability)],
    )
    const row = attachmentRow(selected.rows[0], this.maxBlobBytes)
    if (row === undefined) {
      throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability is unknown, consumed, or revoked')
    }
    if (row.pairing_id !== input.pairingId) throw pairingMismatch()
    return row
  }

  private async lockCapacity(client: PlatformSqlClient): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`remote-attachments:${this.databaseIdentity}`])
  }

  private async readPublishOutcome(
    capabilityDigest: Uint8Array,
    input: {
      pairingId: PersonalPairingId
      ciphertext: Uint8Array
      quota?: RemoteAttachmentQuotaReservation
    },
    expiresAt: number,
  ): Promise<'committed' | 'absent'> {
    const selected = await this.pool.query(
      `SELECT capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id, claim_token
         FROM remote_attachment_blobs
        WHERE database_identity = $1 AND capability_digest = $2`,
      [this.databaseIdentity, capabilityDigest],
    )
    if (selected.rows.length === 0) return 'absent'
    if (selected.rows.length !== 1) throw new TypeError('PostgreSQL attachment publish readback is invalid')
    const row = attachmentRow(selected.rows[0], this.maxBlobBytes)
    if (row === undefined
      || row.pairing_id !== input.pairingId
      || !sameBytes(row.capability_digest, capabilityDigest)
      || !sameBytes(row.ciphertext, input.ciphertext)
      || row.expires_at !== expiresAt
      || row.quota_reservation_id !== input.quota?.id) {
      throw new TypeError('PostgreSQL attachment publish readback is invalid')
    }
    return 'committed'
  }

  private async finishCommittedPublish(
    capability: AttachmentCapability,
    byteLength: number,
    expiresAt: number,
  ): Promise<RemoteAttachmentGrant> {
    try {
      await this.flushQuotaReleases()
    } catch (cleanupError) {
      console.error('[platform] PostgreSQL attachment quota cleanup after committed publish failed:', cleanupError)
    }
    return { capability, byteLength, expiresAt }
  }

  private async recordQuotaReleases(
    client: PlatformSqlClient,
    rows: readonly Record<string, unknown>[],
  ): Promise<void> {
    for (const reservationId of reservationIds(rows)) {
      await recordAttachmentQuotaRelease(client, this.databaseIdentity, reservationId)
    }
  }

  private async flushQuotaReleases(): Promise<void> {
    await releasePendingAttachmentQuota(this.pool, this.databaseIdentity, this.quotaCleanup)
  }

  private async transaction<T>(operation: (client: PlatformSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {
        /* rollback after a failed transaction is best-effort */
      }
      throw error
    } finally {
      client.release()
    }
  }
}

function digest(capability: AttachmentCapability): Buffer {
  return createHash('sha256').update(capability).digest()
}

function attachmentRow(
  value: Record<string, unknown> | undefined,
  maxBlobBytes: number,
): AttachmentRow | undefined {
  if (value === undefined || !(value.capability_digest instanceof Uint8Array)
    || !(value.ciphertext instanceof Uint8Array) || typeof value.pairing_id !== 'string'
    || (typeof value.expires_at !== 'string' && typeof value.expires_at !== 'number')
    || (value.quota_reservation_id !== null && value.quota_reservation_id !== undefined
      && (typeof value.quota_reservation_id !== 'string' || value.quota_reservation_id === ''))
    || (value.claim_token !== null && value.claim_token !== undefined
      && (!(value.claim_token instanceof Uint8Array) || value.claim_token.byteLength !== 32))) return undefined
  const expiresAt = Number(value.expires_at)
  if (value.capability_digest.byteLength !== 32
    || value.ciphertext.byteLength === 0 || value.ciphertext.byteLength > maxBlobBytes
    || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return undefined
  try {
    return {
      capability_digest: value.capability_digest,
      pairing_id: parsePersonalPairingId(value.pairing_id),
      ciphertext: value.ciphertext,
      expires_at: expiresAt,
      ...(typeof value.quota_reservation_id === 'string'
        ? { quota_reservation_id: parseAttachmentBlobReservationId(value.quota_reservation_id) }
        : {}),
      ...(value.claim_token instanceof Uint8Array ? { claim_token: value.claim_token } : {}),
    }
  } catch {
    /* A malformed durable pairing id makes the whole row unusable. */
    return undefined
  }
}

function reservationIds(rows: readonly Record<string, unknown>[]): AttachmentBlobReservationId[] {
  return rows.flatMap(row => typeof row.quota_reservation_id === 'string'
    ? [parseAttachmentBlobReservationId(row.quota_reservation_id)] : [])
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function pairingMismatch(): RemoteAttachmentError {
  return new RemoteAttachmentError(
    'ATTACHMENT_PAIRING_MISMATCH',
    'Remote attachment capability belongs to another Personal Pairing',
  )
}
