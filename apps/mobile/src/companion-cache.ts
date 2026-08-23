/** Per-Paired-Desktop Companion Cache and uncertain-operation recovery. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PlatformAccountId, PlatformEnvironment } from '@deepseek-ai/dsh-platform-account'
import { accountStorageNamespace } from '@deepseek-ai/dsh-platform-account-client'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionMutationResult,
  type CompanionOperationId,
  type CompanionSessionId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  companionMayMutate,
  requireCompanionMutation,
  type CompanionConnectionState,
} from './companion-mutation.ts'

/** Opaque Paired Desktop identity injected by the Personal Pairing seam. */
export type CompanionDesktopId = Branded<'CompanionDesktopId'>

const DESKTOP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Maximum Operation Receipts retained for one Paired Desktop. */
const COMPANION_CACHE_RECEIPT_LIMIT = REMOTE_PROTOCOL_LIMITS.containerValues

/**
 * Parse a Paired Desktop identity arriving from the Personal Pairing seam.
 * @param value - untrusted desktop identifier.
 * @returns branded Paired Desktop identity.
 */
export function parseCompanionDesktopId(value: unknown): CompanionDesktopId {
  if (typeof value !== 'string' || !DESKTOP_ID_PATTERN.test(value)) {
    throw new TypeError('Companion desktop id must be 1-128 base64url characters')
  }
  return value as CompanionDesktopId
}

/**
 * Build the account-scoped IndexedDB name for Companion Cache rows.
 * @param environment - deployment environment owning the cache.
 * @param accountId - Platform Account owning the cache.
 * @returns `${accountStorageNamespace(environment, accountId)}:companion-cache`.
 */
export function companionCacheDatabaseName(
  environment: PlatformEnvironment,
  accountId: PlatformAccountId,
): string {
  return `${accountStorageNamespace(environment, accountId)}:companion-cache`
}

/** Content kinds the Companion Cache may automatically seal. */
export type CompanionCacheContentKind =
  | 'workspace-metadata'
  | 'session-metadata'
  | 'transcript'
  | 'projection-snapshot'

/** Content kind that must never be automatically cached. */
type CompanionCacheExcludedKind = 'attachment-bytes' | 'terminal-content' | 'spill-file' | 'credential'

/** Content kinds that must never be automatically cached. */
const COMPANION_CACHE_EXCLUDED_KINDS: readonly CompanionCacheExcludedKind[] = [
  'attachment-bytes',
  'terminal-content',
  'spill-file',
  'credential',
]

const ADMITTED_CONTENT_KINDS: readonly CompanionCacheContentKind[] = [
  'workspace-metadata',
  'session-metadata',
  'transcript',
  'projection-snapshot',
]

/**
 * Decide whether one content kind may enter the automatic Companion Cache.
 * Unknown kinds stay out: only the explicit allowlist is admitted.
 * @param kind - content kind proposed for caching.
 * @returns whether the kind may be sealed automatically.
 */
export function companionCacheAdmits(kind: string): kind is CompanionCacheContentKind {
  if ((COMPANION_CACHE_EXCLUDED_KINDS as readonly string[]).includes(kind)) return false
  return (ADMITTED_CONTENT_KINDS as readonly string[]).includes(kind)
}

/** Mutations foreground synchronization gates; cache reads stay permitted. */
const COMPANION_OFFLINE_MUTATIONS = [
  'session-create',
  'prompt',
  'cancel',
  'approval',
  'question',
  'attachment',
  'other-mutation',
] as const

export type CompanionMutationKind = (typeof COMPANION_OFFLINE_MUTATIONS)[number]

/**
 * Whether a mutation may run in the current connection state.
 * @param connection - foreground connection and validated synchronization state.
 * @param _kind - mutation kind reserved for future per-kind policy.
 * @returns false until foreground reconnect and validated Desktop resynchronization complete.
 */
export function companionMutationAllowed(
  connection: CompanionConnectionState | undefined,
  _kind: CompanionMutationKind,
): boolean {
  return companionMayMutate(connection)
}

/** Encrypted-at-rest cache row for one Paired Desktop. */
export interface CompanionCacheRecord {
  desktopId: CompanionDesktopId
  iv: Uint8Array<ArrayBuffer>
  ciphertext: Uint8Array<ArrayBuffer>
}

