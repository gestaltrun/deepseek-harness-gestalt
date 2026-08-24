/** Durable idempotency owner for pairing-scoped Companion mutations. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parsePersonalPairingId, type PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  type CompanionOperation, type CompanionOperationId, type CompanionResult,
} from '@deepseek-ai/dsh-remote-protocol'

const MAX_RECORDS = 256
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const PERSISTED_RESULT_PROTOCOL = negotiateCompanionProtocol(
  createCompanionNegotiationChannel(),
  createCompanionVersionOffer('mobile'),
  createCompanionVersionOffer('desktop'),
)

interface PersistedOperationRecord {
  pairingId: PersonalPairingId
  operationId: CompanionOperationId
  fingerprint: string
  updatedAt: number
  result?: CompanionResult
}

interface DesktopCompanionOperationStore {
  load(): Promise<readonly PersistedOperationRecord[]>
  save(records: readonly PersistedOperationRecord[]): Promise<void>
}

/** Owner-only atomic JSON adapter for the Desktop operation ledger. */
export class FileDesktopCompanionOperationStore implements DesktopCompanionOperationStore {
  /** @param path - exact owner-only ledger path under the Desktop application data directory. */
  constructor(private readonly path: string) {}

  async load(): Promise<readonly PersistedOperationRecord[]> {
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value) || value.length > MAX_RECORDS) {
      throw new TypeError('Desktop Companion operation ledger must contain a bounded array')
    }
    return value.map(parseRecord)
  }

  async save(records: readonly PersistedOperationRecord[]): Promise<void> {
    if (records.length > MAX_RECORDS) throw new Error('Desktop Companion operation ledger capacity exceeded')
    await writeFileAtomic(this.path, JSON.stringify(records), { mode: 0o600, dirMode: 0o700 })
  }
}

/** Serialized prepared and terminal mutation transactions for one Desktop installation. */
export class DesktopCompanionOperationLedger {
  private readonly records = new Map<string, PersistedOperationRecord>()
  private readonly pendingCommits = new Map<string, PersistedOperationRecord>()
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<CompanionResult> }>()
  private transactions: Promise<void> = Promise.resolve()
  private persistence: Promise<void> = Promise.resolve()

  private constructor(
    private readonly store: DesktopCompanionOperationStore,
    private readonly now: () => number,
    records: readonly PersistedOperationRecord[],
  ) {
    for (const record of records) this.records.set(recordKey(record.pairingId, record.operationId), cloneRecord(record))
  }

  /**
   * Load and validate the durable operation ledger.
   * @param store - durable owner-only adapter.
   * @param now - product clock.
   * @returns ready serialized ledger.
   */
  static async load(
    store: DesktopCompanionOperationStore,
    now: () => number = Date.now,
  ): Promise<DesktopCompanionOperationLedger> {
    return new DesktopCompanionOperationLedger(store, now, await store.load())
  }

  /**
   * Prepare, execute, and commit one mutation or return its original committed result.
   * @param pairingId - exact Personal Pairing authority.
   * @param operation - decoded mutation carrying its stable id.
   * @param effect - Host effect executed only after this call durably creates a new preparation.
   * @returns original or newly committed terminal result.
   */
  async execute(
    pairingId: PersonalPairingId,
    operation: CompanionOperation,
    effect: () => Promise<CompanionResult>,
  ): Promise<CompanionResult> {
    const key = recordKey(pairingId, operation.operationId)
    const fingerprint = operationFingerprint(operation)
    const running = this.inFlight.get(key)
    if (running !== undefined) {
      if (running.fingerprint !== fingerprint) throw new Error('Desktop Companion operation id collision')
      return structuredClone(await running.result)
    }
    const result = this.serialized(
      async () => await this.executeOwned(key, pairingId, operation, fingerprint, effect),
    )
    this.inFlight.set(key, { fingerprint, result })
    try {
      return structuredClone(await result)
    } finally {
      if (this.inFlight.get(key)?.result === result) this.inFlight.delete(key)
    }
  }

  /**
   * Read one pairing-scoped committed mutation result without executing it.
   * @param pairingId - authenticated Personal Pairing asking for status.
   * @param operationId - original mutation identity.
   * @returns the durable terminal result, or undefined when no record exists. A
   *   recovered preparation first becomes a durable outcome-unknown failure.
   */
  async query(
    pairingId: PersonalPairingId,
    operationId: CompanionOperationId,
  ): Promise<CompanionResult | undefined> {
    return await this.serialized(async () => {
      await this.flushPendingCommits()
      this.pruneExpired()
      const key = recordKey(pairingId, operationId)
      const record = this.records.get(key)
      if (record === undefined) return undefined
      if (record.result === undefined) return await this.commitUnknownOutcome(key, record)
      return structuredClone(record.result)
    })
  }

  private async executeOwned(
    key: string,
    pairingId: PersonalPairingId,
    operation: CompanionOperation,
    fingerprint: string,
    effect: () => Promise<CompanionResult>,
  ): Promise<CompanionResult> {
    await this.flushPendingCommits()
    const beforePreparation = [...this.records.entries()].map(([recordKeyValue, record]) => [
      recordKeyValue, cloneRecord(record),
    ] as const)
    this.pruneExpired()
    const existing = this.records.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error('Desktop Companion operation id collision')
      if (existing.result !== undefined) return structuredClone(existing.result)
      return await this.commitUnknownOutcome(key, existing)
    } else {
      this.evictTerminalRecords()
      if (this.records.size >= MAX_RECORDS) throw new Error('Desktop Companion operation ledger capacity exceeded')
      this.records.set(key, {
        pairingId, operationId: operation.operationId, fingerprint, updatedAt: this.now(),
      })
    }
    if (!sameRecords(beforePreparation, this.records)) {
      try {
        await this.persist()
      } catch (error) {
        this.replaceRecords(beforePreparation)
        throw error
      }
    }
    const result = await effect()
    const prepared = this.records.get(key)
    if (prepared === undefined || prepared.fingerprint !== fingerprint) {
      throw new Error('Desktop Companion operation transaction was replaced')
    }
    const committed = { ...prepared, updatedAt: this.now(), result: structuredClone(result) }
    this.pendingCommits.set(key, committed)
    await this.flushPendingCommits()
    return structuredClone(committed.result)
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transactions.then(operation, operation)
    this.transactions = result.then(() => undefined, () => undefined)
    return result
  }

  private async flushPendingCommits(): Promise<void> {
    if (this.pendingCommits.size === 0) return
    const snapshot = new Map(this.records)
    for (const [key, record] of this.pendingCommits) snapshot.set(key, record)
    await this.persist([...snapshot.values()])
    this.replaceRecords([...snapshot.entries()])
    this.pendingCommits.clear()
  }

  private async commitUnknownOutcome(
    key: string,
    prepared: PersistedOperationRecord,
  ): Promise<CompanionResult> {
    const result: CompanionResult = {
      type: 'operation-failed',
      operationId: prepared.operationId,
      failure: {
        kind: 'business',
        code: 'companion-outcome-unknown',
        message: 'Desktop Host effect outcome is unknown after operation ledger recovery.',
      },
    }
    this.pendingCommits.set(key, { ...prepared, updatedAt: this.now(), result })
    await this.flushPendingCommits()
    return structuredClone(result)
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [key, record] of this.records) {
      if (record.result !== undefined && now >= record.updatedAt && now - record.updatedAt >= RECORD_TTL_MS) {
        this.records.delete(key)
      }
    }
  }

  private evictTerminalRecords(): void {
    while (this.records.size >= MAX_RECORDS) {
      const terminal = [...this.records.entries()].filter(entry => entry[1].result !== undefined)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]
      if (terminal === undefined) return
      this.records.delete(terminal[0])
    }
  }

  private replaceRecords(records: readonly (readonly [string, PersistedOperationRecord])[]): void {
    this.records.clear()
    for (const [key, record] of records) this.records.set(key, cloneRecord(record))
  }

  private async persist(records: readonly PersistedOperationRecord[] = [...this.records.values()]): Promise<void> {
    const snapshot = records.map(cloneRecord)
    const save = this.persistence.then(async () => {
      await this.store.save(snapshot)
    })
    this.persistence = save.catch(() => {})
    await save
  }
}

