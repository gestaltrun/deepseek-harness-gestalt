import { describe, expect, it } from 'vitest'
import { parsePendingPairingId, parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { DesktopPairingKeyVault, MAX_RETAINED_DESKTOP_PAIRING_KEYS } from '../src/pairing-keys.ts'

const MATERIAL = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const OTHER = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)

describe('DesktopPairingKeyVault', () => {
  it('activates pending keyless material under the confirmed pairing and copies on read', () => {
    const vault = new DesktopPairingKeyVault()
    const pending = parsePendingPairingId('pending-one')
    const pairing = parsePersonalPairingId('pairing-one')
    vault.capturePending(pending, MATERIAL)
    vault.activate(pending, pairing)
    const exported = vault.attachmentKeyMaterial(pairing)
    expect(exported).toEqual(MATERIAL)
    expect(exported).not.toBe(MATERIAL)
    if (exported === undefined) throw new Error('retained pairing key was missing')
    exported[0] = 0
    expect(vault.attachmentKeyMaterial(pairing)).toEqual(MATERIAL)
    vault.release(pairing)
    expect(vault.attachmentKeyMaterial(pairing)).toBeUndefined()
  })

  it('drops stale pending keys and rejects short material', () => {
    const vault = new DesktopPairingKeyVault()
    const pending = parsePendingPairingId('pending-drop')
    expect(() => { vault.capturePending(pending, Uint8Array.of(1)) }).toThrow('256 bits')
    vault.capturePending(pending, MATERIAL)
    vault.dropPending(pending)
    expect(() => { vault.activate(pending, parsePersonalPairingId('pairing-drop')) })
      .toThrow('no retained pending key')
    vault.capturePending(pending, MATERIAL)
    vault.capturePending(pending, OTHER)
    vault.prunePending(new Set())
    expect(() => { vault.activate(pending, parsePersonalPairingId('pairing-pruned')) })
      .toThrow('no retained pending key')
  })

  it('enforces the retained pairing-key ceiling and zeroes on clear', () => {
    const vault = new DesktopPairingKeyVault()
    for (let index = 0; index < MAX_RETAINED_DESKTOP_PAIRING_KEYS; index += 1) {
      const pending = parsePendingPairingId(`pending-${String(index)}`)
      vault.capturePending(pending, MATERIAL)
      vault.activate(pending, parsePersonalPairingId(`pairing-${String(index)}`))
    }
    const extra = parsePendingPairingId('pending-extra')
    vault.capturePending(extra, MATERIAL)
    expect(() => { vault.activate(extra, parsePersonalPairingId('pairing-extra')) })
      .toThrow('key limit reached')
    const first = parsePersonalPairingId('pairing-0')
    vault.capturePending(parsePendingPairingId('pending-replace'), OTHER)
    vault.activate(parsePendingPairingId('pending-replace'), first)
    expect(vault.attachmentKeyMaterial(first)).toEqual(OTHER)
    vault.clear()
    expect(vault.attachmentKeyMaterial(first)).toBeUndefined()
  })
})
