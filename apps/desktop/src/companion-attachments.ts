/** Desktop receive path for one end-to-end encrypted Companion attachment. */

import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  deriveCompanionAttachmentKey,
  hashCompanionCiphertext,
  openCompanionAttachment,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionAttachmentRejectionReason,
  type CompanionOfferAttachmentOperation,
} from '@deepseek-ai/dsh-remote-protocol'

const HTTP_REJECTION: Record<number, CompanionAttachmentRejectionReason> = {
  403: 'cross-pairing',
  404: 'absent',
  410: 'expired',
  413: 'limit-exceeded',
}

/** Explicit Desktop-side rejection; the reason returns to Mobile in the bounded result. */
export class CompanionAttachmentReceiveError extends Error {
  /** @param reason - protocol-native rejection reason. */
  constructor(readonly reason: CompanionAttachmentRejectionReason, message: string) {
    super(message)
    this.name = 'CompanionAttachmentReceiveError'
  }
}

/** One accepted attachment submitted into the existing Session path. */
export interface ReceivedCompanionAttachment {
  fileName: string
  byteLength: number
}

/**
 * Map one Platform consume HTTP status onto a protocol-native rejection reason.
 * @param status - HTTP status from the blob-store consume response.
 * @returns the matching reason, or `undefined` when the status is not a mapped store failure.
 */
export function companionAttachmentReasonFromHttpStatus(status: number): CompanionAttachmentRejectionReason | undefined {
  return HTTP_REJECTION[status]
}

/**
 * Download one offered ciphertext from the Platform blob store over HTTPS.
 *
 * Maps 403 to `cross-pairing`, 404 to `absent`, 410 to `expired`, and 413 to `limit-exceeded`.
 * Other HTTP statuses and transport failures become `transfer-interrupted`.
 * Product Session submit wiring remains the `submit` callback on {@link receiveCompanionAttachment}.
 * @param offer - decoded Companion control message from Mobile.
 * @param input - consume origin, pairing selector, and current-Installation authorization headers.
 * @returns the downloaded ciphertext bytes.
 */
export async function downloadCompanionAttachment(
  offer: CompanionOfferAttachmentOperation,
  input: {
    pairingId: PersonalPairingId
    origin: string
    fetch?: (url: string, init?: RequestInit) => Promise<Response>
    headers?: Record<string, string>
  },
): Promise<Uint8Array> {
  const fetchImpl = input.fetch ?? fetch
  const headers = new Headers(input.headers)
  headers.set('content-type', 'application/json')
  headers.set('x-gestalt-pairing-selector', input.pairingId)
  let response: Response
  try {
    response = await fetchImpl(`${input.origin}/v1/remote-attachments/consume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ capability: offer.capability }),
    })
  } catch (error) {
    if (error instanceof CompanionAttachmentReceiveError) throw error
    throw new CompanionAttachmentReceiveError('transfer-interrupted', 'Companion attachment transfer was interrupted')
  }
  if (response.status === 200) return new Uint8Array(await response.arrayBuffer())
  const reason = companionAttachmentReasonFromHttpStatus(response.status)
  if (reason !== undefined) {
    throw new CompanionAttachmentReceiveError(reason, `Companion attachment consume failed with HTTP ${String(response.status)}`)
  }
  throw new CompanionAttachmentReceiveError('transfer-interrupted', 'Companion attachment transfer was interrupted')
}

/**
 * Verify, decrypt, and submit one offered attachment into the existing Session path.
 *
 * Verifies the offered ciphertext hash and byte count before any decryption;
 * a hash mismatch never reaches the decryption key. A post-hash AES-GCM failure
 * reuses `hash-mismatch` as the authentication-failure reason.
 * @param offer - decoded Companion control message from Mobile.
 * @param input - pairing scope, attachment key, blob download, clock, and Session submit.
 * @returns the submitted attachment values.
 */
export async function receiveCompanionAttachment(
  offer: CompanionOfferAttachmentOperation,
  input: {
    pairingId: PersonalPairingId
    attachmentKey: Uint8Array
    now: number
    download: (offer: CompanionOfferAttachmentOperation, pairingId: PersonalPairingId) => Promise<Uint8Array>
    submit: (attachment: { fileName: string; plaintext: Uint8Array }) => Promise<void> | void
  },
): Promise<ReceivedCompanionAttachment> {
  if (input.now >= offer.expiresAt) {
    throw new CompanionAttachmentReceiveError('expired', 'Companion attachment capability has expired')
  }
  if (offer.byteLength > REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes) {
    throw new CompanionAttachmentReceiveError('limit-exceeded', 'Companion attachment exceeds its blob byte ceiling')
  }
  let ciphertext: Uint8Array
  try {
    ciphertext = await input.download(offer, input.pairingId)
  } catch (error) {
    if (error instanceof CompanionAttachmentReceiveError) throw error
    throw new CompanionAttachmentReceiveError('transfer-interrupted', 'Companion attachment transfer was interrupted')
  }
  if (ciphertext.byteLength !== offer.byteLength) {
    throw new CompanionAttachmentReceiveError('hash-mismatch', 'Companion attachment byte count does not match the offer')
  }
  if (await hashCompanionCiphertext(ciphertext) !== offer.ciphertextSha256) {
    throw new CompanionAttachmentReceiveError('hash-mismatch', 'Companion attachment ciphertext hash does not match the offer')
  }
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc resolves CryptoKey via @types/node; oxlint's program misses that global
  const key = await deriveCompanionAttachmentKey(input.attachmentKey)
  const plaintext = await openCompanionAttachment(key, ciphertext).catch(() => {
    // AES-GCM authentication failure is the only remaining failure after the hash check.
    throw new CompanionAttachmentReceiveError('hash-mismatch', 'Companion attachment did not authenticate')
  })
  await input.submit({ fileName: offer.fileName, plaintext })
  return { fileName: offer.fileName, byteLength: plaintext.byteLength }
}