function operationFingerprint(operation: CompanionOperation): string {
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex')
}

function recordKey(pairingId: PersonalPairingId, operationId: CompanionOperationId): string {
  return `${pairingId}\0${operationId}`
}

function cloneRecord(record: PersistedOperationRecord): PersistedOperationRecord {
  return {
    ...record,
    ...(record.result === undefined ? {} : { result: structuredClone(record.result) }),
  }
}

function parseRecord(value: unknown): PersistedOperationRecord {
  if (!isRecord(value)) throw new TypeError('Desktop Companion operation record must be an object')
  const keys = value.result === undefined
    ? ['pairingId', 'operationId', 'fingerprint', 'updatedAt']
    : ['pairingId', 'operationId', 'fingerprint', 'updatedAt', 'result']
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError('Desktop Companion operation record contains unsupported fields')
  }
  if (typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(value.fingerprint)
    || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0) {
    throw new TypeError('Desktop Companion operation record is invalid')
  }
  const pairingId = parsePersonalPairingId(value.pairingId)
  const operationId = parseCompanionOperationId(value.operationId)
  const result = value.result === undefined ? undefined : parseResult(value.result)
  if (result !== undefined && result.operationId !== operationId) {
    throw new TypeError('Desktop Companion operation result operationId must match its record')
  }
  return {
    pairingId,
    operationId,
    fingerprint: value.fingerprint,
    updatedAt: value.updatedAt as number,
    ...(result === undefined ? {} : { result }),
  }
}

function parseResult(value: unknown): CompanionResult {
  const message = decodeCompanionMessage(PERSISTED_RESULT_PROTOCOL, new TextEncoder().encode(JSON.stringify({
    applicationVersion: PERSISTED_RESULT_PROTOCOL.major,
    type: 'result',
    result: value,
  })))
  if (message.type !== 'result') throw new TypeError('Desktop Companion operation result is invalid')
  return message.result
}

function sameRecords(
  before: readonly (readonly [string, PersistedOperationRecord])[],
  after: ReadonlyMap<string, PersistedOperationRecord>,
): boolean {
  if (before.length !== after.size) return false
  return before.every(([key, record]) => {
    const current = after.get(key)
    return current !== undefined && JSON.stringify(current) === JSON.stringify(record)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
