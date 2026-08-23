/** PostgreSQL capability authority with ciphertext bytes retained only in Alibaba Cloud OSS. */

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
import type { OssObjectClient } from './oss-client.ts'
import { validateOssObjectPrefix } from './oss-config.ts'
import type { PlatformSqlClient, PlatformSqlPool } from './postgres-pairing-store.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remote_attachment_blobs (
  database_identity text NOT NULL,
  capability_digest bytea NOT NULL,
  pairing_id text NOT NULL,
  ciphertext bytea NOT NULL,
  expires_at bigint NOT NULL,
  quota_reservation_id text,
  PRIMARY KEY (database_identity, capability_digest)
);
ALTER TABLE remote_attachment_blobs ADD COLUMN IF NOT EXISTS quota_reservation_id text;
ALTER TABLE remote_attachment_blobs ADD COLUMN IF NOT EXISTS claim_token bytea;
CREATE TABLE IF NOT EXISTS remote_attachment_objects (
  database_identity text NOT NULL,
  capability_digest bytea NOT NULL,
  pairing_id text NOT NULL,
  object_key text NOT NULL,
  byte_length bigint NOT NULL,
  expires_at bigint NOT NULL,
  quota_reservation_id text,
  legacy_authority boolean NOT NULL DEFAULT false,
  claim_token bytea,
  PRIMARY KEY (database_identity, capability_digest),
  UNIQUE (database_identity, object_key)
);
ALTER TABLE remote_attachment_objects ADD COLUMN IF NOT EXISTS quota_reservation_id text;
ALTER TABLE remote_attachment_objects ADD COLUMN IF NOT EXISTS legacy_authority boolean NOT NULL DEFAULT false;
ALTER TABLE remote_attachment_objects ADD COLUMN IF NOT EXISTS claim_token bytea;
CREATE INDEX IF NOT EXISTS remote_attachment_objects_expiry
  ON remote_attachment_objects (database_identity, expires_at);
CREATE TABLE IF NOT EXISTS remote_attachment_publish_intents (
  database_identity text NOT NULL,
  capability_digest bytea NOT NULL,
  pairing_id text NOT NULL,
  object_key text NOT NULL,
  byte_length bigint NOT NULL,
  expires_at bigint NOT NULL,
  quota_reservation_id text,
  PRIMARY KEY (database_identity, capability_digest),
  UNIQUE (database_identity, object_key)
);
CREATE INDEX IF NOT EXISTS remote_attachment_publish_intents_expiry
  ON remote_attachment_publish_intents (database_identity, expires_at);
