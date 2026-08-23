import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parseCompanionOperationId, parseCompanionSessionId } from '@deepseek-ai/dsh-remote-protocol'
import {
  DesktopCompanionOperationLedger,
  FileDesktopCompanionOperationStore,
} from '../src/companion-operation-ledger.ts'

type LedgerStore = Parameters<typeof DesktopCompanionOperationLedger.load>[0]

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('Desktop Companion operation ledger', () => {
  it('returns one durable result for retry and rejects operation-id collisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-companion-ledger-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const store = new FileDesktopCompanionOperationStore(join(root, 'operations.json'))
    const ledger = await DesktopCompanionOperationLedger.load(store, () => 1_000)
    const operation = {
      type: 'submit-prompt' as const,
      operationId: parseCompanionOperationId('operation-ledger'),
      sessionId: parseCompanionSessionId('session-ledger'),
      text: 'one prompt',
    }
    const execute = vi.fn(async () => ({
      type: 'confirmed' as const, operationId: operation.operationId,
      committedAt: 1_000, outcome: 'accepted' as const,
    }))
    const pairingId = parsePersonalPairingId('pairing-ledger')
    await expect(ledger.execute(pairingId, operation, execute)).resolves.toMatchObject({ type: 'confirmed' })

    const restored = await DesktopCompanionOperationLedger.load(store, () => 2_000)
    await expect(restored.execute(pairingId, operation, execute)).resolves.toMatchObject({ type: 'confirmed' })
    expect(execute).toHaveBeenCalledOnce()
    await expect(restored.execute(pairingId, { ...operation, text: 'different prompt' }, execute))
      .rejects.toThrow('operation id collision')
  })

  it('keeps prepared work retryable after a failed effect without publishing a result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-companion-ledger-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const store = new FileDesktopCompanionOperationStore(join(root, 'operations.json'))
    const operation = {
      type: 'cancel-session' as const,
      operationId: parseCompanionOperationId('operation-prepared'),
      sessionId: parseCompanionSessionId('session-ledger'),
    }
    const pairingId = parsePersonalPairingId('pairing-ledger')
    const first = await DesktopCompanionOperationLedger.load(store, () => 1_000)
    await expect(first.execute(pairingId, operation, async () => { throw new Error('lost') })).rejects.toThrow('lost')

    const restored = await DesktopCompanionOperationLedger.load(store, () => 2_000)
    await expect(restored.execute(pairingId, operation, async () => ({
      type: 'confirmed', operationId: operation.operationId, committedAt: 2_000, outcome: 'accepted',
    }))).resolves.toMatchObject({ committedAt: 2_000 })
  })

  it('single-flights concurrent retries of the same operation', async () => {
    const store = memoryStore()
    const ledger = await DesktopCompanionOperationLedger.load(store, () => 1_000)
    const operation = cancelOperation('operation-concurrent')
    let releaseEffect: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { releaseEffect = resolve })
    const effect = vi.fn(async () => {
      await blocked
      return confirmed(operation, 1_000)
    })
    const pairingId = parsePersonalPairingId('pairing-ledger')

    const first = ledger.execute(pairingId, operation, effect)
    const second = ledger.execute(pairingId, operation, effect)
    await vi.waitFor(() => { expect(effect).toHaveBeenCalledOnce() })
    releaseEffect?.()
    await expect(Promise.all([first, second])).resolves.toEqual([
      confirmed(operation, 1_000), confirmed(operation, 1_000),
    ])
  })

  it('retries a failed durable commit without repeating the Host effect', async () => {
    let failCommit = true
    let persisted: Awaited<ReturnType<LedgerStore['load']>> = []
    const store: LedgerStore = {
      load: async () => persisted,
      save: async (records) => {
        if (failCommit && records.some(record => record.result !== undefined)) throw new Error('commit unavailable')
        persisted = structuredClone(records)
      },
    }
    const ledger = await DesktopCompanionOperationLedger.load(store, () => 1_000)
    const operation = cancelOperation('operation-commit-retry')
    const result = confirmed(operation, 1_000)
    const effect = vi.fn(async () => result)
    const pairingId = parsePersonalPairingId('pairing-ledger')

    await expect(ledger.execute(pairingId, operation, effect)).rejects.toThrow('commit unavailable')
    failCommit = false
    await expect(ledger.execute(pairingId, operation, effect)).resolves.toEqual(result)
    expect(effect).toHaveBeenCalledOnce()
    const restored = await DesktopCompanionOperationLedger.load(store, () => 2_000)
    await expect(restored.execute(pairingId, operation, effect)).resolves.toEqual(result)
    expect(effect).toHaveBeenCalledOnce()
  })

  it('isolates a failed preparation from a concurrent different operation', async () => {
    let persisted: Awaited<ReturnType<LedgerStore['load']>> = []
    let rejectFirstSave: ((error: Error) => void) | undefined
    const firstSave = new Promise<void>((_resolve, reject) => { rejectFirstSave = reject })
    let saveCount = 0
    const store: LedgerStore = {
      load: async () => structuredClone(persisted),
      save: async (records) => {
        saveCount += 1
        if (saveCount === 1) await firstSave
        persisted = structuredClone(records)
      },
    }
    const ledger = await DesktopCompanionOperationLedger.load(store, () => 1_000)
    const pairingId = parsePersonalPairingId('pairing-ledger')
    const operationA = cancelOperation('operation-interleaved-a')
    const operationB = cancelOperation('operation-interleaved-b')
    const effectA = vi.fn(async () => confirmed(operationA, 1_000))
    const effectB = vi.fn(async () => confirmed(operationB, 1_000))

    const resultA = ledger.execute(pairingId, operationA, effectA)
    await vi.waitFor(() => { expect(saveCount).toBe(1) })
    const resultB = ledger.execute(pairingId, operationB, effectB)
    rejectFirstSave?.(new Error('prepare unavailable'))

    await expect(resultA).rejects.toThrow('prepare unavailable')
    await expect(resultB).resolves.toEqual(confirmed(operationB, 1_000))
    expect(effectA).not.toHaveBeenCalled()
    expect(effectB).toHaveBeenCalledOnce()

    const restored = await DesktopCompanionOperationLedger.load(store, () => 2_000)
    await expect(restored.execute(pairingId, operationB, effectB)).resolves.toEqual(confirmed(operationB, 1_000))
    expect(effectB).toHaveBeenCalledOnce()
  })

  it('prunes expired records and evicts the oldest terminal result at capacity', async () => {
    const store = memoryStore()
    const pairingId = parsePersonalPairingId('pairing-ledger')
    const old = cancelOperation('operation-expired')
    const first = await DesktopCompanionOperationLedger.load(store, () => 0)
    await first.execute(pairingId, old, async () => confirmed(old, 0))

    const afterTtl = await DesktopCompanionOperationLedger.load(store, () => 366 * 24 * 60 * 60 * 1_000)
    const current = cancelOperation('operation-current')
    await afterTtl.execute(pairingId, current, async () => confirmed(current, 1))
    expect((await store.load()).map(record => record.operationId)).toEqual([current.operationId])

    for (let index = 0; index < 256; index += 1) {
      const operation = cancelOperation(`operation-capacity-${String(index)}`)
      await afterTtl.execute(pairingId, operation, async () => confirmed(operation, index + 2))
    }
    expect(await store.load()).toHaveLength(256)
    const retryCurrent = vi.fn(async () => confirmed(current, 999))
    await afterTtl.execute(pairingId, current, retryCurrent)
    expect(retryCurrent).toHaveBeenCalledOnce()
  })

  it.each([
    {
      pairingId: '', operationId: 'operation-valid', resultOperationId: 'operation-valid',
      expected: 'Personal Pairing id',
    },
    {
      pairingId: 'pairing-valid', operationId: 'bad operation', resultOperationId: 'bad operation',
      expected: 'operationId',
    },
    {
      pairingId: 'pairing-valid', operationId: 'operation-valid', resultOperationId: 'operation-other',
      expected: 'must match',
    },
  ])('rejects hostile durable identities and result correlation %#', async (fixture) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-companion-ledger-hostile-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const path = join(root, 'operations.json')
    await writeFile(path, JSON.stringify([{
      pairingId: fixture.pairingId,
      operationId: fixture.operationId,
      fingerprint: 'a'.repeat(64),
      updatedAt: 1,
      result: {
        type: 'confirmed', operationId: fixture.resultOperationId, committedAt: 1, outcome: 'accepted',
      },
    }]))
    await expect(DesktopCompanionOperationLedger.load(new FileDesktopCompanionOperationStore(path)))
      .rejects.toThrow(fixture.expected)
  })
})

function memoryStore(): LedgerStore {
  let persisted: Awaited<ReturnType<LedgerStore['load']>> = []
  return {
    load: async () => structuredClone(persisted),
    save: async (records) => { persisted = structuredClone(records) },
  }
}

function cancelOperation(id: string) {
  return {
    type: 'cancel-session' as const,
    operationId: parseCompanionOperationId(id),
    sessionId: parseCompanionSessionId('session-ledger'),
  }
}

function confirmed(operation: ReturnType<typeof cancelOperation>, committedAt: number) {
  return {
    type: 'confirmed' as const,
    operationId: operation.operationId,
    committedAt,
    outcome: 'accepted' as const,
  }
}
