import { describe, expect, it, vi } from 'vitest'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { parseRelayCredential, parseRelayPairingSelector, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { NativeMobilePairingStateStore, PairingCompanionKeyVault } from '../src/companion-keys.ts'
import { loadProtectedInstallationId, type MobileProtectedStorage } from '../src/native-protected-storage.ts'

class MemoryProtectedStorage implements MobileProtectedStorage {
  readonly values = new Map<string, string>()
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async remove(key: string): Promise<void> { this.values.delete(key) }
}

describe('native Mobile protected storage', () => {
  it('preserves the Installation id across an application upgrade', async () => {
    const storage = new MemoryProtectedStorage()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '12345678-1234-4234-8234-123456789abc') })
    const first = await loadProtectedInstallationId(storage, 'production')
    const second = await loadProtectedInstallationId(storage, 'production')
    expect(first).toBe('12345678-1234-4234-8234-123456789abc')
    expect(second).toBe(first)
    expect(storage.values.size).toBe(1)
    vi.unstubAllGlobals()
  })

  it('round-trips two pairings and releases only the explicit native selection', async () => {
    const storage = new MemoryProtectedStorage()
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    const accountId = parsePlatformAccountId('account-native')
    const home = parsePersonalPairingId('pairing-native-home')
    const work = parsePersonalPairingId('pairing-native-work')
    const homeReconnect = new Uint8Array(96).fill(17)
    const workReconnect = new Uint8Array(96).fill(18)
    const homeAttachment = new Uint8Array(32).fill(29)
    const workAttachment = new Uint8Array(32).fill(30)
    const homeGrant = {
      routeId: parseRelayRouteId('route-native-home'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 3,
      pairingSelector: parseRelayPairingSelector(home),
    }
    const workGrant = {
      routeId: parseRelayRouteId('route-native-work'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), revision: 4,
      pairingSelector: parseRelayPairingSelector(work),
    }
    const vault = new PairingCompanionKeyVault(store)
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(home, homeReconnect, homeAttachment, homeGrant)
    vault.recordDesktopName(home, 'Home Desktop')
    vault.retainConfirmedPairing(work, workReconnect, workAttachment, workGrant)
    vault.recordDesktopName(work, 'Work Desktop')
    vault.selectPairing(home)
    await vault.flush()

    const retainedJson = [...storage.values.values()][0]
    expect(retainedJson).not.toContain(String.fromCharCode(...homeAttachment))
    expect(retainedJson).not.toContain(String.fromCharCode(...workAttachment))
    const restored = new PairingCompanionKeyVault(store)
    await restored.selectAccount(accountId)
    expect(restored.reconnectState(home)).toEqual(homeReconnect)
    expect(restored.reconnectState(work)).toEqual(workReconnect)
    expect(restored.relayAuthority()).toEqual(homeGrant)
    expect(restored.pairedDesktops()).toEqual([
      { pairingId: home, desktopName: 'Home Desktop' },
      { pairingId: work, desktopName: 'Work Desktop' },
    ])
    expect(restored.selectedPairingId()).toBe(home)

    restored.release(home)
    await restored.flush()
    const afterRelease = new PairingCompanionKeyVault(store)
    await afterRelease.selectAccount(accountId)
    expect(afterRelease.pairedDesktops()).toEqual([{ pairingId: work, desktopName: 'Work Desktop' }])
    expect(afterRelease.selectedPairingId()).toBeUndefined()
    expect(afterRelease.attachmentKeyMaterial(home)).toBeUndefined()
    expect(afterRelease.attachmentKeyMaterial(work)).toEqual(workAttachment)
  })

  it('rejects damaged protected documents instead of silently re-pairing', async () => {
    const storage = new MemoryProtectedStorage()
    storage.values.set('pairings:gestalt:account-damaged', '{"version":2,"active":[{"pairingId":"pairing","attachmentKey":"***"}]}')
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    await expect(store.load(parsePlatformAccountId('account-damaged'))).rejects.toThrow(/base64/)
  })

  it('rejects duplicate Personal Pairing ids in a native version-2 document', async () => {
    const storage = new MemoryProtectedStorage()
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    const accountId = parsePlatformAccountId('account-native-duplicate')
    const pairingId = parsePersonalPairingId('pairing-native-duplicate')
    await store.save(accountId, {
      active: [
        { pairingId, attachmentKey: new Uint8Array(32).fill(1) },
        { pairingId, attachmentKey: new Uint8Array(32).fill(2) },
      ],
    })

    await expect(store.load(accountId)).rejects.toThrow('duplicate Personal Pairing id')
  })

  it('rejects a protected pairing document from an unsupported format version', async () => {
    const storage = new MemoryProtectedStorage()
    storage.values.set('pairings:gestalt:account-version', '{"version":1,"active":[]}')
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    await expect(store.load(parsePlatformAccountId('account-version'))).rejects.toThrow(/version is unsupported/)
  })
})
