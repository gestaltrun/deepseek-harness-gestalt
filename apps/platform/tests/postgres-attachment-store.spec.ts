import { Context } from '@deepseek-ai/cordis'
import { parseAttachmentBlobReservationId, parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parseAttachmentCapability } from '@deepseek-ai/dsh-remote-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostgresRemoteAttachmentStore } from '../src/postgres-attachment-store.ts'
import type { PlatformSqlPool } from '../src/postgres-pairing-store.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
})

describe('PostgreSQL remote attachment durable rows', () => {
  it('commits expired ciphertext removal before releasing its quota reservation', async () => {
    const context = new Context()
    contexts.push(context)
    const statements: string[] = []
    const release = vi.fn(async () => {})
    let quotaReleasePending = false
    const row = {
      capability_digest: new Uint8Array(32),
      pairing_id: 'pairing-expired',
      ciphertext: Uint8Array.of(1),
      expires_at: 100,
      quota_reservation_id: 'quota-expired',
      claim_token: null,
    }
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        if (sql.includes('SELECT phase FROM remote_attachment_storage_phase')) {
          return { rows: [{ phase: 'legacy' }], rowCount: 1 }
        }
        if (sql.includes('SELECT capability_digest')) return { rows: [row], rowCount: 1 }
        if (sql.includes('DELETE FROM remote_attachment_blobs')) {
          return { rows: [{ quota_reservation_id: 'quota-expired' }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO remote_attachment_quota_releases')) quotaReleasePending = true
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    }
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('SELECT reservation_id AS quota_reservation_id')) {
          return {
            rows: quotaReleasePending ? [{ quota_reservation_id: 'quota-expired' }] : [],
            rowCount: quotaReleasePending ? 1 : 0,
          }
        }
        if (sql.includes('DELETE FROM remote_attachment_quota_releases')) quotaReleasePending = false
        return { rows: [], rowCount: 0 }
      },
      connect: async () => client,
    } as unknown as PlatformSqlPool
    const store = new PostgresRemoteAttachmentStore(context, 'expired-fixture', pool, {
      maxBlobBytes: 4,
      capabilityLifetimeMs: 100,
      maxRetainedBlobs: 1,
      quotaCleanup: { release },
    })

    await expect(store.consume({
      pairingId: parsePersonalPairingId('pairing-expired'),
      capability: parseAttachmentCapability('A'.repeat(43)),
      now: 100,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED' })
    expect(statements).toContain('COMMIT')
    expect(statements).not.toContain('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each(['committed', 'absent', 'readback-fail'] as const)(
    'resolves a publish COMMIT with an unknown outcome when the row is %s',
    async (outcome) => {
      const context = new Context()
      contexts.push(context)
      const pairingId = parsePersonalPairingId(`pairing-publish-${outcome}`)
      const reservationId = parseAttachmentBlobReservationId(`quota-publish-${outcome}`)
      const release = vi.fn(async () => {})
      let pendingRow: Record<string, unknown> | undefined
      let durableRow: Record<string, unknown> | undefined
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          if (sql.includes('DELETE FROM remote_attachment_blobs')) return { rows: [], rowCount: 0 }
          if (sql.includes('SELECT COUNT(*)::text')) return { rows: [{ count: '0' }], rowCount: 1 }
          if (sql.includes('INSERT INTO remote_attachment_blobs')) {
            pendingRow = {
              capability_digest: values?.[1],
              pairing_id: values?.[2],
              ciphertext: values?.[3],
              expires_at: values?.[4],
              quota_reservation_id: values?.[5],
              claim_token: null,
            }
            return { rows: [], rowCount: 1 }
          }
          if (sql === 'COMMIT') {
            if (outcome === 'committed') durableRow = pendingRow
            pendingRow = undefined
            throw new Error('publish COMMIT outcome is unknown')
          }
          return { rows: [], rowCount: 0 }
        },
        release: () => {},
      }
      const pool = {
        query: async (sql: string) => {
          if (sql.includes('SELECT capability_digest')) {
            if (outcome === 'readback-fail') throw new Error('publish readback unavailable')
            return { rows: durableRow === undefined ? [] : [durableRow], rowCount: durableRow === undefined ? 0 : 1 }
          }
          return { rows: [], rowCount: 0 }
        },
        connect: async () => client,
      } as unknown as PlatformSqlPool
      const store = new PostgresRemoteAttachmentStore(context, `publish-${outcome}`, pool, {
        maxBlobBytes: 4,
        capabilityLifetimeMs: 100,
        maxRetainedBlobs: 1,
        quotaCleanup: { release: async () => {} },
      })
      const publishing = store.publish({
        pairingId,
        ciphertext: Uint8Array.of(1, 2),
        now: 100,
        quota: { id: reservationId, release },
      })

      if (outcome === 'committed') {
        await expect(publishing).resolves.toMatchObject({ byteLength: 2, expiresAt: 200 })
        expect(release).not.toHaveBeenCalled()
      } else if (outcome === 'absent') {
        await expect(publishing).rejects.toThrow('publish COMMIT outcome is unknown')
        expect(release).toHaveBeenCalledTimes(1)
      } else {
        await expect(publishing).rejects.toThrow('PostgreSQL attachment publish outcome is uncertain')
        expect(release).not.toHaveBeenCalled()
      }
    },
  )

  it.each([
    ['capability digest length', { capability_digest: new Uint8Array(31) }],
    ['empty ciphertext', { ciphertext: new Uint8Array() }],
    ['oversize ciphertext', { ciphertext: new Uint8Array(5) }],
    ['empty pairing id', { pairing_id: '' }],
    ['non-positive expiry', { expires_at: 0 }],
    ['fractional expiry', { expires_at: 1.5 }],
    ['unsafe expiry', { expires_at: '9007199254740992' }],
  ])('rejects an invalid %s', async (_label, patch) => {
    const context = new Context()
    contexts.push(context)
    const row = {
      capability_digest: new Uint8Array(32),
      pairing_id: 'pairing-valid',
      ciphertext: Uint8Array.of(1),
      expires_at: '100',
      ...patch,
    }
    const pool = {
      query: async () => ({ rows: [row], rowCount: 1 }),
      connect: async () => { throw new Error('transaction was not expected') },
    } satisfies PlatformSqlPool
    const store = new PostgresRemoteAttachmentStore(context, 'durable-row-fixture', pool, {
      maxBlobBytes: 4,
      capabilityLifetimeMs: 100,
      maxRetainedBlobs: 1,
      quotaCleanup: { release: async () => {} },
    })

    await expect(store.observe()).rejects.toThrow('PostgreSQL remote attachment row is invalid')
  })
})