/** Per-desktop AES key source owned by the Personal Pairing seam. */
export interface CompanionCacheKeySource {
  /**
   * Supply the cache encryption key derived for one Paired Desktop.
   * @param desktopId - Paired Desktop identity.
   * @returns non-extractable AES-GCM cache key.
   */
  keyFor(desktopId: CompanionDesktopId): Promise<CryptoKey>
}

/** Authenticated cipher sealing opened content per Paired Desktop. */
export interface CompanionCacheCipher {
  /**
   * Encrypt one cache row.
   * @param desktopId - Paired Desktop identity owning the key and AAD.
   * @param kind - admitted content kind bound as AAD.
   * @param plaintext - opened metadata or transcript bytes.
   * @returns sealed row with a fresh per-record IV.
   */
  seal(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
    plaintext: Uint8Array,
  ): Promise<CompanionCacheRecord>
  /**
   * Decrypt one cache row.
   * @param desktopId - caller-supplied Paired Desktop identity selecting the key and AAD.
   * @param kind - admitted content kind bound as AAD.
   * @param record - sealed row.
   * @returns opened metadata or transcript bytes.
   */
  open(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
    record: CompanionCacheRecord,
  ): Promise<Uint8Array>
}

function cacheAad(desktopId: CompanionDesktopId, kind: CompanionCacheContentKind): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`${desktopId}\0${kind}`))
}

/** WebCrypto AES-GCM cipher over per-desktop keys from the pairing seam. */
export class WebCryptoCompanionCacheCipher implements CompanionCacheCipher {
  readonly #keys: CompanionCacheKeySource

  /** @param keys - Personal Pairing seam supplying per-desktop cache keys. */
  constructor(keys: CompanionCacheKeySource) {
    this.#keys = keys
  }

  async seal(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
    plaintext: Uint8Array,
  ): Promise<CompanionCacheRecord> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const bytes = new Uint8Array(plaintext)
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: cacheAad(desktopId, kind) },
      await this.#keys.keyFor(desktopId),
      bytes,
    ))
    return { desktopId, iv, ciphertext }
  }

  async open(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
    record: CompanionCacheRecord,
  ): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: cacheAad(desktopId, kind) },
      await this.#keys.keyFor(desktopId),
      record.ciphertext,
    ))
  }
}

/** Durable lifecycle state of one proposed operation. */
type CompanionReceiptStatus = 'prepared' | 'unknown' | 'committed' | 'not-submitted'

/** Operation Receipt row reserved before transmission and settled afterward. */
export interface CompanionOperationReceipt {
  operationId: CompanionOperationId
  status: CompanionReceiptStatus
  /** Original mutation kind used to restore product presentation after restart. */
  kind?: CompanionMutationKind
  /** Session scope for prompt, cancel, interaction, and attachment recovery. */
  sessionId?: CompanionSessionId
  /** Desktop's original result once reconciliation returned committed. */
  original?: CompanionMutationResult
}

/**
 * Durable cache and receipt rows, separate from pairing-key storage. Content
 * rows are keyed by Paired Desktop and content kind, so metadata and a
 * transcript of one Desktop coexist.
 */
export interface CompanionCacheStore {
  /** Reserve bounded capacity before a mutation can leave the device. */
  reserveReceipt(desktopId: CompanionDesktopId, receipt: CompanionOperationReceipt): Promise<void>
  /** Remove a prepared reservation when the transport never installed its send fence. */
  deleteReceipt(desktopId: CompanionDesktopId, operationId: CompanionOperationId): Promise<void>
  /**
   * @param desktopId - Paired Desktop whose row is written.
   * @param kind - admitted content kind of the row.
   * @param record - sealed row.
   */
  saveContent(desktopId: CompanionDesktopId, kind: CompanionCacheContentKind, record: CompanionCacheRecord): Promise<void>
  /**
   * @param desktopId - Paired Desktop whose row is read.
   * @param kind - admitted content kind of the row.
   * @returns sealed row, or `undefined` when nothing is cached.
   */
  loadContent(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
  ): Promise<CompanionCacheRecord | undefined>
  /**
   * Drop one Paired Desktop's cached rows; pairing-key records stay untouched.
   * @param desktopId - Paired Desktop to clear.
   */
  clearDesktop(desktopId: CompanionDesktopId): Promise<void>
  /**
   * @param desktopId - owning Paired Desktop.
   * @param receipt - receipt row.
   */
  saveReceipt(desktopId: CompanionDesktopId, receipt: CompanionOperationReceipt): Promise<void>
  /**
   * @param desktopId - owning Paired Desktop.
   * @returns every stored receipt row.
   */
  loadReceipts(desktopId: CompanionDesktopId): Promise<readonly CompanionOperationReceipt[]>
}

