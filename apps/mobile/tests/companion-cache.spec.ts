import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { accountStorageNamespace } from '@deepseek-ai/dsh-platform-account-client'
import { parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionConfirmedResult,
  type CompanionSessionCreatedResult,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  companionCacheAdmits,
  companionCacheDatabaseName,
  companionMutationAllowed,
  CompanionCache,
  CompanionUncertainOperationSettlement,
  IndexedDbCompanionCacheStore,
  InMemoryCompanionCacheStore,
  parseCompanionDesktopId,
  WebCryptoCompanionCacheCipher,
  type CompanionCacheKeySource,
  type CompanionMutationOutcome,
  type CompanionMutationRequest,
  type CompanionMutationTransport,
  type CompanionStatusAnswer,
  type CompanionTransmissionFence,
} from '../src/companion-cache.ts'

const desktopA = parseCompanionDesktopId('desktop-a')
const desktopB = parseCompanionDesktopId('desktop-b')
const ready = { foreground: true, socketOpen: true, synchronized: true }
const reconnecting = { foreground: true, socketOpen: true, synchronized: false }

function namespacedStore(accountId: string): IndexedDbCompanionCacheStore {
  return new IndexedDbCompanionCacheStore(
    companionCacheDatabaseName('development', parsePlatformAccountId(accountId)),
  )
}

async function cipherFor(keys: Record<string, CryptoKey>): Promise<WebCryptoCompanionCacheCipher> {
  const derived = { ...keys }
  return new WebCryptoCompanionCacheCipher({
    keyFor: async desktopId => derived[desktopId] ??= await freshKey(),
  } satisfies CompanionCacheKeySource)
}

async function freshKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

function confirmed(operationId: string): CompanionConfirmedResult {
  return { type: 'confirmed', operationId: parseCompanionOperationId(operationId), committedAt: 1_787_027_200_000, outcome: 'accepted' }
}

function sessionCreated(operationId: string, sessionId: string): CompanionSessionCreatedResult {
  return {
    type: 'session-created', operationId: parseCompanionOperationId(operationId),
    sessionId: parseCompanionSessionId(sessionId), committedAt: 1_787_027_200_000,
  }
}

async function openIndexedDb(databaseName: string): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB open failed')) }
  })
}

async function readRawRow(databaseName: string, store: 'content' | 'receipts', key: string): Promise<unknown> {
  const database = await openIndexedDb(databaseName)
  return await new Promise((resolve, reject) => {
    const request = database.transaction(store, 'readonly').objectStore(store).get(key)
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB read failed')) }
  })
}

async function writeRawRow(
  databaseName: string,
  store: 'content' | 'receipts',
  key: string,
  value: unknown,
): Promise<void> {
  const database = await openIndexedDb(databaseName)
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value, key)
    transaction.oncomplete = () => { resolve() }
    transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB write failed')) }
  })
}

