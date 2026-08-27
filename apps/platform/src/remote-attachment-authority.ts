/** Operated attachment request authority derived from Account and confirmed pairing state. */

import type { IncomingHttpHeaders } from 'node:http'
import type { PlatformAccount } from '@deepseek-ai/dsh-platform-account-core'
import {
  parsePersonalPairingId,
  type PersonalPairingAttachmentQuotaAuthority,
} from '@deepseek-ai/dsh-remote-access'
import type { RemoteAttachmentQuotaReservation } from '@deepseek-ai/dsh-remote-attachments'
import { pairingAuthenticationFromHeaders } from '@deepseek-ai/dsh-remote-access-http'
import {
  RemoteAttachmentHttpError,
  type RemoteAttachmentAuthenticator,
} from '@deepseek-ai/dsh-remote-attachments/http'
import type { PostgresPersonalPairingAuthorityStore } from './postgres-pairing-store.ts'

/**
 * Bind Installation proof and durable pairing membership to private attachment quota closures.
 * @param account - operated Platform Account verifier.
 * @param pairings - shared confirmed pairing authority.
 * @param quota - Account-authenticated quota authority from the Personal Pairing composition.
 * @returns request authenticator captured only by the attachment HTTP plugin.
 */
export function createOperatedRemoteAttachmentAuthenticator(
  account: Pick<PlatformAccount, 'currentInstallation'>,
  pairings: Pick<PostgresPersonalPairingAuthorityStore, 'ownsConfirmedPairing'>,
  quota: PersonalPairingAttachmentQuotaAuthority,
): RemoteAttachmentAuthenticator {
  return async (input: { headers: IncomingHttpHeaders }): Promise<{
    pairingId: ReturnType<typeof parsePersonalPairingId>
    admit(bytes: number): Promise<RemoteAttachmentQuotaReservation>
  }> => {
    const selector = singleHeader(input.headers, 'x-gestalt-pairing-selector')
    const pairingId = parsePersonalPairingId(selector)
    const owner = pairingAuthenticationFromHeaders(input)
    const authenticated = await account.currentInstallation(owner)
    if (!await pairings.ownsConfirmedPairing(
      authenticated.account.id,
      authenticated.installation.id,
      pairingId,
    )) {
      throw new RemoteAttachmentHttpError(403, 'ATTACHMENT_PAIRING_DENIED', 'Installation does not own this Personal Pairing')
    }
    return {
      pairingId,
      admit: async (bytes) => {
        const accountId = authenticated.account.id
        const { reservationId, expiresAt } = await quota.admit({
          accountId, bytes,
        })
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
            releaseInFlight = quota.release({ accountId, reservationId })
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