function contentKey(desktopId: CompanionDesktopId, kind: CompanionCacheContentKind): string {
  return `${desktopId}::${kind}`
}

function desktopPrefix(desktopId: CompanionDesktopId): string {
  return `${desktopId}::`
}

function openedContentByteLimit(kind: CompanionCacheContentKind): number {
  return kind === 'transcript'
    ? REMOTE_PROTOCOL_LIMITS.transcriptPageBytes
    : REMOTE_PROTOCOL_LIMITS.companionMessageBytes
}

function requireReceiptCapacity(existingCount: number, replacing: boolean): void {
  if (!replacing && existingCount >= COMPANION_CACHE_RECEIPT_LIMIT) {
    throw new Error(`Companion Cache receipt count exceeds the ${String(COMPANION_CACHE_RECEIPT_LIMIT)}-row ceiling`)
  }
}

function requireReceiptCount(count: number): void {
  if (count > COMPANION_CACHE_RECEIPT_LIMIT) {
    throw new Error(`Companion Cache receipt count exceeds the ${String(COMPANION_CACHE_RECEIPT_LIMIT)}-row ceiling`)
  }
}

function durableRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseUint8Array(value: unknown, name: string, exactLength?: number): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || (exactLength !== undefined && value.byteLength !== exactLength)) {
    throw new TypeError(
      exactLength === undefined
        ? `${name} must be a Uint8Array`
        : `${name} must be a ${String(exactLength)}-byte Uint8Array`,
    )
  }
  return value as Uint8Array<ArrayBuffer>
}

function parseCompanionCacheRecord(value: unknown): CompanionCacheRecord {
  const record = durableRecord(value, 'Companion Cache content row')
  return {
    desktopId: parseCompanionDesktopId(record.desktopId),
    iv: parseUint8Array(record.iv, 'Companion Cache iv', 12),
    ciphertext: parseUint8Array(record.ciphertext, 'Companion Cache ciphertext'),
  }
}

function parseCompanionMutationResult(value: unknown): CompanionMutationResult {
  const record = durableRecord(value, 'Companion confirmed result')
  const operationId = parseCompanionOperationId(record.operationId)
  if (record.type === 'confirmed' && record.outcome === 'accepted'
    && typeof record.committedAt === 'number' && Number.isSafeInteger(record.committedAt) && record.committedAt > 0) {
    return { type: 'confirmed', operationId, committedAt: record.committedAt, outcome: 'accepted' }
  }
  if (record.type === 'attachment-rejected'
    && (record.reason === 'cross-pairing' || record.reason === 'hash-mismatch' || record.reason === 'expired'
      || record.reason === 'absent' || record.reason === 'transfer-interrupted' || record.reason === 'limit-exceeded')) {
    return { type: 'attachment-rejected', operationId, reason: record.reason }
  }
  if (record.type === 'interaction-receipt' && record.accepted === true) {
    return { type: 'interaction-receipt', operationId, accepted: true }
  }
  if (record.type === 'interaction-receipt' && record.accepted === false
    && (record.reason === 'not-pending' || record.reason === 'bad-response')) {
    return { type: 'interaction-receipt', operationId, accepted: false, reason: record.reason }
  }
  if (record.type === 'operation-failed' && typeof record.failure === 'object' && record.failure !== null) {
    return structuredClone(record) as unknown as CompanionMutationResult
  }
  throw new TypeError('Companion terminal mutation result is unsupported')
}

function parseReceiptStatus(value: unknown): CompanionReceiptStatus {
  if (value === 'prepared' || value === 'unknown' || value === 'committed' || value === 'not-submitted') return value
  throw new TypeError('Companion receipt status is unsupported')
}

