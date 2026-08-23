/** Desktop Host retention of keyless Personal Pairing key material. */

import type { PendingPairingId, PersonalPairingId } from '@deepseek-ai/dsh-remote-access'

/** Maximum Personal Pairings whose key material one Desktop installation retains. */
export const MAX_RETAINED_DESKTOP_PAIRING_KEYS = 16

/** Read seam for independent pairing key material retained on this Desktop installation. */
interface DesktopPairingKeyAccess {
  /**
   * Read the independent key material of one confirmed Personal Pairing.
   * @param pairingId - confirmed Personal Pairing identity.
   * @returns copy of at least 32 bytes, or undefined when the pairing holds no retained key.
   */
  attachmentKeyMaterial(pairingId: PersonalPairingId): Uint8Array | undefined
}

/**
 * Keyless-proof key vault wired only by the explicit development composition.
 * Pending material arrives through the keyless `desktopHandshake` convention; a production
 * composition must omit this vault so no Noise message bytes are mistaken for key material.
 */
export class DesktopPairingKeyVault implements DesktopPairingKeyAccess {
  private readonly pending = new Map<PendingPairingId, Uint8Array>()
  private readonly active = new Map<PersonalPairingId, Uint8Array>()

  /**
   * Retain pending key material carried by one keyless completion view.
   * @param pendingPairingId - pending handshake awaiting Desktop confirmation.
   * @param material - at least 32 bytes of pairing key material; stored as a copy.
   */
  capturePending(pendingPairingId: PendingPairingId, material: Uint8Array): void {
    assertMaterial(material)
    this.dropPending(pendingPairingId)
    this.pending.set(pendingPairingId, material.slice())
  }

  /**
   * Move retained pending material under its confirmed Personal Pairing.
   * @param pendingPairingId - confirmed pending handshake.
   * @param pairingId - confirmed Personal Pairing identity.
   */
  activate(pendingPairingId: PendingPairingId, pairingId: PersonalPairingId): void {
    const material = this.pending.get(pendingPairingId)
    if (material === undefined) throw new Error('Desktop Pairing confirmation has no retained pending key')
    if (!this.active.has(pairingId) && this.active.size >= MAX_RETAINED_DESKTOP_PAIRING_KEYS) {
      throw new Error('Desktop retained Personal Pairing key limit reached')
    }
    this.pending.delete(pendingPairingId)
    this.release(pairingId)
    this.active.set(pairingId, material)
  }

  /** @param pendingPairingId - pending handshake whose material is zeroed and dropped. */
  dropPending(pendingPairingId: PendingPairingId): void {
    const material = this.pending.get(pendingPairingId)
    if (material === undefined) return
    material.fill(0)
    this.pending.delete(pendingPairingId)
  }

  /** @param keep - pending identities still owned by the Platform; every other pending key is dropped. */
  prunePending(keep: ReadonlySet<string>): void {
    for (const pendingPairingId of [...this.pending.keys()]) {
      if (!keep.has(pendingPairingId)) this.dropPending(pendingPairingId)
    }
  }

  /** @param pairingId - confirmed Personal Pairing whose material is zeroed and dropped. */
  release(pairingId: PersonalPairingId): void {
    const material = this.active.get(pairingId)
    if (material === undefined) return
    material.fill(0)
    this.active.delete(pairingId)
  }

  /** Zero every retained key, leaving the vault empty. */
  clear(): void {
    for (const material of this.pending.values()) material.fill(0)
    for (const material of this.active.values()) material.fill(0)
    this.pending.clear()
    this.active.clear()
  }

  /** @param pairingId - confirmed Personal Pairing identity. @returns copy of the retained key material. */
  attachmentKeyMaterial(pairingId: PersonalPairingId): Uint8Array | undefined {
    return this.active.get(pairingId)?.slice()
  }
}

function assertMaterial(material: Uint8Array): void {
  if (material.byteLength < 32) throw new TypeError('Personal Pairing key material must contain at least 256 bits')
}
