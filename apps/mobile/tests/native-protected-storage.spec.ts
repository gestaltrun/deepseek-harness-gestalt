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

  it('migrates a native version-1 singleton grant and restores its derived selection after restart', async () => {
    const storage = new MemoryProtectedStorage()
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    const accountId = parsePlatformAccountId('account-native-v1')
    const pairingId = parsePersonalPairingId('pairing-native-v1')
    const attachmentKey = new Uint8Array(32).fill(41)
    const reconnectState = new Uint8Array(96).fill(42)
    storage.values.set('pairings:gestalt:account-native-v1', JSON.stringify({
      version: 1,
      active: [{
        pairingId,
        attachmentKey: bytesBase64(attachmentKey),
        reconnectState: bytesBase64(reconnectState),
        grant: {
          routeId: 'route-native-v1', endpoint: 'mobile',
          credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 3,
        },
      }],
    }))

    const migrated = new PairingCompanionKeyVault(store)
    await migrated.selectAccount(accountId)
    expect(migrated.attachmentKeyMaterial(pairingId)).toEqual(attachmentKey)
    expect(migrated.reconnectState(pairingId)).toEqual(reconnectState)
    expect(migrated.relayAuthority()).toEqual({
      routeId: parseRelayRouteId('route-native-v1'), endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 3,
      pairingSelector: parseRelayPairingSelector(pairingId),
    })
    expect(migrated.selectedPairingId()).toBe(pairingId)
    expect(JSON.parse(storage.values.get('pairings:gestalt:account-native-v1') ?? '{}')).toMatchObject({
      version: 2,
      selectedPairingId: pairingId,
      active: [{ pairingId, grant: { pairingSelector: pairingId } }],
    })

    const restarted = new PairingCompanionKeyVault(store)
    await restarted.selectAccount(accountId)
    expect(restarted.selectedPairingId()).toBe(pairingId)
    expect(restarted.relayAuthority()?.pairingSelector).toBe(parseRelayPairingSelector(pairingId))
  })

  it('migrates every native version-1 pairing and selects the last complete authority after restart', async () => {
    const storage = new MemoryProtectedStorage()
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    const complete = (pairingId: string, fill: number): Record<string, unknown> => ({
      pairingId,
      attachmentKey: bytesBase64(new Uint8Array(32).fill(fill)),
      reconnectState: bytesBase64(new Uint8Array(96).fill(fill + 1)),
      grant: {
        routeId: `route-${pairingId}`, endpoint: 'mobile',
        credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 1,
      },
    })
    const home = parsePersonalPairingId('pairing-native-a')
    const work = parsePersonalPairingId('pairing-native-b')
    const pending = parsePersonalPairingId('pairing-native-pending')
    storage.values.set('pairings:gestalt:account-native-multiple', JSON.stringify({
      version: 1,
      active: [
        complete(home, 51),
        complete(work, 61),
        { pairingId: pending, attachmentKey: bytesBase64(new Uint8Array(32).fill(71)) },
      ],
    }))
    const accountId = parsePlatformAccountId('account-native-multiple')

    const migrated = new PairingCompanionKeyVault(store)
    await migrated.selectAccount(accountId)
    expect(migrated.attachmentKeyMaterial(home)).toEqual(new Uint8Array(32).fill(51))
    expect(migrated.reconnectState(home)).toEqual(new Uint8Array(96).fill(52))
    expect(migrated.attachmentKeyMaterial(work)).toEqual(new Uint8Array(32).fill(61))
    expect(migrated.reconnectState(work)).toEqual(new Uint8Array(96).fill(62))
    expect(migrated.attachmentKeyMaterial(pending)).toEqual(new Uint8Array(32).fill(71))
    expect(migrated.selectedPairingId()).toBe(work)
    expect(migrated.relayAuthority()?.pairingSelector).toBe(parseRelayPairingSelector(work))
    expect(JSON.parse(storage.values.get('pairings:gestalt:account-native-multiple') ?? '{}')).toMatchObject({
      version: 2,
      selectedPairingId: work,
      active: [
        { pairingId: home, grant: { pairingSelector: home } },
        { pairingId: work, grant: { pairingSelector: work } },
        { pairingId: pending },
      ],
    })

    const restarted = new PairingCompanionKeyVault(store)
    await restarted.selectAccount(accountId)
    expect(restarted.pairedDesktops()).toEqual([{ pairingId: home }, { pairingId: work }])
    expect(restarted.selectedPairingId()).toBe(work)
    expect(restarted.attachmentKeyMaterial(pending)).toEqual(new Uint8Array(32).fill(71))
    restarted.selectPairing(home)
    expect(restarted.relayAuthority()).toEqual({
      routeId: parseRelayRouteId(`route-${home}`), endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(home),
    })
  })

  it('rejects a selector-conflicting native version-1 document without rewriting it', async () => {
    const storage = new MemoryProtectedStorage()
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    const complete = (pairingId: string, pairingSelector: string): Record<string, unknown> => ({
      pairingId,
      attachmentKey: bytesBase64(new Uint8Array(32).fill(51)),
      reconnectState: bytesBase64(new Uint8Array(96).fill(52)),
      grant: {
        routeId: `route-${pairingId}`, endpoint: 'mobile',
        credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 1,
        pairingSelector,
      },
    })

    const conflicting = JSON.stringify({
      version: 1,
      active: [complete('pairing-native-selected', 'pairing-native-other')],
    })
    storage.values.set('pairings:gestalt:account-native-conflicting', conflicting)
    await expect(store.load(parsePlatformAccountId('account-native-conflicting')))
      .rejects.toThrow('must select its retained Personal Pairing')
    expect(storage.values.get('pairings:gestalt:account-native-conflicting')).toBe(conflicting)
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
    storage.values.set('pairings:gestalt:account-version', '{"version":3,"active":[]}')
    const store = new NativeMobilePairingStateStore(storage, 'gestalt')
    await expect(store.load(parsePlatformAccountId('account-version'))).rejects.toThrow(/version is unsupported/)
  })
})

function bytesBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
