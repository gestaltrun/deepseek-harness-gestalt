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
    vault.retain(pairingId, state)
    vault.retainRelayAuthority(pairingId, grant)
    await vault.flush()

    const restored = new PairingCompanionKeyVault(store)
    await restored.selectAccount(accountId)
    expect(restored.pairingKeyMaterial(pairingId)).toEqual(state)
    expect(restored.relayAuthority()).toEqual(grant)
    await restored.selectAccount(parsePlatformAccountId('account-two'))
    expect(restored.pairingKeyMaterial(pairingId)).toBeUndefined()
    expect(restored.relayAuthority()).toBeUndefined()
  })

  it('retains a copy and zeroes released keys', () => {
    const vault = new PairingCompanionKeyVault()
    const pairing = parsePersonalPairingId('pairing-one')
    expect(() => { vault.retain(pairing, Uint8Array.of(1)) }).toThrow('256 bits')
    vault.retain(pairing, MATERIAL)
    const exported = vault.pairingKeyMaterial(pairing)
    expect(exported).toEqual(MATERIAL)
    expect(exported).not.toBe(MATERIAL)
    vault.retain(pairing, OTHER)
    expect(vault.pairingKeyMaterial(pairing)).toEqual(OTHER)
    vault.release(pairing)
    expect(vault.pairingKeyMaterial(pairing)).toBeUndefined()
    vault.release(pairing)
  })

  it('recovers its durable save queue after a failed confirmed-pairing write', async () => {
    const grant = {
      routeId: parseRelayRouteId('route-retry'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
    }
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('IndexedDB write failed'))
      .mockResolvedValueOnce(undefined)
    const store = { load: vi.fn(async () => ({ active: [] })), save } as unknown as IndexedDbMobilePairingStateStore
    const vault = new PairingCompanionKeyVault(store)
    const accountId = parsePlatformAccountId('account-retry')
    const pairingId = parsePersonalPairingId('pairing-retry')
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(pairingId, MATERIAL, grant)
    await expect(vault.flush()).rejects.toThrow('IndexedDB write failed')
    vault.retainConfirmedPairing(pairingId, MATERIAL, grant)
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
    expect(vault.pairingKeyMaterial(first)).toEqual(OTHER)
    vault.wipe()
    expect(vault.pairingKeyMaterial(first)).toBeUndefined()
  })
})