CREATE TABLE IF NOT EXISTS remote_attachment_quota_releases (
  database_identity text NOT NULL,
  reservation_id text NOT NULL,
  PRIMARY KEY (database_identity, reservation_id)
);
`

interface AttachmentRow {
  capability_digest: Uint8Array
  pairing_id: PersonalPairingId
  object_key: string
  byte_length: number
  expires_at: number
  quota_reservation_id?: AttachmentBlobReservationId
  legacy_authority: boolean
  claim_token?: Uint8Array
}

interface LegacyAttachmentRow {
  capability_digest: Uint8Array
  pairing_id: PersonalPairingId
  ciphertext: Uint8Array
  expires_at: number
  quota_reservation_id?: AttachmentBlobReservationId
  claim_token?: Uint8Array
}

interface CleanupBatch {
  objectKeys: string[]
  quotaReservationIds: AttachmentBlobReservationId[]
}

type Schedule = (handler: () => void, ms: number) => { unref(): void; cancel(): void }

/** Deployment bounds, compatibility, cleanup, and quota adapters for the operated OSS store. */
export interface OssRemoteAttachmentStoreOptions {
  maxBlobBytes: number
  capabilityLifetimeMs: number
  maxRetainedBlobs: number
  objectPrefix: string
  sweepIntervalMs: number
  cleanupConcurrency: number
  capacityRetryAfterSeconds: number
  quotaCleanup: AttachmentBlobReservationCleanup
  inactivePairingIds(candidates: readonly PersonalPairingId[]): Promise<readonly PersonalPairingId[]>
  clock?: { now(): number }
  schedule?: Schedule
}

/** One-time pairing-scoped attachment store with rolling legacy compatibility. */
export class OssRemoteAttachmentStore extends RemoteAttachmentStoreService {
  readonly maxBlobBytes: number
  readonly capabilityLifetimeMs: number
  private readonly maxRetainedBlobs: number
  private readonly objectPrefix: string
  private readonly sweepIntervalMs: number
  private readonly cleanupConcurrency: number
  private readonly capacityRetryAfterSeconds: number
  private readonly quotaCleanup: AttachmentBlobReservationCleanup
  private readonly inactivePairingIds: (candidates: readonly PersonalPairingId[]) => Promise<readonly PersonalPairingId[]>
  private readonly clock: { now(): number }
  private readonly schedule: Schedule
  private readonly cleanupQueue: Array<{ key: string; kind: 'object' | 'quota' }> = []
  private readonly queuedCleanup = new Set<string>()
  private readonly cleanupWorkers = new Set<Promise<void>>()
  private sweepTimer: ReturnType<Schedule> | undefined
  private sweepOperation: Promise<void> | undefined
  private disposed = false

  /**
   * @param ctx - Platform context.
   * @param databaseIdentity - deployment namespace.
   * @param pool - shared PostgreSQL.
   * @param objects - private OSS adapter.
   * @param options - validated bounds and cleanup owners.
   */
  constructor(
    ctx: Context,
    private readonly databaseIdentity: string,
    private readonly pool: PlatformSqlPool,
    private readonly objects: OssObjectClient,
    options: OssRemoteAttachmentStoreOptions,
  ) {
    super(ctx)
    this.maxBlobBytes = options.maxBlobBytes
    this.capabilityLifetimeMs = options.capabilityLifetimeMs
    this.objectPrefix = validateOssObjectPrefix(options.objectPrefix)
    this.sweepIntervalMs = positiveInteger(options.sweepIntervalMs, 'sweepIntervalMs')
    this.cleanupConcurrency = positiveInteger(options.cleanupConcurrency, 'cleanupConcurrency')
    this.capacityRetryAfterSeconds = positiveInteger(options.capacityRetryAfterSeconds, 'capacityRetryAfterSeconds')
    this.quotaCleanup = options.quotaCleanup
    this.inactivePairingIds = async candidates => await options.inactivePairingIds(candidates)
    this.clock = options.clock ?? { now: () => Date.now() }
    this.schedule = options.schedule ?? ((handler, ms) => {
      const timer = setTimeout(handler, ms)
      return { unref: () => { timer.unref() }, cancel: () => { clearTimeout(timer) } }
    })
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes <= 0
      || this.maxBlobBytes > REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes) {
      throw new TypeError('OSS remote attachment maxBlobBytes exceeds the protocol ceiling')
    }
    if (!Number.isSafeInteger(this.capabilityLifetimeMs) || this.capabilityLifetimeMs <= 0
      || this.capabilityLifetimeMs > REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs) {
      throw new TypeError('OSS remote attachment capabilityLifetimeMs exceeds the protocol ceiling')
    }
    this.maxRetainedBlobs = positiveInteger(options.maxRetainedBlobs, 'maxRetainedBlobs')
    ctx.effect(() => async () => { await this.dispose() }, 'platform: OSS attachment cleanup')
  }

  /** Create additive compatibility state and start active expiry and revocation cleanup. */
  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA)
    await this.sweep()
    this.armSweep()
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
    const objectKey = `${this.objectPrefix}/${capabilityDigest.toString('hex')}`
    const expiresAt = input.now + this.capabilityLifetimeMs
    let objectWritten = false
    try {
      const cleanup = await this.reservePublishIntent({
        capabilityDigest,
        pairingId: input.pairingId,
        objectKey,
        byteLength: input.ciphertext.byteLength,
        now: input.now,
        expiresAt,
        ...(input.quota === undefined ? {} : { quotaReservationId: input.quota.id }),
      })
      this.queueCleanup(cleanup)
      await this.objects.putObject(objectKey, input.ciphertext, expiresAt)
      objectWritten = true
      await this.commitPublishIntent({
        capabilityDigest,
        pairingId: input.pairingId,
        objectKey,
        ciphertext: input.ciphertext,
        expiresAt,
        ...(input.quota === undefined ? {} : { quotaReservationId: input.quota.id }),
      })
    } catch (error) {
      const retained = objectWritten && await this.metadataReferences(capabilityDigest, objectKey)
      if (!retained) {
        if (objectWritten) await this.deleteObjectAfterAuthority(objectKey)
        try {
          await input.quota?.release()
        } catch (cleanupError) {
          console.error('[platform] attachment quota cleanup after publish failure failed:', cleanupError)
        }
      }
      throw error
    }
    return { capability, byteLength: input.ciphertext.byteLength, expiresAt }
  }

  override async inspect(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<Uint8Array> {
    const capabilityDigest = digest(input.capability)
    const [objectRow, legacyRow] = await Promise.all([
      this.loadObjectRow(this.pool, capabilityDigest, false),
      this.loadLegacyRow(this.pool, capabilityDigest, false),
    ])
    if (objectRow !== undefined) {
      this.requirePairing(objectRow.pairing_id, input.pairingId)
      if (input.now >= objectRow.expires_at) return await this.expireAndThrow(input.capability)
      if (objectRow.claim_token !== undefined
        || (objectRow.legacy_authority && legacyRow === undefined)) throw invalidCapability()
      return await this.readCiphertext(objectRow)
    }
    if (legacyRow === undefined) throw invalidCapability()
    this.requirePairing(legacyRow.pairing_id, input.pairingId)
    if (input.now >= legacyRow.expires_at) return await this.expireAndThrow(input.capability)
    if (legacyRow.claim_token !== undefined) throw invalidCapability()
    return new Uint8Array(legacyRow.ciphertext)
  }

  override async consume(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<RemoteAttachmentConsumption> {
    const capabilityDigest = digest(input.capability)
    const claim = await this.claim(capabilityDigest, input.pairingId, input.now)
    if (claim.kind === 'legacy') return this.legacyConsumption(capabilityDigest, claim.row, claim.token)
    let ciphertext: Uint8Array
    try {
      ciphertext = await this.readCiphertext(claim.row)
    } catch (error) {
      await this.abandonObjectClaim(capabilityDigest, claim, undefined, this.clock.now())
      throw error
    }
    if (claim.row.legacy_authority) {
      const reserved = await this.reserveLegacyAuthority(capabilityDigest, claim, input.pairingId, input.now)
      if (!reserved) throw invalidCapability()
    }
    let settled = false
    return {
      ciphertext,
      complete: async () => {
        if (settled) return
        settled = true
        const cleanup = await this.completeObjectClaim(capabilityDigest, claim.token)
        await this.finishCleanup(cleanup)
      },
      abandon: async (now) => {
        if (settled) return
        settled = true
        const cleanup = await this.abandonObjectClaim(capabilityDigest, claim, ciphertext, now)
        await this.finishCleanup(cleanup)
      },
    }
  }

  override async revoke(input: { pairingId: PersonalPairingId; capability: AttachmentCapability }): Promise<void> {
    const capabilityDigest = digest(input.capability)
    const cleanup = await this.transaction(async (client) => {
      const objectRow = await this.loadObjectRow(client, capabilityDigest, true)
      const legacyRow = await this.loadLegacyRow(client, capabilityDigest, true)
      if (objectRow === undefined && legacyRow === undefined) return emptyCleanup()
      const row = objectRow ?? legacyRow as LegacyAttachmentRow
      this.requirePairing(row.pairing_id, input.pairingId)
      return await this.deleteCapability(client, capabilityDigest, objectRow, legacyRow)
    })
    await this.finishCleanup(cleanup)
  }

  override async observe(): Promise<readonly RemoteAttachmentBlob[]> {
    const [objects, legacy] = await Promise.all([
      this.pool.query(
        `SELECT capability_digest, pairing_id, object_key, byte_length, expires_at,
                quota_reservation_id, legacy_authority, claim_token
           FROM remote_attachment_objects
          WHERE database_identity = $1
          ORDER BY expires_at, pairing_id`,
        [this.databaseIdentity],
      ),
      this.pool.query(
        `SELECT capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id
           FROM remote_attachment_blobs
          WHERE database_identity = $1
          ORDER BY expires_at, pairing_id`,
        [this.databaseIdentity],
      ),
    ])
    const seen = new Set<string>()
    const projected: RemoteAttachmentBlob[] = []
    for (const value of objects.rows) {
      const row = this.attachmentRow(value)
      if (row === undefined) throw new TypeError('OSS remote attachment row is invalid')
      seen.add(Buffer.from(row.capability_digest).toString('hex'))
      projected.push({
        capabilityDigest: new Uint8Array(row.capability_digest), pairingId: row.pairing_id,
        ciphertext: await this.readCiphertext(row), expiresAt: row.expires_at,
      })
    }
    for (const value of legacy.rows) {
      const row = this.legacyAttachmentRow(value)
      if (row === undefined) throw new TypeError('legacy remote attachment row is invalid')
      if (seen.has(Buffer.from(row.capability_digest).toString('hex'))) continue
      projected.push({
        capabilityDigest: new Uint8Array(row.capability_digest), pairingId: row.pairing_id,
        ciphertext: new Uint8Array(row.ciphertext), expiresAt: row.expires_at,
      })
    }
    return projected
  }

  private async reservePublishIntent(input: {
    capabilityDigest: Buffer
    pairingId: PersonalPairingId
    objectKey: string
    byteLength: number
    now: number
    expiresAt: number
    quotaReservationId?: AttachmentBlobReservationId
  }): Promise<CleanupBatch> {
    return await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`remote-attachments:${this.databaseIdentity}`])
      const cleanup = await this.retire(client, input.now)
      const counted = await client.query(
        `SELECT COUNT(*)::text AS count FROM (
           SELECT capability_digest FROM remote_attachment_objects WHERE database_identity = $1
           UNION
           SELECT capability_digest FROM remote_attachment_blobs WHERE database_identity = $1
           UNION
           SELECT capability_digest FROM remote_attachment_publish_intents WHERE database_identity = $1
         ) AS retained`,
        [this.databaseIdentity],
      )
      if (Number(counted.rows[0]?.count ?? 0) >= this.maxRetainedBlobs) {
        throw new RemoteAttachmentError(
          'PLATFORM_CAPACITY',
          'Platform attachment store is at capacity',
          this.capacityRetryAfterSeconds,
        )
      }
      await client.query(
        `INSERT INTO remote_attachment_publish_intents (
           database_identity, capability_digest, pairing_id, object_key, byte_length, expires_at,
           quota_reservation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [this.databaseIdentity, input.capabilityDigest, input.pairingId, input.objectKey,
          input.byteLength, input.expiresAt, input.quotaReservationId ?? null],
      )
      return cleanup
    })
  }

  private async commitPublishIntent(input: {
    capabilityDigest: Buffer
    pairingId: PersonalPairingId
    objectKey: string
    ciphertext: Uint8Array
    expiresAt: number
    quotaReservationId?: AttachmentBlobReservationId
  }): Promise<void> {
    await this.transaction(async (client) => {
      const intent = await client.query(
        `DELETE FROM remote_attachment_publish_intents
          WHERE database_identity = $1 AND capability_digest = $2
            AND pairing_id = $3 AND object_key = $4 AND byte_length = $5 AND expires_at = $6
            AND quota_reservation_id IS NOT DISTINCT FROM $7
        RETURNING capability_digest`,
        [this.databaseIdentity, input.capabilityDigest, input.pairingId, input.objectKey,
          input.ciphertext.byteLength, input.expiresAt, input.quotaReservationId ?? null],
      )
      if (intent.rowCount !== 1) throw new TypeError('OSS attachment publish intent is unavailable')
      await client.query(
        `INSERT INTO remote_attachment_objects (
           database_identity, capability_digest, pairing_id, object_key, byte_length, expires_at,
           quota_reservation_id, legacy_authority, claim_token
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,NULL)`,
        [this.databaseIdentity, input.capabilityDigest, input.pairingId, input.objectKey,
          input.ciphertext.byteLength, input.expiresAt, input.quotaReservationId ?? null],
      )
      await client.query(
        `INSERT INTO remote_attachment_blobs (
           database_identity, capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [this.databaseIdentity, input.capabilityDigest, input.pairingId,
          Buffer.from(input.ciphertext), input.expiresAt, input.quotaReservationId ?? null],
      )
    })
  }

  private async claim(
    capabilityDigest: Buffer,
    pairingId: PersonalPairingId,
    now: number,
  ): Promise<
    { kind: 'object'; row: AttachmentRow; token: Buffer }
    | { kind: 'legacy'; row: LegacyAttachmentRow; token: Buffer }
  > {
    const result = await this.transaction(async (client) => {
      const objectRow = await this.loadObjectRow(client, capabilityDigest, true)
      const legacyRow = await this.loadLegacyRow(client, capabilityDigest, true)
      if (objectRow === undefined && legacyRow === undefined) throw invalidCapability()
      const row = objectRow ?? legacyRow as LegacyAttachmentRow
      this.requirePairing(row.pairing_id, pairingId)
      if (now >= row.expires_at) {
        return { expired: await this.deleteCapability(client, capabilityDigest, objectRow, legacyRow) } as const
      }
      if (objectRow !== undefined) {
        if (objectRow.claim_token !== undefined) throw invalidCapability()
        const token = randomBytes(32)
        if (objectRow.legacy_authority) {
          if (legacyRow === undefined || legacyRow.claim_token !== undefined) throw invalidCapability()
          const claimedLegacy = await client.query(
            `UPDATE remote_attachment_blobs SET claim_token = $3
              WHERE database_identity = $1 AND capability_digest = $2 AND claim_token IS NULL`,
            [this.databaseIdentity, capabilityDigest, token],
          )
          if (claimedLegacy.rowCount !== 1) throw invalidCapability()
        }
        const updated = await client.query(
          `UPDATE remote_attachment_objects SET claim_token = $3
            WHERE database_identity = $1 AND capability_digest = $2 AND claim_token IS NULL`,
          [this.databaseIdentity, capabilityDigest, token],
        )
        if (updated.rowCount !== 1) throw invalidCapability()
        return { claimed: { kind: 'object' as const, row: objectRow, token } }
      }
      if (legacyRow?.claim_token !== undefined) throw invalidCapability()
      const token = randomBytes(32)
      const claimedLegacy = await client.query(
        `UPDATE remote_attachment_blobs SET claim_token = $3
          WHERE database_identity = $1 AND capability_digest = $2 AND claim_token IS NULL`,
        [this.databaseIdentity, capabilityDigest, token],
      )
      if (claimedLegacy.rowCount !== 1) throw invalidCapability()
      return { claimed: { kind: 'legacy' as const, row: legacyRow as LegacyAttachmentRow, token } }
    })
    if ('expired' in result) {
      await this.finishCleanup(result.expired)
      throw expiredCapability()
    }
    return result.claimed
  }

  private async reserveLegacyAuthority(
    capabilityDigest: Buffer,
    claim: { row: AttachmentRow; token: Buffer },
    pairingId: PersonalPairingId,
    now: number,
  ): Promise<boolean> {
    const outcome = await this.transaction(async (client) => {
      const current = await this.loadObjectRow(client, capabilityDigest, true)
      if (current === undefined || !sameBytes(current.claim_token, claim.token)) return { reserved: false, cleanup: emptyCleanup() }
      const legacy = await this.loadLegacyRow(client, capabilityDigest, true)
      if (legacy === undefined || !sameBytes(legacy.claim_token, claim.token)) {
        return { reserved: false, cleanup: await this.deleteCapability(client, capabilityDigest, current, undefined) }
      }
      this.requirePairing(legacy.pairing_id, pairingId)
      if (now >= legacy.expires_at) {
        return { reserved: false, cleanup: await this.deleteCapability(client, capabilityDigest, current, legacy) }
      }
      await client.query(
        'DELETE FROM remote_attachment_blobs WHERE database_identity = $1 AND capability_digest = $2',
        [this.databaseIdentity, capabilityDigest],
      )
      return { reserved: true, cleanup: emptyCleanup() }
    })
    await this.finishCleanup(outcome.cleanup)
    return outcome.reserved
  }

  private legacyConsumption(
    capabilityDigest: Buffer,
    row: LegacyAttachmentRow,
    token: Uint8Array,
  ): RemoteAttachmentConsumption {
    let settled = false
    return {
      ciphertext: new Uint8Array(row.ciphertext),
      complete: async () => {
        if (settled) return
        settled = true
        const cleanup = await this.transaction(async (client) => {
          const removed = await client.query(
            `DELETE FROM remote_attachment_blobs
              WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3`,
            [this.databaseIdentity, capabilityDigest, token],
          )
          return removed.rowCount === 1
            ? await this.recordQuotaCleanup(client, row.quota_reservation_id)
            : emptyCleanup()
        })
        await this.finishCleanup(cleanup)
      },
      abandon: async (now) => {
        if (settled) return
        settled = true
        const cleanup = await this.transaction(async (client) => {
          if (now >= row.expires_at) {
            const removed = await client.query(
              `DELETE FROM remote_attachment_blobs
                WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3`,
              [this.databaseIdentity, capabilityDigest, token],
            )
            return removed.rowCount === 1
              ? await this.recordQuotaCleanup(client, row.quota_reservation_id)
              : emptyCleanup()
          }
          await client.query(
            `UPDATE remote_attachment_blobs SET claim_token = NULL
              WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3`,
            [this.databaseIdentity, capabilityDigest, token],
          )
          return emptyCleanup()
        })
        await this.finishCleanup(cleanup)
      },
    }
  }

  private async completeObjectClaim(capabilityDigest: Buffer, token: Uint8Array): Promise<CleanupBatch> {
    return await this.transaction(async (client) => {
      const current = await this.loadObjectRow(client, capabilityDigest, true)
      if (current === undefined || !sameBytes(current.claim_token, token)) return emptyCleanup()
      return await this.deleteCapability(client, capabilityDigest, current, undefined)
    })
  }

  private async abandonObjectClaim(
    capabilityDigest: Buffer,
    claim: { row: AttachmentRow; token: Uint8Array },
    ciphertext: Uint8Array | undefined,
    now: number,
  ): Promise<CleanupBatch> {
    return await this.transaction(async (client) => {
      const current = await this.loadObjectRow(client, capabilityDigest, true)
      if (current === undefined || !sameBytes(current.claim_token, claim.token)) return emptyCleanup()
      if (now >= current.expires_at) return await this.deleteCapability(client, capabilityDigest, current, undefined)
      if (current.legacy_authority && ciphertext !== undefined) {
        await client.query(
          `INSERT INTO remote_attachment_blobs (
             database_identity, capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (database_identity, capability_digest) DO NOTHING`,
          [this.databaseIdentity, capabilityDigest, current.pairing_id, Buffer.from(ciphertext),
            current.expires_at, current.quota_reservation_id ?? null],
        )
      } else if (current.legacy_authority) {
        await client.query(
          `UPDATE remote_attachment_blobs SET claim_token = NULL
            WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3`,
          [this.databaseIdentity, capabilityDigest, claim.token],
        )
      }
      await client.query(
        `UPDATE remote_attachment_objects SET claim_token = NULL
          WHERE database_identity = $1 AND capability_digest = $2 AND claim_token = $3`,
        [this.databaseIdentity, capabilityDigest, claim.token],
      )
      return emptyCleanup()
    })
  }

  private async deleteCapability(
    client: PlatformSqlClient,
    capabilityDigest: Uint8Array,
    objectRow: AttachmentRow | undefined,
    legacyRow: LegacyAttachmentRow | undefined,
  ): Promise<CleanupBatch> {
    await client.query(
      'DELETE FROM remote_attachment_objects WHERE database_identity = $1 AND capability_digest = $2',
      [this.databaseIdentity, capabilityDigest],
    )
    await client.query(
      'DELETE FROM remote_attachment_blobs WHERE database_identity = $1 AND capability_digest = $2',
      [this.databaseIdentity, capabilityDigest],
    )
    return await this.recordQuotaCleanup(
      client,
      objectRow?.quota_reservation_id ?? legacyRow?.quota_reservation_id,
      objectRow?.object_key,
    )
  }

  private async recordQuotaCleanup(
    client: PlatformSqlClient,
    reservationId?: AttachmentBlobReservationId,
    objectKey?: string,
  ): Promise<CleanupBatch> {
    if (reservationId !== undefined) {
      await client.query(
        `INSERT INTO remote_attachment_quota_releases (database_identity, reservation_id)
         VALUES ($1,$2) ON CONFLICT (database_identity, reservation_id) DO NOTHING`,
        [this.databaseIdentity, reservationId],
      )
    }
    return {
      objectKeys: objectKey === undefined ? [] : [objectKey],
      quotaReservationIds: reservationId === undefined ? [] : [reservationId],
    }
  }

  private async retire(
    client: PlatformSqlClient,
    now: number,
    inactivePairingIds: readonly PersonalPairingId[] = [],
  ): Promise<CleanupBatch> {
    const retirePairings = inactivePairingIds.length > 0
    const objects = await client.query(
      `DELETE FROM remote_attachment_objects AS object
        WHERE object.database_identity = $1
          AND (object.expires_at <= $2
            OR ($3::boolean AND object.pairing_id = ANY($4::text[]))
            OR (object.legacy_authority AND object.claim_token IS NULL AND NOT EXISTS (
              SELECT 1 FROM remote_attachment_blobs AS legacy
               WHERE legacy.database_identity = object.database_identity
                 AND legacy.capability_digest = object.capability_digest
            )))
       RETURNING object_key, quota_reservation_id`,
      [this.databaseIdentity, now, retirePairings, inactivePairingIds],
    )
    const legacy = await client.query(
      `DELETE FROM remote_attachment_blobs
        WHERE database_identity = $1
          AND (expires_at <= $2 OR ($3::boolean AND pairing_id = ANY($4::text[])))
       RETURNING quota_reservation_id`,
      [this.databaseIdentity, now, retirePairings, inactivePairingIds],
    )
    const intents = await client.query(
      `DELETE FROM remote_attachment_publish_intents
        WHERE database_identity = $1
          AND (expires_at <= $2 OR ($3::boolean AND pairing_id = ANY($4::text[])))
       RETURNING object_key, quota_reservation_id`,
      [this.databaseIdentity, now, retirePairings, inactivePairingIds],
    )
    const reservationIds = new Set<AttachmentBlobReservationId>()
    for (const row of [...objects.rows, ...legacy.rows, ...intents.rows]) {
      if (typeof row.quota_reservation_id === 'string') {
        reservationIds.add(parseAttachmentBlobReservationId(row.quota_reservation_id))
      }
    }
    for (const reservationId of reservationIds) await this.recordQuotaCleanup(client, reservationId)
    return {
      objectKeys: [...objects.rows, ...intents.rows]
        .flatMap(row => typeof row.object_key === 'string' ? [row.object_key] : []),
      quotaReservationIds: [...reservationIds],
    }
  }

  private async expireAndThrow(capability: AttachmentCapability): Promise<never> {
    const capabilityDigest = digest(capability)
    const cleanup = await this.transaction(async (client) => {
      const objectRow = await this.loadObjectRow(client, capabilityDigest, true)
      const legacyRow = await this.loadLegacyRow(client, capabilityDigest, true)
      return await this.deleteCapability(client, capabilityDigest, objectRow, legacyRow)
    })
    await this.finishCleanup(cleanup)
    throw expiredCapability()
  }

  private async readCiphertext(row: AttachmentRow): Promise<Uint8Array> {
    const ciphertext = await this.objects.getObject(row.object_key, row.byte_length)
    if (ciphertext.byteLength !== row.byte_length) {
      throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment ciphertext length is invalid')
    }
    return ciphertext
  }

  private async metadataReferences(capabilityDigest: Uint8Array, objectKey: string): Promise<boolean> {
    try {
      const selected = await this.pool.query(
        `SELECT object_key FROM remote_attachment_objects
          WHERE database_identity = $1 AND capability_digest = $2
         UNION ALL
         SELECT object_key FROM remote_attachment_publish_intents
          WHERE database_identity = $1 AND capability_digest = $2`,
        [this.databaseIdentity, capabilityDigest],
      )
      if (selected.rows.length === 0) return false
      return selected.rows[0]?.object_key === objectKey
    } catch {
      // Commit outcome is unknown; retaining an orphan is safer than deleting a referenced object.
      return true
    }
  }

  private async loadObjectRow(
    client: PlatformSqlClient,
    capabilityDigest: Uint8Array,
    lock: boolean,
  ): Promise<AttachmentRow | undefined> {
    const selected = await client.query(
      `SELECT capability_digest, pairing_id, object_key, byte_length, expires_at,
              quota_reservation_id, legacy_authority, claim_token
         FROM remote_attachment_objects
        WHERE database_identity = $1 AND capability_digest = $2${lock ? ' FOR UPDATE' : ''}`,
      [this.databaseIdentity, capabilityDigest],
    )
    const value = selected.rows[0]
    if (value === undefined) return undefined
    const row = this.attachmentRow(value)
    if (row === undefined) throw new TypeError('OSS remote attachment row is invalid')
    return row
  }

  private async loadLegacyRow(
    client: PlatformSqlClient,
    capabilityDigest: Uint8Array,
    lock: boolean,
  ): Promise<LegacyAttachmentRow | undefined> {
    const selected = await client.query(
      `SELECT capability_digest, pairing_id, ciphertext, expires_at, quota_reservation_id, claim_token
         FROM remote_attachment_blobs
        WHERE database_identity = $1 AND capability_digest = $2${lock ? ' FOR UPDATE' : ''}`,
      [this.databaseIdentity, capabilityDigest],
    )
    const value = selected.rows[0]
    if (value === undefined) return undefined
    const row = this.legacyAttachmentRow(value)
    if (row === undefined) throw new TypeError('legacy remote attachment row is invalid')
    return row
  }

  private attachmentRow(value: Record<string, unknown>): AttachmentRow | undefined {
    if (!(value.capability_digest instanceof Uint8Array)
      || typeof value.pairing_id !== 'string' || typeof value.object_key !== 'string'
      || (typeof value.byte_length !== 'string' && typeof value.byte_length !== 'number')
      || (typeof value.expires_at !== 'string' && typeof value.expires_at !== 'number')
      || typeof value.legacy_authority !== 'boolean'
      || (value.claim_token !== null && value.claim_token !== undefined && !(value.claim_token instanceof Uint8Array))
      || (value.quota_reservation_id !== null && value.quota_reservation_id !== undefined
        && (typeof value.quota_reservation_id !== 'string' || value.quota_reservation_id === ''))
      || (value.claim_token !== null && value.claim_token !== undefined
        && (!(value.claim_token instanceof Uint8Array) || value.claim_token.byteLength !== 32))) return undefined
    const byteLength = Number(value.byte_length)
    const expiresAt = Number(value.expires_at)
    const expectedKey = `${this.objectPrefix}/${Buffer.from(value.capability_digest).toString('hex')}`
    if (value.capability_digest.byteLength !== 32 || value.object_key !== expectedKey
      || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > this.maxBlobBytes
      || !Number.isSafeInteger(expiresAt) || expiresAt <= 0
      || (value.claim_token instanceof Uint8Array && value.claim_token.byteLength !== 32)) return undefined
    try {
      return {
        capability_digest: value.capability_digest,
        pairing_id: parsePersonalPairingId(value.pairing_id),
        object_key: value.object_key,
        byte_length: byteLength,
        expires_at: expiresAt,
        legacy_authority: value.legacy_authority,
        ...(typeof value.quota_reservation_id === 'string'
          ? { quota_reservation_id: parseAttachmentBlobReservationId(value.quota_reservation_id) }
          : {}),
        ...(value.claim_token instanceof Uint8Array ? { claim_token: value.claim_token } : {}),
        ...(value.claim_token instanceof Uint8Array ? { claim_token: value.claim_token } : {}),
      }
    } catch {
      return undefined
    }
  }

  private legacyAttachmentRow(value: Record<string, unknown>): LegacyAttachmentRow | undefined {
    if (!(value.capability_digest instanceof Uint8Array) || !(value.ciphertext instanceof Uint8Array)
      || typeof value.pairing_id !== 'string'
      || (typeof value.expires_at !== 'string' && typeof value.expires_at !== 'number')
      || (value.quota_reservation_id !== null && value.quota_reservation_id !== undefined
        && (typeof value.quota_reservation_id !== 'string' || value.quota_reservation_id === ''))
      || (value.claim_token !== null && value.claim_token !== undefined
        && (!(value.claim_token instanceof Uint8Array) || value.claim_token.byteLength !== 32))) return undefined
    const expiresAt = Number(value.expires_at)
    if (value.capability_digest.byteLength !== 32 || value.ciphertext.byteLength === 0
      || value.ciphertext.byteLength > this.maxBlobBytes || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return undefined
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
      return undefined
    }
  }

  private requirePairing(actual: PersonalPairingId, expected: PersonalPairingId): void {
    if (actual !== expected) throw pairingMismatch()
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
        /* rollback after a failed metadata transaction is best-effort */
      }
      throw error
    } finally {
      client.release()
    }
  }

  private armSweep(): void {
    if (this.disposed || this.sweepTimer !== undefined) return
    this.sweepTimer = this.schedule(() => {
      this.sweepTimer = undefined
      const operation = this.sweep()
      this.sweepOperation = operation
      void operation.catch((error: unknown) => {
        console.error('[platform] OSS attachment sweep failed:', error)
      }).finally(() => {
        if (this.sweepOperation === operation) this.sweepOperation = undefined
        this.armSweep()
      })
    }, this.sweepIntervalMs)
    this.sweepTimer.unref()
  }

  private async sweep(): Promise<void> {
    const candidates = await this.pool.query(
      `SELECT DISTINCT pairing_id FROM (
         SELECT pairing_id FROM remote_attachment_objects WHERE database_identity = $1
         UNION ALL
         SELECT pairing_id FROM remote_attachment_blobs WHERE database_identity = $1
         UNION ALL
         SELECT pairing_id FROM remote_attachment_publish_intents WHERE database_identity = $1
       ) AS retained ORDER BY pairing_id`,
      [this.databaseIdentity],
    )
    const pairingIds = candidates.rows.map((row) => {
      if (typeof row.pairing_id !== 'string') throw new TypeError('remote attachment pairing id is invalid')
      return parsePersonalPairingId(row.pairing_id)
    })
    const inactive = await this.inactivePairingIds(pairingIds)
    const candidateSet = new Set(pairingIds)
    if (inactive.some(pairingId => !candidateSet.has(pairingId))) {
      throw new TypeError('inactive attachment pairing id was not a sweep candidate')
    }
    const cleanup = await this.transaction(async client => await this.retire(client, this.clock.now(), inactive))
    const pending = await this.pool.query(
      `SELECT reservation_id FROM remote_attachment_quota_releases
        WHERE database_identity = $1 ORDER BY reservation_id`,
      [this.databaseIdentity],
    )
    cleanup.quotaReservationIds.push(...pending.rows.flatMap(row =>
      typeof row.reservation_id === 'string' ? [parseAttachmentBlobReservationId(row.reservation_id)] : []))
    this.queueCleanup(cleanup)
  }

  private queueCleanup(cleanup: CleanupBatch): void {
    for (const objectKey of cleanup.objectKeys) this.queueCleanupItem('object', objectKey)
    for (const reservationId of cleanup.quotaReservationIds) this.queueCleanupItem('quota', reservationId)
    this.pumpCleanup()
  }

  private queueCleanupItem(kind: 'object' | 'quota', key: string): void {
    const identity = `${kind}:${key}`
    if (this.queuedCleanup.has(identity)) return
    this.queuedCleanup.add(identity)
    this.cleanupQueue.push({ kind, key })
  }

  private pumpCleanup(): void {
    while (this.cleanupWorkers.size < this.cleanupConcurrency) {
      const item = this.cleanupQueue.shift()
      if (item === undefined) return
      const identity = `${item.kind}:${item.key}`
      const worker = this.runCleanup(item).catch((error: unknown) => {
        console.error(`[platform] attachment ${item.kind} cleanup failed:`, error)
      }).finally(() => {
        this.queuedCleanup.delete(identity)
        this.cleanupWorkers.delete(worker)
        this.pumpCleanup()
      })
      this.cleanupWorkers.add(worker)
    }
  }

  private async runCleanup(item: { kind: 'object' | 'quota'; key: string }): Promise<void> {
    if (item.kind === 'object') {
      await this.objects.deleteObject(item.key)
      return
    }
    await this.quotaCleanup.release(parseAttachmentBlobReservationId(item.key))
    await this.pool.query(
      'DELETE FROM remote_attachment_quota_releases WHERE database_identity = $1 AND reservation_id = $2',
      [this.databaseIdentity, item.key],
    )
  }

  private async finishCleanup(cleanup: CleanupBatch): Promise<void> {
    for (const objectKey of cleanup.objectKeys) await this.deleteObjectAfterAuthority(objectKey)
    for (const reservationId of cleanup.quotaReservationIds) {
      try { await this.runCleanup({ kind: 'quota', key: reservationId }) } catch {
        // The durable quota-release row is retried by the active sweep.
        console.error('[platform] attachment quota cleanup failed')
      }
    }
  }

  private async deleteObjectAfterAuthority(key: string): Promise<void> {
    try { await this.objects.deleteObject(key) } catch {
      // Bucket lifecycle expiry owns recovery after metadata authority is gone.
      console.error('[platform] OSS attachment cleanup failed')
    }
  }

  private async dispose(): Promise<void> {
    this.disposed = true
    this.sweepTimer?.cancel()
    this.sweepTimer = undefined
    await this.sweepOperation
    this.pumpCleanup()
    while (this.cleanupWorkers.size > 0 || this.cleanupQueue.length > 0) {
      await Promise.allSettled([...this.cleanupWorkers])
      this.pumpCleanup()
    }
  }
}

function digest(capability: AttachmentCapability): Buffer {
  return createHash('sha256').update(capability).digest()
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`OSS remote attachment ${name} must be positive`)
  return value
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left !== undefined && left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function emptyCleanup(): CleanupBatch { return { objectKeys: [], quotaReservationIds: [] } }

function invalidCapability(): RemoteAttachmentError {
  return new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability is unknown, consumed, revoked, or in use')
}

function pairingMismatch(): RemoteAttachmentError {
  return new RemoteAttachmentError(
    'ATTACHMENT_PAIRING_MISMATCH',
    'Remote attachment capability belongs to another Personal Pairing',
  )
}

function expiredCapability(): RemoteAttachmentError {
  return new RemoteAttachmentError('ATTACHMENT_EXPIRED', 'Remote attachment capability has expired')
}
