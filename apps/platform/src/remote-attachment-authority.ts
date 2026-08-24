/** Operated attachment request authority derived from Account and confirmed pairing state. */

import type { IncomingHttpHeaders } from 'node:http'
import type { PlatformAccount } from '@deepseek-ai/dsh-platform-account-core'
import {
  parsePersonalPairingId,
  type PersonalPairingProvider,
} from '@deepseek-ai/dsh-remote-access'
import type { RemoteAttachmentQuotaReservation } from '@deepseek-ai/dsh-remote-attachments'
import { pairingAuthenticationFromHeaders } from '@deepseek-ai/dsh-remote-access-http'
import { RemoteAttachmentHttpError, type RemoteAttachmentAuthority } from '@deepseek-ai/dsh-remote-attachments/http'
import type { PostgresPersonalPairingAuthorityStore } from './postgres-pairing-store.ts'

/** Installation proof plus durable pairing membership; a selector alone grants no attachment access. */
export class OperatedRemoteAttachmentAuthority implements RemoteAttachmentAuthority {
  /**
   * @param account - operated Platform Account verifier.
   * @param pairings - shared confirmed pairing authority.
   * @param remoteAccess - Account-complete blob quota owner.
   */
  constructor(
    private readonly account: Pick<PlatformAccount, 'currentInstallation'>,
    private readonly pairings: Pick<PostgresPersonalPairingAuthorityStore, 'ownsConfirmedPairing'>,
    private readonly remoteAccess: Pick<PersonalPairingProvider, 'admitAttachmentBlob' | 'releaseAttachmentBlob'>,
  ) {}

  async authenticate(input: { headers: IncomingHttpHeaders }): Promise<{
    pairingId: ReturnType<typeof parsePersonalPairingId>
    admit(bytes: number): Promise<RemoteAttachmentQuotaReservation>
  }> {
    const selector = singleHeader(input.headers, 'x-gestalt-pairing-selector')
    const pairingId = parsePersonalPairingId(selector)
    const owner = pairingAuthenticationFromHeaders(input)
    const authenticated = await this.account.currentInstallation(owner)
    if (!await this.pairings.ownsConfirmedPairing(
      authenticated.account.id,
      authenticated.installation.id,
      pairingId,
    )) {
      throw new RemoteAttachmentHttpError(403, 'ATTACHMENT_PAIRING_DENIED', 'Installation does not own this Personal Pairing')
    }
    return {
      pairingId,
      admit: async (bytes) => {
        const { reservationId, expiresAt } = await this.remoteAccess.admitAttachmentBlob({ owner, bytes })
        let released = false
        let releaseInFlight: Promise<void> | undefined
        return {
          id: reservationId,
          expiresAt,
          release: async () => {
            if (released) return
            if (releaseInFlight !== undefined) {
              await releaseInFlight
              return
            }
            releaseInFlight = this.remoteAccess.releaseAttachmentBlob({ owner, reservationId })
            try {
              await releaseInFlight
              released = true
            } finally {
              releaseInFlight = undefined
            }
          },
        }
      },
    }
  }
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  if (typeof value !== 'string' || value === '') {
    throw new RemoteAttachmentHttpError(400, 'ATTACHMENT_PAIRING_REQUIRED', `Missing ${name}`)
  }
  return value
}