function parseReceiptKind(value: unknown): CompanionMutationKind | undefined {
  if (value === undefined) return undefined
  if (value === 'session-create' || value === 'prompt' || value === 'cancel' || value === 'approval'
    || value === 'question' || value === 'attachment' || value === 'other-mutation') return value
  throw new TypeError('Companion receipt mutation kind is unsupported')
}

function parseCompanionOperationReceipt(value: unknown): CompanionOperationReceipt {
  const record = durableRecord(value, 'Companion Operation Receipt')
  const operationId = parseCompanionOperationId(record.operationId)
  const status = parseReceiptStatus(record.status)
  const kind = parseReceiptKind(record.kind)
  const sessionId = record.sessionId === undefined ? undefined : parseCompanionSessionId(record.sessionId)
  if (status === 'committed') {
    if (record.original === undefined) {
      throw new TypeError('Companion committed receipt must embed its original result')
    }
    const original = parseCompanionMutationResult(record.original)
    if (original.operationId !== operationId) {
      throw new TypeError('Companion committed receipt original must name the same operation id')
    }
    return {
      operationId, status, original,
      ...(kind === undefined ? {} : { kind }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
  }
  if (record.original !== undefined) {
    throw new TypeError('Companion uncommitted receipt cannot embed an original result')
  }
  return {
    operationId, status,
    ...(kind === undefined ? {} : { kind }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function assertRecordDesktop(
  record: CompanionCacheRecord,
  desktopId: CompanionDesktopId,
): CompanionCacheRecord {
  if (record.desktopId !== desktopId) {
    throw new TypeError('Companion Cache content row desktop id does not match the requested desktop')
  }
  return record
}

/** In-memory store for tests and keyless example compositions. */
export class InMemoryCompanionCacheStore implements CompanionCacheStore {
  readonly #content = new Map<string, CompanionCacheRecord>()
  readonly #receipts = new Map<string, CompanionOperationReceipt>()

  saveContent(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
    record: CompanionCacheRecord,
  ): Promise<void> {
    this.#content.set(contentKey(desktopId, kind), record)
    return Promise.resolve()
  }

  loadContent(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
  ): Promise<CompanionCacheRecord | undefined> {
    return Promise.resolve(this.#content.get(contentKey(desktopId, kind)))
  }

  clearDesktop(desktopId: CompanionDesktopId): Promise<void> {
    const prefix = desktopPrefix(desktopId)
    for (const key of [...this.#content.keys(), ...this.#receipts.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.#content.delete(key)
      this.#receipts.delete(key)
    }
    return Promise.resolve()
  }

  reserveReceipt(desktopId: CompanionDesktopId, receipt: CompanionOperationReceipt): Promise<void> {
    const prefix = desktopPrefix(desktopId)
    const key = `${prefix}${receipt.operationId}`
    if (!this.#receipts.has(key)) {
      const owned = [...this.#receipts.entries()].filter(([candidate]) => candidate.startsWith(prefix))
      if (owned.length >= COMPANION_CACHE_RECEIPT_LIMIT) {
        const terminal = owned.find(([, row]) => row.status === 'committed' || row.status === 'not-submitted')
        if (terminal === undefined) requireReceiptCapacity(owned.length, false)
        else this.#receipts.delete(terminal[0])
      }
    }
    this.#receipts.set(key, receipt)
    return Promise.resolve()
  }

  deleteReceipt(desktopId: CompanionDesktopId, operationId: CompanionOperationId): Promise<void> {
    this.#receipts.delete(`${desktopPrefix(desktopId)}${operationId}`)
    return Promise.resolve()
  }

  saveReceipt(desktopId: CompanionDesktopId, receipt: CompanionOperationReceipt): Promise<void> {
    const key = `${desktopPrefix(desktopId)}${receipt.operationId}`
    requireReceiptCapacity(
      [...this.#receipts.keys()].filter(row => row.startsWith(desktopPrefix(desktopId))).length,
      this.#receipts.has(key),
    )
    this.#receipts.set(key, receipt)
    return Promise.resolve()
  }

  loadReceipts(desktopId: CompanionDesktopId): Promise<readonly CompanionOperationReceipt[]> {
    const prefix = desktopPrefix(desktopId)
    const rows = [...this.#receipts.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => row)
    requireReceiptCount(rows.length)
    return Promise.resolve(rows)
  }
}

/** IndexedDB cache store for stable Mobile webview origins. */
export class IndexedDbCompanionCacheStore implements CompanionCacheStore {
  readonly #database: Promise<IDBDatabase>

  /**
   * @param databaseName - account-scoped name from `companionCacheDatabaseName`;
   *   there is no installation-global default.
   */
  constructor(databaseName: string) {
    if (databaseName.length === 0) {
      throw new TypeError('Companion Cache IndexedDB name must come from companionCacheDatabaseName')
    }
    this.#database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('content')
        request.result.createObjectStore('receipts')
      }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('Companion cache IndexedDB open failed')) }
    })
  }

  async saveContent(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
    record: CompanionCacheRecord,
  ): Promise<void> {
    await this.write('content', contentKey(desktopId, kind), record)
  }

  async loadContent(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
  ): Promise<CompanionCacheRecord | undefined> {
    const value = await this.read('content', contentKey(desktopId, kind))
    return value === undefined ? undefined : assertRecordDesktop(parseCompanionCacheRecord(value), desktopId)
  }

  async clearDesktop(desktopId: CompanionDesktopId): Promise<void> {
    const database = await this.#database
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['content', 'receipts'], 'readwrite')
      const range = desktopRange(desktopId)
      transaction.objectStore('content').delete(range)
      transaction.objectStore('receipts').delete(range)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Companion cache IndexedDB delete failed')) }
    })
  }

  async reserveReceipt(desktopId: CompanionDesktopId, receipt: CompanionOperationReceipt): Promise<void> {
    const database = await this.#database
    await new Promise<void>((resolve, reject) => {
      const key = `${desktopPrefix(desktopId)}${receipt.operationId}`
      let limitError: Error | undefined
      const transaction = database.transaction('receipts', 'readwrite')
      const store = transaction.objectStore('receipts')
      const keysRequest = store.getAllKeys(desktopRange(desktopId))
      const rowsRequest = store.getAll(desktopRange(desktopId))
      const reserve = (): void => {
        if (keysRequest.readyState !== 'done' || rowsRequest.readyState !== 'done') return
        if (!keysRequest.result.includes(key) && keysRequest.result.length >= COMPANION_CACHE_RECEIPT_LIMIT) {
          const terminalIndex = rowsRequest.result.findIndex((row: unknown) => (
            ['committed', 'not-submitted'].includes(parseCompanionOperationReceipt(row).status)
          ))
          if (terminalIndex < 0) {
            try { requireReceiptCapacity(keysRequest.result.length, false) } catch (error) {
              limitError = error instanceof Error ? error : new Error(String(error))
            }
            transaction.abort()
            return
          }
          const terminalKey = keysRequest.result[terminalIndex]
          if (terminalKey === undefined) throw new Error('Companion cache terminal receipt key is unavailable')
          store.delete(terminalKey)
        }
        store.put(receipt, key)
      }
      keysRequest.onsuccess = reserve
      rowsRequest.onsuccess = reserve
      transaction.oncomplete = () => { resolve() }
      transaction.onabort = () => { reject(limitError ?? transaction.error ?? new Error('Companion cache receipt reservation failed')) }
      transaction.onerror = () => { reject(limitError ?? transaction.error ?? new Error('Companion cache receipt reservation failed')) }
    })
  }

  async deleteReceipt(desktopId: CompanionDesktopId, operationId: CompanionOperationId): Promise<void> {
    await this.writeDelete('receipts', `${desktopPrefix(desktopId)}${operationId}`)
  }

  async saveReceipt(desktopId: CompanionDesktopId, receipt: CompanionOperationReceipt): Promise<void> {
    const database = await this.#database
    await new Promise<void>((resolve, reject) => {
      const key = `${desktopPrefix(desktopId)}${receipt.operationId}`
      let limitError: Error | undefined
      // One readwrite transaction covers the count and put, so concurrent
      // senders cannot interleave past the receipt ceiling.
      const transaction = database.transaction('receipts', 'readwrite')
      const store = transaction.objectStore('receipts')
      const keysRequest = store.getAllKeys(desktopRange(desktopId))
      keysRequest.onsuccess = () => {
        const keys = keysRequest.result
        try {
          requireReceiptCapacity(keys.length, keys.includes(key))
        } catch (error) {
          limitError = error instanceof Error ? error : new Error(String(error))
          transaction.abort()
          return
        }
        store.put(receipt, key)
      }
      transaction.oncomplete = () => { resolve() }
      transaction.onabort = () => {
        reject(limitError ?? transaction.error ?? new Error('Companion cache IndexedDB write failed'))
      }
      transaction.onerror = () => {
        reject(limitError ?? transaction.error ?? new Error('Companion cache IndexedDB write failed'))
      }
    })
  }

  async loadReceipts(desktopId: CompanionDesktopId): Promise<readonly CompanionOperationReceipt[]> {
    const database = await this.#database
    return new Promise((resolve, reject) => {
      const request = database.transaction('receipts', 'readonly').objectStore('receipts').getAll(desktopRange(desktopId))
      request.onsuccess = () => {
        try {
          const rows = request.result
          if (!Array.isArray(rows)) {
            throw new TypeError('Companion Cache receipts must be an array')
          }
          requireReceiptCount(rows.length)
          resolve(rows.map(row => parseCompanionOperationReceipt(row)))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
        }
      }
      request.onerror = () => { reject(request.error ?? new Error('Companion cache IndexedDB read failed')) }
    })
  }

  private async read(store: 'content' | 'receipts', key: string): Promise<unknown> {
    const database = await this.#database
    return new Promise((resolve, reject) => {
      const request = database.transaction(store, 'readonly').objectStore(store).get(key)
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('Companion cache IndexedDB read failed')) }
    })
  }

  private async write(store: 'content' | 'receipts', key: string, value: unknown): Promise<void> {
    const database = await this.#database
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(store, 'readwrite')
      transaction.objectStore(store).put(value, key)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Companion cache IndexedDB write failed')) }
    })
  }

  private async writeDelete(store: 'content' | 'receipts', key: string): Promise<void> {
    const database = await this.#database
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(store, 'readwrite')
      transaction.objectStore(store).delete(key)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Companion cache IndexedDB delete failed')) }
    })
  }
}

