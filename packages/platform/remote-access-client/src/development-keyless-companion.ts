/** Development-only Encrypted Companion seal used by keyless Desktop and Mobile. */

import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  type CompanionMessage,
  type NegotiatedCompanionProtocol,
} from '@deepseek-ai/dsh-remote-protocol'

const IV_BYTES = 12
const DEVELOPMENT_KEYLESS_COMPANION_KEY = Uint8Array.from({ length: 32 }, () => 29)

/**
 * Identify the one-byte keyless sync announcement.
 * @param ciphertext - development Relay frame.
 * @returns true when the frame is the sync announcement.
 */
export function isDevelopmentKeylessSyncCiphertext(ciphertext: Uint8Array): boolean {
  return ciphertext.byteLength === 1
}

/**
 * Negotiate the current Companion major from identical local offers.
 * @returns process-local codec capability for this endpoint.
 */
export function negotiateDevelopmentCompanionProtocol(): NegotiatedCompanionProtocol {
  return negotiateCompanionProtocol(
    createCompanionNegotiationChannel(),
    createCompanionVersionOffer('mobile'),
    createCompanionVersionOffer('desktop'),
  )
}

/**
 * Seal one encoded Companion message with the development AES-GCM key.
 * @param protocol - this endpoint's negotiated capability.
 * @param message - operation, result, or projection.
 * @returns iv-prefixed ciphertext for Relay forwarding.
 */
export async function sealDevelopmentCompanionMessage(
  protocol: NegotiatedCompanionProtocol,
  message: CompanionMessage,
): Promise<Uint8Array> {
  const key = await developmentCompanionKey()
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    localBytes(encodeCompanionMessage(protocol, message)),
  )
  const ciphertext = new Uint8Array(IV_BYTES + sealed.byteLength)
  ciphertext.set(iv)
  ciphertext.set(new Uint8Array(sealed), IV_BYTES)
  return ciphertext
}

/**
 * Open one development-sealed Companion message.
 * @param protocol - this endpoint's negotiated capability.
 * @param ciphertext - iv-prefixed AES-GCM bytes from the peer.
 * @returns validated Companion message.
 */
export async function openDevelopmentCompanionMessage(
  protocol: NegotiatedCompanionProtocol,
  ciphertext: Uint8Array,
): Promise<CompanionMessage> {
  if (ciphertext.byteLength <= IV_BYTES) throw new TypeError('Development Companion ciphertext is truncated')
  const key = await developmentCompanionKey()
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ciphertext.slice(0, IV_BYTES) },
    key,
    localBytes(ciphertext.slice(IV_BYTES)),
  )
  return decodeCompanionMessage(protocol, new Uint8Array(plaintext))
}

async function developmentCompanionKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    DEVELOPMENT_KEYLESS_COMPANION_KEY,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
}

function localBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.constructor === Uint8Array && Object.getPrototypeOf(bytes) === Uint8Array.prototype
    && bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes)
}
