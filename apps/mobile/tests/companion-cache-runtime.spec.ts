import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parseCompanionOperationId } from '@deepseek-ai/dsh-remote-protocol'
import { MobileCompanionProjectionCacheRuntime } from '../src/companion-cache-runtime.ts'
import { companionCacheDatabaseName } from '../src/companion-cache.ts'
import { PairingCompanionKeyVault } from '../src/companion-keys.ts'
import type { MobileCompanionProjectionDto } from '../src/companion-projection.ts'

describe('Mobile Companion projection cache runtime', () => {
  it('restores an authenticated projection after an application upgrade and clears it independently', async () => {
    const pairingId = parsePersonalPairingId(`pairing-cache-${crypto.randomUUID()}`)
    const accountId = parsePlatformAccountId(`account-cache-${crypto.randomUUID()}`)
    const keys = new PairingCompanionKeyVault()
    keys.retain(pairingId, new Uint8Array(32).fill(41))
    const projection = emptyProjection('Cached Desktop')
    const first = new MobileCompanionProjectionCacheRuntime({
      environment: 'production', accountId, pairingId, keys,
    })
    await first.save(projection)

    const afterUpgrade = new MobileCompanionProjectionCacheRuntime({
      environment: 'production', accountId, pairingId, keys,
    })
    await expect(afterUpgrade.restore()).resolves.toEqual(projection)
    await afterUpgrade.clearContent()
    await expect(afterUpgrade.restore()).resolves.toBeUndefined()
    expect(keys.attachmentKeyMaterial(pairingId)).toEqual(new Uint8Array(32).fill(41))
  })

  it('commits one versioned projection snapshot and serializes clear after an admitted save', async () => {
    const pairingId = parsePersonalPairingId(`pairing-cache-${crypto.randomUUID()}`)
    const accountId = parsePlatformAccountId(`account-cache-${crypto.randomUUID()}`)
    const keys = new PairingCompanionKeyVault()
    keys.retain(pairingId, new Uint8Array(32).fill(42))
    const cache = new MobileCompanionProjectionCacheRuntime({
      environment: 'production', accountId, pairingId, keys,
    })

    const save = cache.save(emptyProjection('Race Desktop'))
    const clear = cache.clearContent()
    await Promise.all([save, clear])

    await expect(cache.restore()).resolves.toBeUndefined()
    await expect(contentKeys(companionCacheDatabaseName('production', accountId))).resolves.toEqual([])
  })

  it('retains an unknown operation receipt when presentation content is cleared', async () => {
    const pairingId = parsePersonalPairingId(`pairing-receipt-${crypto.randomUUID()}`)
    const accountId = parsePlatformAccountId(`account-receipt-${crypto.randomUUID()}`)
    const keys = new PairingCompanionKeyVault()
    keys.retain(pairingId, new Uint8Array(32).fill(43))
    const cache = new MobileCompanionProjectionCacheRuntime({
      environment: 'production', accountId, pairingId, keys,
    })
    const operationId = parseCompanionOperationId('operation-clear-content')
    await cache.operationSettlement.transmit(
      { kind: 'prompt', operationId },
      {
        async send(_mutation, beforeSend) {
          await beforeSend()
          return { known: false }
        },
        async queryStatus() { return { committed: false } },
      },
      { foreground: true, socketOpen: true, synchronized: true },
    )

    await cache.clearContent()
    const queryStatus = vi.fn(async () => ({ committed: false as const }))
    await expect(cache.operationSettlement.reconcileUnknown({
      send: () => Promise.reject(new Error('reconciliation must not replay')),
      queryStatus,
    })).resolves.toEqual([expect.objectContaining({ operationId, status: 'not-submitted' })])
    expect(queryStatus).toHaveBeenCalledExactlyOnceWith(operationId)
  })
})

async function contentKeys(databaseName: string): Promise<IDBValidKey[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('Companion Cache database open failed')) }
  })
  return await new Promise((resolve, reject) => {
    const request = database.transaction('content', 'readonly').objectStore('content').getAllKeys()
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('Companion Cache key read failed')) }
  })
}

function emptyProjection(desktopName: string): MobileCompanionProjectionDto {
  return {
    type: 'desktop-resync', version: 1, authenticated: true, desktopName,
    sessions: {
      ids: [], byId: {}, current: null, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: null,
    },
    workspaces: [],
    conversations: [],
  }
}