function desktopRange(desktopId: CompanionDesktopId): IDBKeyRange {
  const prefix = desktopPrefix(desktopId)
  return IDBKeyRange.bound(prefix, `${prefix}\u{10ffff}`, false, false)
}

/** Sealed Companion Cache for one installation; cache rows stay read-only authority. */
export class CompanionCache {
  readonly #store: CompanionCacheStore
  readonly #cipher: CompanionCacheCipher

  /** @param store - durable rows. @param cipher - per-desktop authenticated cipher. */
  constructor(store: CompanionCacheStore, cipher: CompanionCacheCipher) {
    this.#store = store
    this.#cipher = cipher
  }

  /**
   * Seal opened Workspace/Session metadata or a transcript for offline reads.
   * @param desktopId - Paired Desktop that confirmed the content.
   * @param kind - admitted content kind; excluded kinds fail loud.
   * @param plaintext - Desktop-confirmed content.
   */
  async saveOpenedContent(
    desktopId: CompanionDesktopId,
    kind: string,
    plaintext: string,
  ): Promise<void> {
    if (!companionCacheAdmits(kind)) {
      throw new TypeError(`Companion Cache never automatically stores ${kind}`)
    }
    const bytes = new TextEncoder().encode(plaintext)
    const limit = openedContentByteLimit(kind)
    if (bytes.byteLength > limit) {
      throw new TypeError(`Companion Cache ${kind} exceeds the ${String(limit)}-byte ceiling`)
    }
    await this.#store.saveContent(desktopId, kind, await this.#cipher.seal(desktopId, kind, bytes))
  }

