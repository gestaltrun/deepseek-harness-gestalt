import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parseCompanionOperationId, parseCompanionSessionId } from '@deepseek-ai/dsh-remote-protocol'
import {
  DesktopCompanionOperationLedger,
  FileDesktopCompanionOperationStore,
} from '../src/companion-operation-ledger.ts'

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
})
