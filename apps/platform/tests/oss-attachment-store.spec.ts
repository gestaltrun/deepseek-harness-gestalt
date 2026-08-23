import { Context } from '@deepseek-ai/cordis'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OssRemoteAttachmentStore } from '../src/oss-attachment-store.ts'
import type { PlatformSqlPool } from '../src/postgres-pairing-store.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
})

describe('OSS remote attachment durable metadata', () => {
  it.each(['referenced', 'unreadable'] as const)(
    'retains an uploaded OSS object when COMMIT fails and metadata is %s',
    async (metadataOutcome) => {
      const context = new Context()
      contexts.push(context)
      let objectKey: string | undefined
      const client = {
        query: async (sql: string, values?: readonly unknown[]) => {
          if (sql === 'COMMIT') throw new Error('COMMIT outcome is unknown')
          if (sql.includes('INSERT INTO remote_attachment_objects')) objectKey = String(values?.[3])
          if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '0' }], rowCount: 1 }
          return { rows: [], rowCount: sql.includes('INSERT INTO') ? 1 : 0 }
        },
        release: () => {},
      }
      const pool = {
        query: async (sql: string) => {
          if (!sql.includes('SELECT object_key FROM remote_attachment_objects')) {
            throw new Error(`unexpected pool query: ${sql}`)
          }
          if (metadataOutcome === 'unreadable') throw new Error('metadata read is unavailable')
          return { rows: [{ object_key: objectKey }], rowCount: 1 }
        },
        connect: async () => client,
      } as unknown as PlatformSqlPool
      const deleteObject = vi.fn(async () => {})
      const release = vi.fn(async () => {})
      const store = new OssRemoteAttachmentStore(context, 'commit-fixture', pool, {
        putObject: async () => {},
        getObject: async () => Uint8Array.of(1),
        deleteObject,
      }, {
        maxBlobBytes: 4,
        capabilityLifetimeMs: 100,
        maxRetainedBlobs: 1,
        objectPrefix: 'remote-attachments/commit-fixture',
        sweepIntervalMs: 60_000,
        cleanupConcurrency: 1,
        capacityRetryAfterSeconds: 1,
        releaseQuotaReservation: async () => {},
        activePairingIds: async () => [],
      })

      await expect(store.publish({
        pairingId: parsePersonalPairingId('pairing-commit'),
        ciphertext: Uint8Array.of(1),
        now: 1,
        quota: { id: 'quota-commit', release },
      })).rejects.toThrow('COMMIT outcome is unknown')
      expect(objectKey).toMatch(/^remote-attachments\/commit-fixture\/[0-9a-f]{64}$/)
      expect(deleteObject).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['capability digest length', { capability_digest: new Uint8Array(31) }],
    ['object key binding', { object_key: 'remote-attachments/test/wrong' }],
    ['empty pairing id', { pairing_id: '' }],
    ['empty ciphertext length', { byte_length: 0 }],
    ['oversize ciphertext length', { byte_length: 5 }],
    ['fractional ciphertext length', { byte_length: 1.5 }],
    ['non-positive expiry', { expires_at: 0 }],
    ['unsafe expiry', { expires_at: '9007199254740992' }],
  ])('rejects an invalid %s before reading OSS', async (_label, patch) => {
    const context = new Context()
    contexts.push(context)
    const digest = new Uint8Array(32)
    const row = {
      capability_digest: digest,
      pairing_id: 'pairing-valid',
      object_key: `remote-attachments/test/${Buffer.from(digest).toString('hex')}`,
      byte_length: 1,
      expires_at: 100,
      legacy_authority: false,
      quota_reservation_id: null,
      claim_token: null,
      ...patch,
    }
    const pool = {
      query: async () => ({ rows: [row], rowCount: 1 }),
      connect: async () => { throw new Error('transaction was not expected') },
    } satisfies PlatformSqlPool
    const getObject = vi.fn(async () => Uint8Array.of(1))
    const store = new OssRemoteAttachmentStore(context, 'metadata-fixture', pool, {
      putObject: async () => {}, getObject, deleteObject: async () => {},
    }, {
      maxBlobBytes: 4,
      capabilityLifetimeMs: 100,
      maxRetainedBlobs: 1,
      objectPrefix: 'remote-attachments/test',
      sweepIntervalMs: 60_000,
      cleanupConcurrency: 1,
      capacityRetryAfterSeconds: 1,
      releaseQuotaReservation: async () => {},
      activePairingIds: async () => [],
    })

    await expect(store.observe()).rejects.toThrow('OSS remote attachment row is invalid')
    expect(getObject).not.toHaveBeenCalled()
  })
})
