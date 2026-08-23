import { describe, expect, it } from 'vitest'
import { completeAttachmentStorageCutover } from '../src/attachment-storage-phase.ts'
import type { PlatformSqlPool } from '../src/postgres-pairing-store.ts'

describe('attachment storage destructive cutover', () => {
  it('retries idempotently after an OSS phase COMMIT with an unknown outcome', async () => {
    let phase = 'bridge'
    let commits = 0
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes('SELECT phase FROM remote_attachment_storage_phase')) {
          return { rows: [{ phase }], rowCount: 1 }
        }
        if (sql.includes('FROM remote_attachment_objects AS object')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('UPDATE remote_attachment_storage_phase SET phase = $2')) {
          phase = String(values?.[1])
        }
        if (sql === 'COMMIT' && ++commits === 1) {
          throw new Error('COMMIT outcome is unknown')
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    }
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
    } as unknown as PlatformSqlPool

    await expect(completeAttachmentStorageCutover(
      pool,
      'cutover-retry-fixture',
      'oss',
      'remote-attachments/cutover',
    )).rejects.toThrow('COMMIT outcome is unknown')
    expect(phase).toBe('oss')
    await expect(completeAttachmentStorageCutover(
      pool,
      'cutover-retry-fixture',
      'oss',
      'remote-attachments/cutover',
    )).resolves.toBeUndefined()
  })

  it('deletes a fully matching unclaimed bridge duplicate', async () => {
    const statements: string[] = []
    const digest = Buffer.alloc(32, 1)
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('SELECT phase FROM remote_attachment_storage_phase')) {
          return { rows: [{ phase: 'bridge' }], rowCount: 1 }
        }
        if (sql.includes('FROM remote_attachment_objects AS object')) {
          return { rows: [{
            object_capability_digest: digest,
            legacy_capability_digest: digest,
            object_pairing_id: 'pairing-cutover',
            legacy_pairing_id: 'pairing-cutover',
            object_key: `remote-attachments/cutover/${digest.toString('hex')}`,
            object_byte_length: 1,
            legacy_ciphertext: Buffer.from([1]),
            object_expires_at: 100,
            legacy_expires_at: 100,
            object_quota_reservation_id: 'quota-cutover',
            legacy_quota_reservation_id: 'quota-cutover',
            object_claim_token: null,
            legacy_claim_token: null,
          }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    }
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
    } as unknown as PlatformSqlPool

    await expect(completeAttachmentStorageCutover(
      pool,
      'cutover-fixture',
      'oss',
      'remote-attachments/cutover',
    )).resolves.toBeUndefined()
    expect(statements.some(statement => statement.includes('DELETE FROM remote_attachment_blobs AS legacy'))).toBe(true)
  })

  it.each([
    ['digest', { legacy_capability_digest: Buffer.alloc(32, 2) }],
    ['object key', { object_key: 'remote-attachments/cutover/not-the-digest' }],
    ['pairing', { legacy_pairing_id: 'pairing-other' }],
    ['ciphertext length', { legacy_ciphertext: Buffer.from([1, 2]) }],
    ['expiry', { legacy_expires_at: 101 }],
    ['quota reservation', { legacy_quota_reservation_id: 'quota-other' }],
    ['claim state', { object_claim_token: Buffer.alloc(32, 3) }],
  ])('refuses inconsistent %s metadata before deleting legacy ciphertext', async (_label, patch) => {
    const statements: string[] = []
    const digest = Buffer.alloc(32, 1)
    const row = {
      object_capability_digest: digest,
      legacy_capability_digest: digest,
      object_pairing_id: 'pairing-cutover',
      legacy_pairing_id: 'pairing-cutover',
      object_key: `remote-attachments/cutover/${digest.toString('hex')}`,
      object_byte_length: 1,
      legacy_ciphertext: Buffer.from([1]),
      object_expires_at: 100,
      legacy_expires_at: 100,
      object_quota_reservation_id: 'quota-cutover',
      legacy_quota_reservation_id: 'quota-cutover',
      object_claim_token: null,
      legacy_claim_token: null,
      ...patch,
    }
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('SELECT phase FROM remote_attachment_storage_phase')) {
          return { rows: [{ phase: 'bridge' }], rowCount: 1 }
        }
        if (sql.includes('FROM remote_attachment_objects AS object')) {
          return { rows: [row], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    }
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
    } as unknown as PlatformSqlPool

    await expect(completeAttachmentStorageCutover(
      pool,
      'cutover-fixture',
      'oss',
      'remote-attachments/cutover',
    )).rejects.toThrow('OSS remote attachment cutover row is invalid')
    expect(statements.some(statement => statement.includes('DELETE FROM remote_attachment_blobs AS legacy'))).toBe(false)
  })
})
