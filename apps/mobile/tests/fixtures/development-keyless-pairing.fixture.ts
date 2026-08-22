/** Keyless Mobile handshake fixture for controller-flow tests only. */

import {
  deriveKeylessMobileHandshake,
  deriveKeylessPairingKey,
  parsePairingCompletionId,
  parsePairingInvitationLink,
  type PairingCompletionId,
  type RelayCredentialGrant,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import type { MobilePairingHandshakeClient } from '../../src/personal-pairing.ts'

/** Deterministic insecure handshake fixture unreachable from the Mobile product entry. */
export class KeylessMobileHandshakeFixture implements MobilePairingHandshakeClient {
  private invitationSecret: Uint8Array | undefined
  private pairingKey: Uint8Array | undefined

  async begin(oneTimeLink: string): Promise<{ completionId: PairingCompletionId; mobileHandshake: Uint8Array }> {
    this.clearMaterial()
    const invitation = parsePairingInvitationLink(oneTimeLink)
    try {
      this.invitationSecret = invitation.invitationSecret.slice()
      return {
        completionId: parsePairingCompletionId(`fixture-${crypto.randomUUID()}`),
        mobileHandshake: await deriveKeylessMobileHandshake(invitation.invitationSecret),
      }
    } finally {
      invitation.invitationSecret.fill(0)
    }
  }

  async acceptDesktopHandshake(desktopHandshake: Uint8Array): Promise<void> {
    const secret = this.invitationSecret
    if (secret === undefined) throw new Error('Keyless Mobile Pairing fixture has no prepared invitation')
    const expected = await deriveKeylessPairingKey(secret)
    if (!bytesEqualConstantTime(desktopHandshake, expected)) {
      throw new TypeError('Keyless Desktop handshake does not match the invitation pairing key')
    }
    this.pairingKey = desktopHandshake.slice()
    secret.fill(0)
    this.invitationSecret = undefined
  }

  /** @returns copy of the retained 256-bit pairing key, or undefined before activation. */
  exportPairingKeyMaterial(): Uint8Array | undefined {
    return this.pairingKey?.slice()
  }

  wipe(): void {
    this.clearMaterial()
  }

  openRelayAuthority(sealedAuthority: Uint8Array): Promise<RelayCredentialGrant> {
    return Promise.resolve().then(() => {
      const value = JSON.parse(new TextDecoder().decode(sealedAuthority)) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Fixture Relay authority must be an object')
      }
      const record = value as Record<string, unknown>
      if (record.endpoint !== 'mobile') {
        throw new TypeError('Fixture Relay authority endpoint must be mobile')
      }
      if (!Number.isSafeInteger(record.revision) || (record.revision as number) <= 0) {
        throw new TypeError('Fixture Relay authority revision must be positive')
      }
      return {
        endpoint: 'mobile',
        routeId: parseRelayRouteId(record.routeId),
        credential: parseRelayCredential(record.credential),
        revision: record.revision as number,
      }
    })
  }

  private clearMaterial(): void {
    this.invitationSecret?.fill(0)
    this.invitationSecret = undefined
    this.pairingKey?.fill(0)
    this.pairingKey = undefined
  }
}

function bytesEqualConstantTime(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number)
  }
  return difference === 0
}