describe('Companion Cache', () => {
  it('encrypts opened metadata and transcripts at rest per Paired Desktop', async () => {
    const keys = { 'desktop-a': await freshKey(), 'desktop-b': await freshKey() }
    const cipher = await cipherFor(keys)
    const plaintext = JSON.stringify({ title: 'Session', transcript: ['hello'] })
    const sealed = await cipher.seal(desktopA, 'transcript', new TextEncoder().encode(plaintext))

    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain('Session')
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain('hello')
    expect(new TextDecoder().decode(await cipher.open(desktopA, 'transcript', sealed))).toBe(plaintext)

    const withA = await cipherFor({ 'desktop-a': keys['desktop-a'] })
    expect(await withA.open(desktopA, 'transcript', sealed)).toEqual(new TextEncoder().encode(plaintext))
  })

  it('round-trips non-ASCII metadata through the cache', async () => {
    const cache = new CompanionCache(new InMemoryCompanionCacheStore(), await cipherFor({}))
    const plaintext = JSON.stringify({ title: '会话' })
    await cache.saveOpenedContent(desktopA, 'session-metadata', plaintext)
    expect(JSON.parse(await cache.loadOpenedContent(desktopA, 'session-metadata') ?? '')).toEqual({ title: '会话' })
  })

  it('refuses to decrypt one Desktop row under another Desktop key', async () => {
    const keys = { 'desktop-a': await freshKey(), 'desktop-b': await freshKey() }
    const sealedByA = await (await cipherFor({ 'desktop-a': keys['desktop-a'] })).seal(
      desktopA,
      'transcript',
      new TextEncoder().encode('desktop-a transcript'),
    )
    const cipherUsingBForAnyDesktop = new WebCryptoCompanionCacheCipher({
      keyFor: async () => keys['desktop-b'],
    })
    await expect(cipherUsingBForAnyDesktop.open(desktopA, 'transcript', sealedByA)).rejects.toThrow()
    const cipherOfA = await cipherFor({ 'desktop-a': keys['desktop-a'] })
    await expect(cipherOfA.open(desktopA, 'session-metadata', sealedByA)).rejects.toThrow()
  })

  it('never automatically caches attachment bytes, terminal content, spill files, or credentials', () => {
    expect(companionCacheAdmits('attachment-bytes')).toBe(false)
    expect(companionCacheAdmits('terminal-content')).toBe(false)
    expect(companionCacheAdmits('spill-file')).toBe(false)
    expect(companionCacheAdmits('credential')).toBe(false)
    expect(companionCacheAdmits('some-unknown-kind')).toBe(false)
    expect(companionCacheAdmits('transcript')).toBe(true)
  })

  it('fails loud when an excluded kind reaches the cache', async () => {
    const cache = new CompanionCache(new InMemoryCompanionCacheStore(), await cipherFor({}))
    await expect(cache.saveOpenedContent(desktopA, 'credential', 'secret-token')).rejects.toThrow(
      /never automatically stores/,
    )
  })

  it('caps opened content at the protocol byte ceilings, including multibyte text', async () => {
    const cache = new CompanionCache(new InMemoryCompanionCacheStore(), await cipherFor({}))
    const transcriptLimit = REMOTE_PROTOCOL_LIMITS.transcriptPageBytes
    const metadataLimit = REMOTE_PROTOCOL_LIMITS.companionMessageBytes
    await expect(cache.saveOpenedContent(desktopA, 'transcript', 'a'.repeat(transcriptLimit))).resolves.toBeUndefined()
    await expect(cache.saveOpenedContent(desktopA, 'transcript', 'a'.repeat(transcriptLimit + 1))).rejects.toThrow(
      new RegExp(`exceeds the ${String(transcriptLimit)}-byte ceiling`),
    )
    await expect(cache.saveOpenedContent(desktopA, 'session-metadata', 'a'.repeat(metadataLimit))).resolves.toBeUndefined()
    await expect(cache.saveOpenedContent(desktopA, 'session-metadata', 'a'.repeat(metadataLimit + 1))).rejects.toThrow(
      new RegExp(`exceeds the ${String(metadataLimit)}-byte ceiling`),
    )
    const exactMultibyte = '你'.repeat(transcriptLimit / 3)
    expect(new TextEncoder().encode(exactMultibyte).byteLength).toBe(transcriptLimit)
    await expect(cache.saveOpenedContent(desktopA, 'transcript', exactMultibyte)).resolves.toBeUndefined()
    await expect(cache.saveOpenedContent(desktopA, 'transcript', `${exactMultibyte}你`)).rejects.toThrow(
      new RegExp(`exceeds the ${String(transcriptLimit)}-byte ceiling`),
    )
  })

  it('caps the number of receipts retained for one Paired Desktop', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const limit = REMOTE_PROTOCOL_LIMITS.containerValues
    for (let index = 0; index < limit; index += 1) {
      await settlement.transmit(
        { kind: 'prompt', operationId: parseCompanionOperationId(`op-cap-${String(index)}`) },
        outcomeTransport({ known: false }),
        ready,
      )
    }
    expect((await store.loadReceipts(desktopA)).length).toBe(limit)
    let overflowSends = 0
    await expect(settlement.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-cap-overflow') },
      recordingTransport(() => { overflowSends += 1 }, { known: false }),
      ready,
    )).rejects.toThrow(new RegExp(`exceeds the ${String(limit)}-row ceiling`))
    expect(overflowSends).toBe(0)
    await expect(store.saveReceipt(desktopA, {
      operationId: parseCompanionOperationId('op-cap-0'),
      status: 'not-submitted',
    })).resolves.toBeUndefined()
  })

  it('evicts a terminal receipt before sending a future mutation at capacity', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const limit = REMOTE_PROTOCOL_LIMITS.containerValues
    for (let index = 0; index < limit; index += 1) {
      await store.saveReceipt(desktopA, {
        operationId: parseCompanionOperationId(`terminal-${String(index)}`),
        status: 'not-submitted',
      })
    }
    const transport = recordingTransport(undefined, { known: true, result: confirmed('future-operation') })
    await expect(settlement.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('future-operation') }, transport, ready,
    )).resolves.toMatchObject({ status: 'committed' })
    expect(transport.sends).toBe(1)
    expect(await store.loadReceipts(desktopA)).toHaveLength(limit)
  })

  it('never evicts prepared or unknown fences across 257 concurrent reservations', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const releases: Array<() => Promise<void>> = []
    let transportEntries = 0
    const transmissions = Array.from({ length: REMOTE_PROTOCOL_LIMITS.containerValues + 1 }, (_, index) => (
      settlement.transmit({
        kind: 'prompt', operationId: parseCompanionOperationId(`concurrent-${String(index)}`),
      }, {
        send: async (_mutation, fence) => await new Promise((resolve) => {
          transportEntries += 1
          releases.push(async () => { await fence(); resolve({ known: false }) })
        }),
        queryStatus: async () => ({ committed: false }),
      }, ready)
    ))
    const settledTransmissions = Promise.allSettled(transmissions)
    await vi.waitFor(() => { expect(transportEntries).toBe(REMOTE_PROTOCOL_LIMITS.containerValues) })
    expect(new Set((await store.loadReceipts(desktopA)).map(row => row.status))).toEqual(new Set(['prepared']))
    for (const release of releases) await release()
    const settled = await settledTransmissions

    expect(transportEntries).toBe(REMOTE_PROTOCOL_LIMITS.containerValues)
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await store.loadReceipts(desktopA)).toHaveLength(REMOTE_PROTOCOL_LIMITS.containerValues)
  })

  it('persists sealed rows through the IndexedDB store with metadata and transcript coexisting', async () => {
    const keys = { 'desktop-a': await freshKey() }
    const databaseName = companionCacheDatabaseName('development', parsePlatformAccountId('cache-content'))
    const cache = new CompanionCache(new IndexedDbCompanionCacheStore(databaseName), await cipherFor(keys))
    const metadata = JSON.stringify({ title: 'Cached' })
    await cache.saveOpenedContent(desktopA, 'session-metadata', metadata)
    await cache.saveOpenedContent(desktopA, 'transcript', 'user: continue')
    const raw = await readRawRow(databaseName, 'content', `${desktopA}::session-metadata`)
    expect(raw).toEqual(expect.objectContaining({ desktopId: desktopA }))
    expect(new TextDecoder().decode((raw as { ciphertext: Uint8Array }).ciphertext)).not.toContain('Cached')
    expect(JSON.stringify(raw)).not.toContain('Cached')
    expect(await cache.loadOpenedContent(desktopA, 'session-metadata')).toContain('Cached')
    expect(await cache.loadOpenedContent(desktopA, 'transcript')).toBe('user: continue')
    expect(await cache.loadOpenedContent(desktopB, 'session-metadata')).toBeUndefined()
  })

  it('rejects durable Companion Cache rows that fail IndexedDB validation', async () => {
    const keys = { 'desktop-a': await freshKey() }
    const cipher = await cipherFor(keys)
    const store = namespacedStore('cache-malformed')
    const cache = new CompanionCache(store, cipher)
    await cache.saveOpenedContent(desktopA, 'transcript', 'valid')
    const valid = await readRawRow(
      companionCacheDatabaseName('development', parsePlatformAccountId('cache-malformed')),
      'content',
      `${desktopA}::transcript`,
    ) as { desktopId: string; iv: Uint8Array; ciphertext: Uint8Array }

    await writeRawRow(
      companionCacheDatabaseName('development', parsePlatformAccountId('cache-malformed')),
      'content',
      `${desktopA}::workspace-metadata`,
      { desktopId: 'not a desktop', iv: valid.iv, ciphertext: valid.ciphertext },
    )
    await expect(cache.loadOpenedContent(desktopA, 'workspace-metadata')).rejects.toThrow(/desktop id/)

    await writeRawRow(
      companionCacheDatabaseName('development', parsePlatformAccountId('cache-malformed')),
      'content',
      `${desktopA}::session-metadata`,
      { desktopId: desktopA, iv: new Uint8Array(11), ciphertext: valid.ciphertext },
    )
    await expect(cache.loadOpenedContent(desktopA, 'session-metadata')).rejects.toThrow(/12-byte Uint8Array/)

    await writeRawRow(
      companionCacheDatabaseName('development', parsePlatformAccountId('cache-malformed')),
      'content',
      `${desktopB}::transcript`,
      { desktopId: desktopA, iv: valid.iv, ciphertext: valid.ciphertext },
    )
    await expect(cache.loadOpenedContent(desktopB, 'transcript')).rejects.toThrow(/does not match the requested desktop/)

    await writeRawRow(
      companionCacheDatabaseName('development', parsePlatformAccountId('cache-malformed')),
      'receipts',
      `${desktopA}::op-bad`,
      { operationId: 'op-bad', status: 'forged' },
    )
    await expect(store.loadReceipts(desktopA)).rejects.toThrow(/receipt status/)
  })

  it('round-trips a Desktop-confirmed created Session through durable operation receipts', async () => {
    const store = namespacedStore('session-created-result')
    const operationId = parseCompanionOperationId('create-session-durable')
    const original = sessionCreated('create-session-durable', 'session-created-durable')
    await store.saveReceipt(desktopA, {
      operationId, status: 'committed', kind: 'session-create', original,
    })
    await expect(store.loadReceipts(desktopA)).resolves.toEqual([{
      operationId, status: 'committed', kind: 'session-create', original,
    }])
  })

  it('names the cache database from the account storage namespace', () => {
    const accountA = parsePlatformAccountId('account-a')
    const accountB = parsePlatformAccountId('account-b')
    expect(companionCacheDatabaseName('production', accountA))
      .toBe(`${accountStorageNamespace('production', accountA)}:companion-cache`)
    expect(companionCacheDatabaseName('production', accountA))
      .not.toBe(companionCacheDatabaseName('production', accountB))
    expect(companionCacheDatabaseName('production', accountA))
      .not.toBe(companionCacheDatabaseName('development', accountA))
    expect(companionCacheDatabaseName('production', accountA))
      .not.toBe(`${accountStorageNamespace('production', accountA)}:pairing-keys`)
  })

  it('isolates cache rows across account storage namespaces', async () => {
    const keys = { 'desktop-a': await freshKey() }
    const cipher = await cipherFor(keys)
    const cacheA = new CompanionCache(namespacedStore('isolation-a'), cipher)
    const cacheB = new CompanionCache(namespacedStore('isolation-b'), cipher)
    await cacheA.saveOpenedContent(desktopA, 'transcript', 'account-a only')
    await cacheB.saveOpenedContent(desktopA, 'transcript', 'account-b only')
    expect(await cacheA.loadOpenedContent(desktopA, 'transcript')).toBe('account-a only')
    expect(await cacheB.loadOpenedContent(desktopA, 'transcript')).toBe('account-b only')
    await cacheA.clearDesktopContent(desktopA)
    expect(await cacheA.loadOpenedContent(desktopA, 'transcript')).toBeUndefined()
    expect(await cacheB.loadOpenedContent(desktopA, 'transcript')).toBe('account-b only')
  })

  it('allows cache reads while reconnecting but disables every mutation until foreground synchronization', async () => {
    for (const kind of ['session-create', 'prompt', 'cancel', 'approval', 'question', 'attachment', 'other-mutation'] as const) {
      expect(companionMutationAllowed(reconnecting, kind)).toBe(false)
    }
    expect(companionMutationAllowed(ready, 'prompt')).toBe(true)

    const store = new InMemoryCompanionCacheStore()
    const cipher = await cipherFor({})
    await store.saveContent(desktopA, 'transcript', await cipher.seal(desktopA, 'transcript', new TextEncoder().encode('cached')))
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    let sends = 0
    const transport = recordingTransport(() => { sends += 1 }, { known: true, result: confirmed('op-offline') })
    await expect(settlement.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-offline') },
      transport,
      reconnecting,
    )).rejects.toThrow(/foreground synchronization/)
    expect(sends).toBe(0)
    expect(await store.loadReceipts(desktopA)).toEqual([])
    const cache = new CompanionCache(store, cipher)
    await expect(cache.loadOpenedContent(desktopA, 'transcript')).resolves.not.toBeUndefined()
  })

  it('commits the durable unknown fence before transmission', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    let sent = false
    let receiptsAtSend: readonly unknown[] | undefined
    const transport: CompanionMutationTransport = {
      async send(_mutation, beforeSend) {
        await beforeSend()
        receiptsAtSend = await store.loadReceipts(desktopA)
        sent = true
        return { known: false }
      },
      async queryStatus() { return { committed: false } },
    }
    const receipt = await settlement.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-uncertain') },
      transport,
      ready,
    )
    expect(sent).toBe(true)
    expect(receipt.status).toBe('unknown')
    expect(receiptsAtSend).toEqual([
      { operationId: parseCompanionOperationId('op-uncertain'), status: 'unknown', kind: 'prompt' },
    ])
  })

  it('stores no receipt when the send never left the device', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const neverTransmits: CompanionMutationTransport = {
      async send() { return { known: false } },
      async queryStatus() { return { committed: false } },
    }
    await expect(settlement.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-never-sent') },
      neverTransmits,
      ready,
    )).rejects.toThrow(/without installing its durable send fence/)
    expect(await store.loadReceipts(desktopA)).toEqual([])
  })

  it('settles a prepared reservation left by a pre-fence crash without querying Desktop', async () => {
    const store = new InMemoryCompanionCacheStore()
    const operationId = parseCompanionOperationId('op-pre-fence-crash')
    await store.reserveReceipt(desktopA, { operationId, status: 'prepared', kind: 'prompt' })
    const queryStatus = vi.fn(async () => ({ committed: false as const }))

    await expect(new CompanionUncertainOperationSettlement(store, desktopA).reconcileUnknown({
      send: async () => { throw new Error('reconciliation must not send') },
      queryStatus,
    })).resolves.toEqual([
      { operationId, status: 'not-submitted', kind: 'prompt' },
    ])
    expect(queryStatus).not.toHaveBeenCalled()
  })

  it('retains the unknown fence when the send fails after the fence commits', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    let receiptObserved = false
    const failsAfterTransmit: CompanionMutationTransport = {
      async send(_mutation, beforeSend) {
        await beforeSend()
        receiptObserved = (await store.loadReceipts(desktopA)).length === 1
        throw new Error('relay dropped before the Desktop result arrived')
      },
      async queryStatus() { return { committed: false } },
    }
    await expect(settlement.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-dropped') },
      failsAfterTransmit,
      ready,
    )).rejects.toThrow(/relay dropped/)
    expect(receiptObserved).toBe(true)
    expect(await store.loadReceipts(desktopA)).toEqual([
      { operationId: parseCompanionOperationId('op-dropped'), status: 'unknown', kind: 'prompt' },
    ])
  })

  it('does not transmit when an unknown receipt already exists', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const operationId = parseCompanionOperationId('op-unknown-existing')
    await store.saveReceipt(desktopA, { operationId, status: 'unknown' })
    const transport = recordingTransport(undefined, { known: true, result: confirmed('op-unknown-existing') })
    await expect(settlement.transmit({ kind: 'prompt', operationId }, transport, ready)).rejects.toThrow(
      /must be reconciled before another transmit/,
    )
    expect(transport.sends).toBe(0)
  })

  it('returns a committed receipt without resending', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const operationId = parseCompanionOperationId('op-committed-existing')
    const original = confirmed('op-committed-existing')
    await store.saveReceipt(desktopA, { operationId, status: 'committed', original })
    const transport = recordingTransport(undefined, { known: true, result: confirmed('op-committed-existing') })
    await expect(settlement.transmit({ kind: 'prompt', operationId }, transport, ready)).resolves.toEqual({
      operationId,
      status: 'committed',
      original,
    })
    expect(transport.sends).toBe(0)
  })

  it('reconciles committed answers to the original result and absent answers to not-submitted', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const original = confirmed('op-reconcile')

    const committedTransport = statusTransport({ committed: true, original })
    await settlement.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-reconcile') },
      outcomeTransport({ known: false }),
      ready,
    )
    const settled = await settlement.reconcileUnknown(committedTransport)
    expect(settled).toEqual([{
      operationId: parseCompanionOperationId('op-reconcile'), status: 'committed', original, kind: 'prompt',
    }])
    await expect(settlement.reconcileUnknown(statusTransport({ committed: false }))).resolves.toEqual([])

    await settlement.transmit(
      { kind: 'approval', operationId: parseCompanionOperationId('op-absent') },
      outcomeTransport({ known: false }),
      ready,
    )
    const absent = await settlement.reconcileUnknown(statusTransport({ committed: false }))
    expect(absent.find(row => row.operationId === parseCompanionOperationId('op-absent'))?.status).toBe('not-submitted')
  })

  it('single-flights concurrent reconciliation of the same unknown receipt', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const operationId = parseCompanionOperationId('op-reconcile-single-flight')
    await settlement.transmit({ kind: 'prompt', operationId }, outcomeTransport({ known: false }), ready)
    let resolveStatus: ((answer: CompanionStatusAnswer) => void) | undefined
    const status = new Promise<CompanionStatusAnswer>((resolve) => { resolveStatus = resolve })
    const queryStatus = vi.fn(async () => await status)
    const transport: CompanionMutationTransport = {
      send: async () => { throw new Error('reconciliation must not send') },
      queryStatus,
    }
    const first = settlement.reconcileUnknown(transport)
    const second = settlement.reconcileUnknown(transport)
    await vi.waitFor(() => { expect(queryStatus).toHaveBeenCalled() })
    resolveStatus?.({ committed: false })

    await expect(Promise.all([first, second])).resolves.toEqual([
      [expect.objectContaining({ operationId, status: 'not-submitted' })],
      [expect.objectContaining({ operationId, status: 'not-submitted' })],
    ])
    expect(queryStatus).toHaveBeenCalledOnce()
  })

  it('never automatically replays an uncertain or unsynchronized operation', async () => {
    const store = new InMemoryCompanionCacheStore()
    const settlement = new CompanionUncertainOperationSettlement(store, desktopA)
    const operationId = parseCompanionOperationId('op-no-replay')
    const transport = recordingTransport(undefined, { known: false })
    await settlement.transmit({ kind: 'prompt', operationId }, transport, ready)

    const replaySpy = recordingTransport(undefined, { known: true, result: confirmed('op-no-replay') })
    const settled = await settlement.reconcileUnknown(replaySpy)
    expect(replaySpy.sends).toBe(0)
    expect(settled.find(row => row.operationId === operationId)?.status).toBe('not-submitted')

    await expect(settlement.transmit({ kind: 'prompt', operationId }, replaySpy, reconnecting))
      .rejects.toThrow(/foreground synchronization/)
    expect(replaySpy.sends).toBe(0)
  })

  it('clears one Paired Desktop cache without touching another Desktop in the same account store', async () => {
    const keys = { 'desktop-a': await freshKey(), 'desktop-b': await freshKey() }
    const cache = new CompanionCache(namespacedStore('cache-clear'), await cipherFor(keys))
    await cache.saveOpenedContent(desktopA, 'transcript', 'A transcript')
    await cache.saveOpenedContent(desktopB, 'transcript', 'B transcript')

    await cache.clearDesktopContent(desktopA)
    expect(await cache.loadOpenedContent(desktopA, 'transcript')).toBeUndefined()
    expect(await cache.loadOpenedContent(desktopB, 'transcript')).toContain('B transcript')
  })

  it('keeps receipts of other Desktops when one Desktop is cleared through the IndexedDB store', async () => {
    const store = namespacedStore('cache-clear-receipts')
    const a = new CompanionUncertainOperationSettlement(store, desktopA)
    const b = new CompanionUncertainOperationSettlement(store, desktopB)
    await a.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-a') },
      outcomeTransport({ known: false }),
      ready,
    )
    await b.transmit(
      { kind: 'prompt', operationId: parseCompanionOperationId('op-b') },
      outcomeTransport({ known: false }),
      ready,
    )
    await store.clearDesktop(desktopA)
    expect(await store.loadReceipts(desktopA)).toEqual([])
    expect((await store.loadReceipts(desktopB)).map(row => row.status)).toEqual(['unknown'])
  })
})

function outcomeTransport(outcome: CompanionMutationOutcome): CompanionMutationTransport {
  return {
    async send(_mutation, beforeSend) {
      await beforeSend()
      return outcome
    },
    async queryStatus() { return { committed: false } },
  }
}

function statusTransport(answer: CompanionStatusAnswer): CompanionMutationTransport {
  return {
    async send() { throw new Error('reconciliation must not send mutations') },
    async queryStatus(_operationId) { return answer },
  }
}

function recordingTransport(onSend: (() => void) | undefined, outcome: CompanionMutationOutcome) {
  const transport: CompanionMutationTransport & { sends: number } = {
    sends: 0,
    async send(_mutation: CompanionMutationRequest, beforeSend: CompanionTransmissionFence) {
      await beforeSend()
      transport.sends += 1
      onSend?.()
      return outcome
    },
    async queryStatus() { return { committed: false } },
  }
  return transport
}
