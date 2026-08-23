/** PostgreSQL capability metadata with ciphertext bytes retained only in Alibaba Cloud OSS. */

import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { parsePersonalPairingId, type PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  RemoteAttachmentError,
  RemoteAttachmentStoreService,
  type RemoteAttachmentBlob,
  type RemoteAttachmentGrant,
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
CREATE TABLE IF NOT EXISTS remote_attachment_objects (
  database_identity text NOT NULL,
  capability_digest bytea NOT NULL,
  pairing_id text NOT NULL,
  object_key text NOT NULL,
  byte_length bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (database_identity, capability_digest),
  UNIQUE (database_identity, object_key)
);
CREATE INDEX IF NOT EXISTS remote_attachment_objects_expiry
  ON remote_attachment_objects (database_identity, expires_at);
`

interface AttachmentRow {
  capability_digest: Uint8Array
  pairing_id: PersonalPairingId
  object_key: string
  byte_length: number
  expires_at: number
}

/** Deployment bounds and namespace for the operated OSS attachment store. */
export interface OssRemoteAttachmentStoreOptions {
  maxBlobBytes: number
  capabilityLifetimeMs: number
  maxRetainedBlobs: number
  objectPrefix: string
}

/** One-time pairing-scoped attachment store with PostgreSQL authority and OSS ciphertext. */
export class OssRemoteAttachmentStore extends RemoteAttachmentStoreService {
  readonly maxBlobBytes: number
  readonly capabilityLifetimeMs: number
  private readonly maxRetainedBlobs: number
  private readonly objectPrefix: string

  /**
   * @param ctx - operated Platform context.
   * @param databaseIdentity - deployment namespace.
   * @param pool - shared PostgreSQL metadata pool.
   * @param objects - private OSS ciphertext adapter.
   * @param options - validated ceilings and object namespace.
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
    this.maxRetainedBlobs = options.maxRetainedBlobs
    this.objectPrefix = validateOssObjectPrefix(options.objectPrefix)
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes <= 0
      || this.maxBlobBytes > REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes) {
      throw new TypeError('OSS remote attachment maxBlobBytes exceeds the protocol ceiling')
    }
    if (!Number.isSafeInteger(this.capabilityLifetimeMs) || this.capabilityLifetimeMs <= 0
      || this.capabilityLifetimeMs > REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs) {
      throw new TypeError('OSS remote attachment capabilityLifetimeMs exceeds the protocol ceiling')
    }
    if (!Number.isSafeInteger(this.maxRetainedBlobs) || this.maxRetainedBlobs <= 0) {
      throw new TypeError('OSS remote attachment maxRetainedBlobs must be a positive integer')
    }
  }

  /** Create shared metadata authority before HTTP routes mount. */
  async migrate(): Promise<void> { await this.pool.query(SCHEMA) }

  override async publish(input: {
    pairingId: PersonalPairingId
    ciphertext: Uint8Array
    now: number
  }): Promise<RemoteAttachmentGrant> {
    if (input.ciphertext.byteLength === 0) {
      throw new RemoteAttachmentError('ATTACHMENT_EMPTY', 'Remote attachment ciphertext must not be empty')
    }
    if (input.ciphertext.byteLength > this.maxBlobBytes) {
      throw new RemoteAttachmentError('ATTACHMENT_LIMIT_EXCEEDED', 'Remote attachment exceeds the per-blob byte ceiling')
    }
    const capability = parseAttachmentCapability(randomBytes(32).toString('base64url'))
    const capabilityDigest = digest(capability)
    const objectKey = `${this.objectPrefix}/${capabilityDigest.toString('hex')}`
    const expiresAt = input.now + this.capabilityLifetimeMs
    try {
      await this.objects.putObject(objectKey, input.ciphertext, expiresAt)
      const expiredKeys = await this.reserve({
        capabilityDigest, pairingId: input.pairingId, objectKey,
        byteLength: input.ciphertext.byteLength, now: input.now, expiresAt,
      })
      await this.deleteObjects(expiredKeys)
    } catch (error) {
      await this.deleteObjectAfterAuthority(objectKey)
      throw error
    }
    return { capability, byteLength: input.ciphertext.byteLength, expiresAt }
  }

  override async inspect(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<Uint8Array> {
    const row = await this.requireRow(input)
    return await this.readCiphertext(row)
  }

  override async consume(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<Uint8Array> {
    const row = await this.requireRow(input)
    const ciphertext = await this.readCiphertext(row)
    const authority = await this.transaction(async (client) => {
      const current = await this.selectRow(client, input, true)
      const deleted = await client.query(
        'DELETE FROM remote_attachment_objects WHERE database_identity = $1 AND capability_digest = $2',
        [this.databaseIdentity, digest(input.capability)],
      )
      if (deleted.rowCount !== 1) {
        throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability was already consumed')
      }
      return { objectKey: current.object_key, expired: input.now >= current.expires_at }
    })
    await this.deleteObjectAfterAuthority(authority.objectKey)
    if (authority.expired) throw expiredCapability()
    return ciphertext
  }

  override async revoke(input: { pairingId: PersonalPairingId; capability: AttachmentCapability }): Promise<void> {
    const objectKey = await this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT capability_digest, pairing_id, object_key, byte_length, expires_at
           FROM remote_attachment_objects
          WHERE database_identity = $1 AND capability_digest = $2
          FOR UPDATE`,
        [this.databaseIdentity, digest(input.capability)],
      )
      const row = this.attachmentRow(selected.rows[0])
      if (row === undefined) return undefined
      if (row.pairing_id !== input.pairingId) throw pairingMismatch()
      await client.query(
        'DELETE FROM remote_attachment_objects WHERE database_identity = $1 AND capability_digest = $2',
        [this.databaseIdentity, digest(input.capability)],
      )
      return row.object_key
    })
    if (objectKey !== undefined) await this.deleteObjectAfterAuthority(objectKey)
  }

  override async observe(): Promise<readonly RemoteAttachmentBlob[]> {
    const selected = await this.pool.query(
      `SELECT capability_digest, pairing_id, object_key, byte_length, expires_at
         FROM remote_attachment_objects
        WHERE database_identity = $1
        ORDER BY expires_at, pairing_id`,
      [this.databaseIdentity],
    )
    return await Promise.all(selected.rows.map(async (value) => {
      const row = this.attachmentRow(value)
      if (row === undefined) throw new TypeError('OSS remote attachment row is invalid')
      return {
        capabilityDigest: new Uint8Array(row.capability_digest),
        pairingId: row.pairing_id,
        ciphertext: await this.readCiphertext(row),
        expiresAt: row.expires_at,
      }
    }))
  }

  private async reserve(input: {
    capabilityDigest: Buffer
    pairingId: PersonalPairingId
    objectKey: string
    byteLength: number
    now: number
    expiresAt: number
  }): Promise<string[]> {
    return await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`remote-attachments:${this.databaseIdentity}`])
      const expired = await client.query(
        `DELETE FROM remote_attachment_objects
          WHERE database_identity = $1 AND expires_at <= $2
          RETURNING object_key`,
        [this.databaseIdentity, input.now],
      )
      const counted = await client.query(
        'SELECT COUNT(*)::text AS count FROM remote_attachment_objects WHERE database_identity = $1',
        [this.databaseIdentity],
      )
      if (Number(counted.rows[0]?.count ?? 0) >= this.maxRetainedBlobs) {
        throw new RemoteAttachmentError('ATTACHMENT_CAPACITY', 'Remote attachment store is at capacity')
      }
      await client.query(
        `INSERT INTO remote_attachment_objects (
           database_identity, capability_digest, pairing_id, object_key, byte_length, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [this.databaseIdentity, input.capabilityDigest, input.pairingId, input.objectKey, input.byteLength, input.expiresAt],
      )
      return expired.rows.flatMap(row => typeof row.object_key === 'string' ? [row.object_key] : [])
    })
  }

  private async requireRow(
    input: { pairingId: PersonalPairingId; capability: AttachmentCapability; now: number },
  ): Promise<AttachmentRow> {
    const row = await this.selectRow(this.pool, input, false)
    if (input.now < row.expires_at) return row
    const deleted = await this.pool.query(
      `DELETE FROM remote_attachment_objects
        WHERE database_identity = $1 AND capability_digest = $2 AND expires_at <= $3
        RETURNING object_key`,
      [this.databaseIdentity, digest(input.capability), input.now],
    )
    const objectKey = deleted.rows[0]?.object_key
    if (typeof objectKey === 'string') await this.deleteObjectAfterAuthority(objectKey)
    throw expiredCapability()
  }

  private async selectRow(
    client: PlatformSqlClient,
    input: { pairingId: PersonalPairingId; capability: AttachmentCapability },
    lock: boolean,
  ): Promise<AttachmentRow> {
    const selected = await client.query(
      `SELECT capability_digest, pairing_id, object_key, byte_length, expires_at
         FROM remote_attachment_objects
        WHERE database_identity = $1 AND capability_digest = $2${lock ? ' FOR UPDATE' : ''}`,
      [this.databaseIdentity, digest(input.capability)],
    )
    const row = this.attachmentRow(selected.rows[0])
    if (row === undefined) {
      throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability is unknown, consumed, or revoked')
    }
    if (row.pairing_id !== input.pairingId) throw pairingMismatch()
    return row
  }

  private async readCiphertext(row: AttachmentRow): Promise<Uint8Array> {
    const ciphertext = await this.objects.getObject(row.object_key)
    if (ciphertext.byteLength !== row.byte_length) {
      throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment ciphertext length is invalid')
    }
    return ciphertext
  }

  private async deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.deleteObjectAfterAuthority(key)
  }

  private async deleteObjectAfterAuthority(key: string): Promise<void> {
    try { await this.objects.deleteObject(key) } catch {
      // Bucket lifecycle expiry owns recovery after metadata authority is gone.
      console.error('[platform] OSS attachment cleanup failed')
    }
  }

  private attachmentRow(value: Record<string, unknown> | undefined): AttachmentRow | undefined {
    if (value === undefined || !(value.capability_digest instanceof Uint8Array)
      || typeof value.pairing_id !== 'string' || typeof value.object_key !== 'string'
      || (typeof value.byte_length !== 'string' && typeof value.byte_length !== 'number')
      || (typeof value.expires_at !== 'string' && typeof value.expires_at !== 'number')) return undefined
    const byteLength = Number(value.byte_length)
    const expiresAt = Number(value.expires_at)
    const expectedKey = `${this.objectPrefix}/${Buffer.from(value.capability_digest).toString('hex')}`
    if (value.capability_digest.byteLength !== 32 || value.object_key !== expectedKey
      || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > this.maxBlobBytes
      || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return undefined
    try {
      return {
        capability_digest: value.capability_digest,
        pairing_id: parsePersonalPairingId(value.pairing_id),
        object_key: value.object_key,
        byte_length: byteLength,
        expires_at: expiresAt,
      }
    } catch {
      /* A malformed durable pairing id makes the whole metadata row unusable. */
      return undefined
    }
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
}

function digest(capability: AttachmentCapability): Buffer {
  return createHash('sha256').update(capability).digest()
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