  /**
   * Read cached plaintext; Remote Offline permits this read.
   * @param desktopId - Paired Desktop whose cache is read; selects the key and AAD.
   * @param kind - admitted content kind of the row.
   * @returns Desktop-confirmed content, or `undefined` when nothing is cached.
   */
  async loadOpenedContent(
    desktopId: CompanionDesktopId,
    kind: CompanionCacheContentKind,
  ): Promise<string | undefined> {
    const record = await this.#store.loadContent(desktopId, kind)
    if (record === undefined) return undefined
    assertRecordDesktop(record, desktopId)
    return new TextDecoder().decode(await this.#cipher.open(desktopId, kind, record))
  }

  /**
   * Clear one Paired Desktop's cached rows; pairing-key records live in the
   * pairing seam's own store and survive this operation.
   * @param desktopId - Paired Desktop to clear.
   */
  async clearDesktopCache(desktopId: CompanionDesktopId): Promise<void> {
    await this.#store.clearDesktop(desktopId)
  }
}

/** Desktop answer to one operation-status query. */
export type CompanionStatusAnswer =
  | { readonly committed: true; readonly original: CompanionMutationResult }
  | { readonly committed: false }

/** One proposed mutation with its Desktop-authoritative operation id. */
export interface CompanionMutationRequest {
  kind: CompanionMutationKind
  operationId: CompanionOperationId
  sessionId?: CompanionSessionId
}

/** Transport result once the mutation's fate is known, or explicitly unknown. */
export type CompanionMutationOutcome =
  | { readonly known: true; readonly result: CompanionMutationResult }
  | { readonly known: false }

/** Durable fence invoked immediately before a mutation may leave this device. */
export type CompanionTransmissionFence = () => void | Promise<void>

/** Relay-backed transport the settlement controller drives. */
export interface CompanionMutationTransport {
  /**
   * Transmit one mutation; await `beforeSend` exactly once immediately before
   * the first external send attempt. Any later success or failure is uncertain
   * until Desktop reconciliation.
   * @param mutation - proposed mutation.
   * @param beforeSend - durable unknown-outcome fence.
   * @returns the Desktop result, or an explicitly unknown outcome.
   */
  send(
    mutation: CompanionMutationRequest,
    beforeSend: CompanionTransmissionFence,
  ): Promise<CompanionMutationOutcome>
  /**
   * Query Desktop for the authoritative outcome of one transmitted operation.
   * @param operationId - operation whose receipt is unknown.
   * @returns committed with the original result, or explicitly absent.
   */
  queryStatus(operationId: CompanionOperationId): Promise<CompanionStatusAnswer>
}

/** Single settlement point for uncertain Companion operations. */
export class CompanionUncertainOperationSettlement {
  readonly #store: CompanionCacheStore
  readonly #desktopId: CompanionDesktopId
  readonly #inFlight = new Set<CompanionOperationId>()
  #transitions: Promise<void> = Promise.resolve()
  #reconciliation: Promise<readonly CompanionOperationReceipt[]> | undefined

