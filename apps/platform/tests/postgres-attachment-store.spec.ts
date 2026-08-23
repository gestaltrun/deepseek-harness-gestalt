import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { PostgresRemoteAttachmentStore } from '../src/postgres-attachment-store.ts'
import type { PlatformSqlPool } from '../src/postgres-pairing-store.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
})

describe('PostgreSQL remote attachment durable rows', () => {
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
    })

    await expect(store.observe()).rejects.toThrow('PostgreSQL remote attachment row is invalid')
  })
})
