import { describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { parseRelayCredential, parseRelayPairingSelector, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import {
  IndexedDbMobilePairingStateStore,
  MAX_RETAINED_PAIRING_KEYS,
  PairingCompanionKeyVault,
} from '../src/companion-keys.ts'

const MATERIAL = Uint8Array.from({ length: 32 }, (_, index) => index + 3)
const OTHER = Uint8Array.from({ length: 32 }, (_, index) => 200 - index)

describe('PairingCompanionKeyVault', () => {
  it('serializes concurrent Account loads so an older result cannot replace the active Account', async () => {
    const accountA = parsePlatformAccountId('account-concurrent-a')
    const accountB = parsePlatformAccountId('account-concurrent-b')
    const pairingA = parsePersonalPairingId('pairing-concurrent-a')
    const pairingB = parsePersonalPairingId('pairing-concurrent-b')
    let releaseA: (() => void) | undefined
    const blockedA = new Promise<void>((resolve) => { releaseA = resolve })
    const saves: Array<{ accountId: string; pairings: string[] }> = []
    const store = {
      load: vi.fn(async (accountId: string) => {
        if (accountId === accountA) await blockedA
        return { active: [{
          pairingId: accountId === accountA ? pairingA : pairingB,
          attachmentKey: (accountId === accountA ? MATERIAL : OTHER).slice(),
        }] }
      }),
      save: vi.fn(async (accountId: string, document: { active: Array<{ pairingId: string }> }) => {
        saves.push({ accountId, pairings: document.active.map(row => row.pairingId) })
      }),
    }
    const vault = new PairingCompanionKeyVault(store as never)
    const selectingA = vault.selectAccount(accountA)
    const selectingB = vault.selectAccount(accountB)
    releaseA?.()
    await Promise.all([selectingA, selectingB])

    expect(vault.attachmentKeyMaterial(pairingA)).toBeUndefined()
    expect(vault.attachmentKeyMaterial(pairingB)).toEqual(OTHER)
    vault.retain(pairingB, MATERIAL)
    await vault.flush()
    expect(saves).toEqual([{ accountId: accountB, pairings: [pairingB] }])
  })

  it('zeroes temporary loaded key and recovery buffers after copying them into the active Account', async () => {
    const accountId = parsePlatformAccountId('account-loaded-zeroed')
    const pairingId = parsePersonalPairingId('pairing-loaded-zeroed')
    const attachmentKey = MATERIAL.slice()
    const reconnectState = new Uint8Array(96).fill(7)
    const mobileHandshake = new Uint8Array(32).fill(8)
    const handshakeRecovery = new Uint8Array(32).fill(9)
    const store = {
      load: vi.fn(async () => ({
        active: [{ pairingId, attachmentKey, reconnectState }],
        pending: {
          link: 'https://example.test/pair', expiresAt: 100, accountId,
          completionId: 'completion-zero' as never, mobileHandshake, handshakeRecovery,
          transmission: 'prepared' as const, endpointChallengeId: 'challenge-zero' as never,
          endpointHandshakeFinished: false,
        },
      })),
      save: vi.fn(async () => {}),
    }
    const vault = new PairingCompanionKeyVault(store)
    await vault.selectAccount(accountId)

    expect(attachmentKey).toEqual(new Uint8Array(32))
    expect(reconnectState).toEqual(new Uint8Array(96))
    expect(mobileHandshake).toEqual(new Uint8Array(32))
    expect(handshakeRecovery).toEqual(new Uint8Array(32))
    expect(vault.attachmentKeyMaterial(pairingId)).toEqual(MATERIAL)
  })

  it('restores account-scoped Snow reconnect state and Mobile-only Relay authority', async () => {
    const store = new IndexedDbMobilePairingStateStore(`mobile-pairing-${crypto.randomUUID()}`)
    const accountId = parsePlatformAccountId('account-one')
    const pairingId = parsePersonalPairingId('pairing-persisted')
    const state = new Uint8Array(96).fill(6)
    const grant = {
      routeId: parseRelayRouteId('route-persisted'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 2,
      pairingSelector: parseRelayPairingSelector(pairingId),
    }
    const vault = new PairingCompanionKeyVault(store)
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(pairingId, state, MATERIAL, grant)
    await vault.flush()

    const restored = new PairingCompanionKeyVault(store)
    await restored.selectAccount(accountId)
    expect(restored.reconnectState(pairingId)).toEqual(state)
    expect(restored.attachmentKeyMaterial(pairingId)).toEqual(MATERIAL)
    expect(restored.relayAuthority()).toEqual(grant)
    await restored.selectAccount(parsePlatformAccountId('account-two'))
    expect(restored.attachmentKeyMaterial(pairingId)).toBeUndefined()
    expect(restored.reconnectState(pairingId)).toBeUndefined()
    expect(restored.relayAuthority()).toBeUndefined()
  })

  it('migrates an unversioned IndexedDB singleton grant and restores its derived selection after restart', async () => {
    const databaseName = `mobile-pairing-legacy-${crypto.randomUUID()}`
    const accountId = parsePlatformAccountId('account-indexeddb-legacy')
    const pairingId = parsePersonalPairingId('pairing-indexeddb-legacy')
    const reconnectState = new Uint8Array(96).fill(61)
    await writeIndexedDbPairingDocument(databaseName, accountId, {
      active: [{
        pairingId,
        attachmentKey: MATERIAL.slice(),
        reconnectState,
        grant: {
          routeId: 'route-indexeddb-legacy', endpoint: 'mobile',
          credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 5,
        },
      }],
    })
    const store = new IndexedDbMobilePairingStateStore(databaseName)

    const migrated = new PairingCompanionKeyVault(store)
    await migrated.selectAccount(accountId)
    expect(migrated.attachmentKeyMaterial(pairingId)).toEqual(MATERIAL)
    expect(migrated.reconnectState(pairingId)).toEqual(reconnectState)
    expect(migrated.selectedPairingId()).toBe(pairingId)
    expect(migrated.relayAuthority()).toEqual({
      routeId: parseRelayRouteId('route-indexeddb-legacy'), endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 5,
      pairingSelector: parseRelayPairingSelector(pairingId),
    })
    await expect(readIndexedDbPairingDocument(databaseName, accountId)).resolves.toMatchObject({
      version: 2,
      selectedPairingId: pairingId,
      active: [{ pairingId, grant: { pairingSelector: pairingId } }],
    })

    const restarted = new PairingCompanionKeyVault(new IndexedDbMobilePairingStateStore(databaseName))
    await restarted.selectAccount(accountId)
    expect(restarted.selectedPairingId()).toBe(pairingId)
    expect(restarted.relayAuthority()?.pairingSelector).toBe(parseRelayPairingSelector(pairingId))
  })

  it('migrates every unversioned IndexedDB pairing and selects the last complete authority after restart', async () => {
    const databaseName = `mobile-pairing-legacy-multiple-${crypto.randomUUID()}`
    const accountId = parsePlatformAccountId('account-indexeddb-legacy-multiple')
    const home = parsePersonalPairingId('pairing-indexeddb-a')
    const work = parsePersonalPairingId('pairing-indexeddb-b')
    const pending = parsePersonalPairingId('pairing-indexeddb-pending')
    const complete = (pairingId: string, attachmentKey: Uint8Array, fill: number): Record<string, unknown> => ({
      pairingId,
      attachmentKey,
      reconnectState: new Uint8Array(96).fill(fill),
      grant: {
        routeId: `route-${pairingId}`, endpoint: 'mobile',
        credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: fill,
      },
    })
    const legacy = {
      active: [
        complete(home, MATERIAL.slice(), 7),
        complete(work, OTHER.slice(), 8),
        { pairingId: pending, attachmentKey: new Uint8Array(32).fill(91) },
      ],
    }
    await writeIndexedDbPairingDocument(databaseName, accountId, legacy)
    const store = new IndexedDbMobilePairingStateStore(databaseName)

    const migrated = new PairingCompanionKeyVault(store)
    await migrated.selectAccount(accountId)
    expect(migrated.attachmentKeyMaterial(home)).toEqual(MATERIAL)
    expect(migrated.reconnectState(home)).toEqual(new Uint8Array(96).fill(7))
    expect(migrated.attachmentKeyMaterial(work)).toEqual(OTHER)
    expect(migrated.reconnectState(work)).toEqual(new Uint8Array(96).fill(8))
    expect(migrated.attachmentKeyMaterial(pending)).toEqual(new Uint8Array(32).fill(91))
    expect(migrated.selectedPairingId()).toBe(work)
    expect(migrated.relayAuthority()?.pairingSelector).toBe(parseRelayPairingSelector(work))
    await expect(readIndexedDbPairingDocument(databaseName, accountId)).resolves.toMatchObject({
      version: 2,
      selectedPairingId: work,
      active: [
        { pairingId: home, grant: { pairingSelector: home } },
        { pairingId: work, grant: { pairingSelector: work } },
        { pairingId: pending },
      ],
    })

    const restarted = new PairingCompanionKeyVault(new IndexedDbMobilePairingStateStore(databaseName))
    await restarted.selectAccount(accountId)
    expect(restarted.pairedDesktops()).toEqual([{ pairingId: home }, { pairingId: work }])
    expect(restarted.selectedPairingId()).toBe(work)
    expect(restarted.attachmentKeyMaterial(pending)).toEqual(new Uint8Array(32).fill(91))
    restarted.selectPairing(home)
    expect(restarted.relayAuthority()).toEqual({
      routeId: parseRelayRouteId(`route-${home}`), endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 7,
      pairingSelector: parseRelayPairingSelector(home),
    })
  })

  it('does not treat an explicit undefined IndexedDB version as the unversioned predecessor', async () => {
    const databaseName = `mobile-pairing-legacy-disguised-${crypto.randomUUID()}`
    const accountId = parsePlatformAccountId('account-indexeddb-legacy-disguised')
    const disguised = { version: undefined, active: [] }
    await writeIndexedDbPairingDocument(databaseName, accountId, disguised)
    const store = new IndexedDbMobilePairingStateStore(databaseName)

    await expect(store.load(accountId)).rejects.toThrow('version is unsupported')
    await expect(readIndexedDbPairingDocument(databaseName, accountId)).resolves.toEqual(disguised)
  })

  it('persists every Paired Desktop and restores only the explicit selection', async () => {
    const store = new IndexedDbMobilePairingStateStore(`mobile-pairing-selection-${crypto.randomUUID()}`)
    const accountId = parsePlatformAccountId('account-selection')
    const personal = parsePersonalPairingId('pairing-personal')
    const work = parsePersonalPairingId('pairing-work')
    const personalGrant = {
      routeId: parseRelayRouteId('route-personal'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(personal),
    }
    const workGrant = {
      routeId: parseRelayRouteId('route-work'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), revision: 2,
      pairingSelector: parseRelayPairingSelector(work),
    }
    const vault = new PairingCompanionKeyVault(store)
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(personal, new Uint8Array(96).fill(1), MATERIAL, personalGrant)
    vault.recordDesktopName(personal, 'Home Mac')
    vault.retainConfirmedPairing(work, new Uint8Array(96).fill(2), OTHER, workGrant)
    vault.recordDesktopName(work, 'Work Mac')
    vault.selectPairing(personal)
    await vault.flush()

    const restored = new PairingCompanionKeyVault(store)
    await restored.selectAccount(accountId)
    expect(restored.pairedDesktops()).toEqual([
      { pairingId: personal, desktopName: 'Home Mac' },
      { pairingId: work, desktopName: 'Work Mac' },
    ])
    expect(restored.selectedPairingId()).toBe(personal)
    expect(restored.relayAuthority()).toEqual(personalGrant)

    restored.selectPairing(work)
    restored.release(work)
    await restored.flush()
    expect(restored.pairedDesktops()).toEqual([{ pairingId: personal, desktopName: 'Home Mac' }])
    expect(restored.selectedPairingId()).toBeUndefined()
    expect(restored.attachmentKeyMaterial(personal)).toEqual(MATERIAL)
    expect(restored.attachmentKeyMaterial(work)).toBeUndefined()
  })

  it('rejects duplicate Personal Pairing ids in an IndexedDB version-2 document', async () => {
    const store = new IndexedDbMobilePairingStateStore(`mobile-pairing-duplicate-${crypto.randomUUID()}`)
    const accountId = parsePlatformAccountId('account-duplicate')
    const pairingId = parsePersonalPairingId('pairing-duplicate')
    await store.save(accountId, {
      active: [
        { pairingId, attachmentKey: MATERIAL.slice() },
        { pairingId, attachmentKey: OTHER.slice() },
      ],
    })

    await expect(store.load(accountId)).rejects.toThrow('duplicate Personal Pairing id')
  })

  it('retains a copy and zeroes released keys', () => {
    const vault = new PairingCompanionKeyVault()
    const pairing = parsePersonalPairingId('pairing-one')
    expect(() => { vault.retain(pairing, Uint8Array.of(1)) }).toThrow('256 bits')
    vault.retain(pairing, MATERIAL)
    const exported = vault.attachmentKeyMaterial(pairing)
    expect(exported).toEqual(MATERIAL)
    expect(exported).not.toBe(MATERIAL)
    vault.retain(pairing, OTHER)
    expect(vault.attachmentKeyMaterial(pairing)).toEqual(OTHER)
    vault.release(pairing)
    expect(vault.attachmentKeyMaterial(pairing)).toBeUndefined()
    vault.release(pairing)
  })

  it('recovers its durable save queue after a failed confirmed-pairing write', async () => {
    const pairingId = parsePersonalPairingId('pairing-retry')
    const grant = {
      routeId: parseRelayRouteId('route-retry'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(pairingId),
    }
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('IndexedDB write failed'))
      .mockResolvedValueOnce(undefined)
    const store = { load: vi.fn(async () => ({ active: [] })), save } as unknown as IndexedDbMobilePairingStateStore
    const vault = new PairingCompanionKeyVault(store)
    const accountId = parsePlatformAccountId('account-retry')
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(pairingId, new Uint8Array(96).fill(4), MATERIAL, grant)
    await expect(vault.flush()).rejects.toThrow('IndexedDB write failed')
    vault.retainConfirmedPairing(pairingId, new Uint8Array(96).fill(4), MATERIAL, grant)
    await expect(vault.flush()).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('enforces the retained pairing-key ceiling and wipes every key', () => {
    const vault = new PairingCompanionKeyVault()
    for (let index = 0; index < MAX_RETAINED_PAIRING_KEYS; index += 1) {
      vault.retain(parsePersonalPairingId(`pairing-${String(index)}`), MATERIAL)
    }
    expect(() => { vault.retain(parsePersonalPairingId('pairing-extra'), MATERIAL) })
      .toThrow('key limit reached')
    const first = parsePersonalPairingId('pairing-0')
    vault.retain(first, OTHER)
    expect(vault.attachmentKeyMaterial(first)).toEqual(OTHER)
    vault.wipe()
    expect(vault.attachmentKeyMaterial(first)).toBeUndefined()
  })
})

async function writeIndexedDbPairingDocument(
  databaseName: string,
  accountId: ReturnType<typeof parsePlatformAccountId>,
  document: unknown,
): Promise<void> {
  const database = await openPairingDatabase(databaseName)
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('pairings', 'readwrite')
    transaction.objectStore('pairings').put(document, accountId)
    transaction.oncomplete = () => { resolve() }
    transaction.onerror = () => { reject(transaction.error ?? new Error('legacy IndexedDB write failed')) }
  })
  database.close()
}

async function readIndexedDbPairingDocument(
  databaseName: string,
  accountId: ReturnType<typeof parsePlatformAccountId>,
): Promise<unknown> {
  const database = await openPairingDatabase(databaseName)
  const document = await new Promise<unknown>((resolve, reject) => {
    const request = database.transaction('pairings', 'readonly').objectStore('pairings').get(accountId)
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('legacy IndexedDB read failed')) }
  })
  database.close()
  return document
}

async function openPairingDatabase(databaseName: string): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('pairings') }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('legacy IndexedDB open failed')) }
  })
}
