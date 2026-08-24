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

  it('round-trips pairing, reconnect, attachment, and Relay authority without Web storage', async () => {
    const storage = new MemoryProtectedStorage()
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    const accountId = parsePlatformAccountId('account-native')
    const pairingId = parsePersonalPairingId('pairing-native')
    const reconnect = new Uint8Array(96).fill(17)
    const attachment = new Uint8Array(32).fill(29)
    const grant = {
      routeId: parseRelayRouteId('route-native'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 3,
      pairingSelector: parseRelayPairingSelector(pairingId),
    }
    const vault = new PairingCompanionKeyVault(store)
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(pairingId, reconnect, attachment, grant)
    vault.recordDesktopName(pairingId, 'Native Desktop')
    await vault.flush()

    const retainedJson = [...storage.values.values()][0]
    expect(retainedJson).not.toContain(String.fromCharCode(...attachment))
    const restored = new PairingCompanionKeyVault(store)
    await restored.selectAccount(accountId)
    expect(restored.reconnectState(pairingId)).toEqual(reconnect)
    expect(restored.attachmentKeyMaterial(pairingId)).toEqual(attachment)
    expect(restored.relayAuthority()).toEqual(grant)
    expect(restored.pairedDesktops()).toEqual([{ pairingId, desktopName: 'Native Desktop' }])
    expect(restored.selectedPairingId()).toBe(pairingId)
  })

  it('rejects damaged protected documents instead of silently re-pairing', async () => {
    const storage = new MemoryProtectedStorage()
    storage.values.set('pairings:gestalt:account-damaged', '{"version":2,"active":[{"pairingId":"pairing","attachmentKey":"***"}]}')
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    await expect(store.load(parsePlatformAccountId('account-damaged'))).rejects.toThrow(/base64/)
  })

  it('rejects a protected pairing document from an unsupported format version', async () => {
    const storage = new MemoryProtectedStorage()
    storage.values.set('pairings:gestalt:account-version', '{"version":1,"active":[]}')
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    await expect(store.load(parsePlatformAccountId('account-version'))).rejects.toThrow(/version is unsupported/)
  })
})