  /** @param store - durable receipt rows. @param desktopId - owning Paired Desktop. */
  constructor(store: CompanionCacheStore, desktopId: CompanionDesktopId) {
    this.#store = store
    this.#desktopId = desktopId
  }

  /**
   * Transmit one mutation after reserving bounded capacity and durably changing
   * that reservation to `unknown` immediately before the external send. An
   * existing `unknown` receipt must be reconciled first; a `committed` receipt
   * is returned without resending.
   * @param mutation - proposed mutation.
   * @param transport - Relay-backed transport.
   * @param connection - foreground connection and validated synchronization state.
   * @returns the settled receipt, or the unknown receipt awaiting reconciliation.
   */
  async transmit(
    mutation: CompanionMutationRequest,
    transport: CompanionMutationTransport,
    connection: CompanionConnectionState | undefined,
  ): Promise<CompanionOperationReceipt> {
    requireCompanionMutation(connection, mutation.kind)
    const existing = await this.transition(async () => {
      const found = (await this.#store.loadReceipts(this.#desktopId))
        .find(row => row.operationId === mutation.operationId)
      if (found?.status === 'prepared' && this.#inFlight.has(mutation.operationId)) {
        throw new Error(`Companion operation ${mutation.operationId} is already transmitting`)
      }
      if (found === undefined) {
        await this.#store.reserveReceipt(this.#desktopId, {
          operationId: mutation.operationId, status: 'prepared', kind: mutation.kind,
          ...(mutation.sessionId === undefined ? {} : { sessionId: mutation.sessionId }),
        })
      }
      if (found?.status !== 'unknown' && found?.status !== 'committed') {
        this.#inFlight.add(mutation.operationId)
      }
      return found
    })
    if (existing?.status === 'unknown') {
      throw new Error(
        `Companion operation ${mutation.operationId} is unknown and must be reconciled before another transmit`,
      )
    }
    if (existing?.status === 'committed') {
      return existing
    }
    try {
      let transmissionFence: Promise<void> | undefined
      let outcome: CompanionMutationOutcome
      try {
        outcome = await transport.send(mutation, () => {
          if (transmissionFence !== undefined) {
            throw new Error('Companion transport installed its durable send fence more than once')
          }
          transmissionFence = this.transition(async () => {
            await this.#store.saveReceipt(this.#desktopId, {
              operationId: mutation.operationId, status: 'unknown', kind: mutation.kind,
              ...(mutation.sessionId === undefined ? {} : { sessionId: mutation.sessionId }),
            })
          })
          return transmissionFence
        })
      } catch (error) {
        if (transmissionFence === undefined) {
          await this.transition(async () => { await this.#store.deleteReceipt(this.#desktopId, mutation.operationId) })
        } else {
          await transmissionFence
        }
        throw error
      }
      await transmissionFence
      if (transmissionFence === undefined) {
        await this.transition(async () => { await this.#store.deleteReceipt(this.#desktopId, mutation.operationId) })
        throw new Error('Companion transport returned without installing its durable send fence')
      }
      const receipt: CompanionOperationReceipt = outcome.known
        ? {
          operationId: mutation.operationId, status: 'committed', original: outcome.result, kind: mutation.kind,
          ...(mutation.sessionId === undefined ? {} : { sessionId: mutation.sessionId }),
        }
        : {
          operationId: mutation.operationId, status: 'unknown', kind: mutation.kind,
          ...(mutation.sessionId === undefined ? {} : { sessionId: mutation.sessionId }),
        }
      await this.transition(async () => { await this.#store.saveReceipt(this.#desktopId, receipt) })
      return receipt
    } finally {
      this.#inFlight.delete(mutation.operationId)
    }
  }

  /**
   * Reconcile every unknown receipt by querying Desktop per operation id.
   * Committed answers keep the original result; explicit absence becomes
   * not-submitted. No operation is re-sent.
   * @param transport - reachable Relay-backed transport.
   * @returns receipts after reconciliation.
   */
  async reconcileUnknown(transport: CompanionMutationTransport): Promise<readonly CompanionOperationReceipt[]> {
    if (this.#reconciliation !== undefined) return await this.#reconciliation
    const reconciliation = this.reconcileOwned(transport)
    this.#reconciliation = reconciliation
    try { return await reconciliation } finally {
      if (this.#reconciliation === reconciliation) this.#reconciliation = undefined
    }
  }

  private async reconcileOwned(transport: CompanionMutationTransport): Promise<readonly CompanionOperationReceipt[]> {
    const rows = await this.transition(async () => await this.#store.loadReceipts(this.#desktopId))
    const reconciled: CompanionOperationReceipt[] = []
    for (const row of rows) {
      if (row.status === 'prepared') {
        const next = { ...row, status: 'not-submitted' as const }
        const accepted = await this.transition(async () => {
          const current = (await this.#store.loadReceipts(this.#desktopId))
            .find(candidate => candidate.operationId === row.operationId)
          if (current?.status !== 'prepared' || this.#inFlight.has(row.operationId)) return false
          await this.#store.saveReceipt(this.#desktopId, next)
          return true
        })
        if (accepted) reconciled.push(next)
        continue
      }
      if (row.status !== 'unknown') continue
      const answer = await transport.queryStatus(row.operationId)
      const next: CompanionOperationReceipt = answer.committed
        ? { ...row, status: 'committed', original: answer.original }
        : { ...row, status: 'not-submitted' }
      const accepted = await this.transition(async () => {
        const current = (await this.#store.loadReceipts(this.#desktopId))
          .find(candidate => candidate.operationId === row.operationId)
        if (current?.status !== 'unknown') return false
        await this.#store.saveReceipt(this.#desktopId, next)
        return true
      })
      if (accepted) reconciled.push(next)
    }
    return reconciled
  }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transitions.then(operation, operation)
    this.#transitions = result.then(() => undefined, () => undefined)
    return result
  }
}
