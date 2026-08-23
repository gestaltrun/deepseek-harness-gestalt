/** Durable idempotency owner for pairing-scoped Companion mutations. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import type {
  CompanionOperation, CompanionOperationId, CompanionResult,
} from '@deepseek-ai/dsh-remote-protocol'

const MAX_RECORDS = 256

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

/** Serialized prepared/committed mutation transactions for one Desktop installation. */
export class DesktopCompanionOperationLedger {
  private readonly records = new Map<string, PersistedOperationRecord>()
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
   * @param effect - Host effect executed only without a committed record.
   * @returns original or newly committed terminal result.
   */
  async execute(
    pairingId: PersonalPairingId,
    operation: CompanionOperation,
    effect: () => Promise<CompanionResult>,
  ): Promise<CompanionResult> {
    const key = recordKey(pairingId, operation.operationId)
    const fingerprint = operationFingerprint(operation)
    const existing = this.records.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error('Desktop Companion operation id collision')
      if (existing.result !== undefined) return structuredClone(existing.result)
    } else {
      if (this.records.size >= MAX_RECORDS) throw new Error('Desktop Companion operation ledger capacity exceeded')
      this.records.set(key, {
        pairingId, operationId: operation.operationId, fingerprint, updatedAt: this.now(),
      })
      await this.persist()
    }
    const result = await effect()
    const prepared = this.records.get(key)
    if (prepared === undefined || prepared.fingerprint !== fingerprint) {
      throw new Error('Desktop Companion operation transaction was replaced')
    }
    this.records.set(key, { ...prepared, updatedAt: this.now(), result: structuredClone(result) })
    await this.persist()
    return result
  }

  private async persist(): Promise<void> {
    const save = this.persistence.then(async () => {
      await this.store.save([...this.records.values()].map(cloneRecord))
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
  if (typeof value.pairingId !== 'string' || value.pairingId === ''
    || typeof value.operationId !== 'string' || value.operationId === ''
    || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(value.fingerprint)
    || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0) {
    throw new TypeError('Desktop Companion operation record is invalid')
  }
  if (value.result !== undefined && !isRecord(value.result)) {
    throw new TypeError('Desktop Companion operation result must be an object')
  }
  return {
    pairingId: value.pairingId as PersonalPairingId,
    operationId: value.operationId as CompanionOperationId,
    fingerprint: value.fingerprint,
    updatedAt: value.updatedAt as number,
    ...(value.result === undefined ? {} : { result: value.result as unknown as CompanionResult }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
