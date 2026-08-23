import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OssRemoteAttachmentStore } from '../src/oss-attachment-store.ts'
import type { PlatformSqlPool } from '../src/postgres-pairing-store.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
})

describe('OSS remote attachment durable metadata', () => {
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
    })

    await expect(store.observe()).rejects.toThrow('OSS remote attachment row is invalid')
    expect(getObject).not.toHaveBeenCalled()
  })
})
