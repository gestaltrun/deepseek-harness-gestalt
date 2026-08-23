/**
 * Endpoint attachment cipher shared by Mobile and Desktop.
 *
 * Both functions are linked only by endpoints; the Platform blob store retains
 * {@link sealCompanionAttachment} output and can never recover plaintext.
 */

const HKDF_INFO = 'deepseek-harness/companion-attachment/v1'
const IV_BYTES = 12
const GCM_TAG_BYTES = 16

/** AES-256-GCM seal overhead: 12-byte IV plus the 16-byte authentication tag. */
export const COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES = IV_BYTES + GCM_TAG_BYTES

/**
 * Derive one AES-256-GCM content key from a Personal Pairing attachment key.
 * @param attachmentKey - secret bytes supplied by the Personal Pairing layer.
 * @returns endpoint-local AES-GCM key; never crosses a wire.
 */
export async function deriveCompanionAttachmentKey(attachmentKey: Uint8Array): Promise<CryptoKey> {
  if (attachmentKey.byteLength < 32) throw new TypeError('Companion attachment key must be at least 32 bytes')
  const hkdf = await crypto.subtle.importKey('raw', localBytes(attachmentKey), 'HKDF', false, ['deriveKey'])
  return await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypt attachment bytes on Mobile before upload.
 * @param key - pairing-derived attachment key.
 * @param plaintext - caller-held plaintext.
 * @returns ciphertext (`iv ‖ AES-GCM ciphertext ‖ tag`) and its lowercase hex SHA-256.
 * The ciphertext is {@link COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES} bytes longer than the plaintext.
 */
export async function sealCompanionAttachment(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; ciphertextSha256: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, localBytes(plaintext))
  const ciphertext = new Uint8Array(IV_BYTES + sealed.byteLength)
  ciphertext.set(iv)
  ciphertext.set(new Uint8Array(sealed), IV_BYTES)
  return { ciphertext, ciphertextSha256: await hashCompanionCiphertext(ciphertext) }
}

/**
 * Open one verified Companion attachment ciphertext on Desktop.
 * @param key - pairing-derived attachment key matching the sealing endpoint.
 * @param ciphertext - `iv ‖ AES-GCM output` bytes downloaded from the Platform blob store.
 * @returns decrypted plaintext bytes.
 */
export async function openCompanionAttachment(key: CryptoKey, ciphertext: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.byteLength <= IV_BYTES) throw new TypeError('Companion attachment ciphertext is truncated')
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ciphertext.slice(0, IV_BYTES) },
    key,
    localBytes(ciphertext.slice(IV_BYTES)),
  )
  return new Uint8Array(plaintext)
}

/**
 * Hash sealed attachment bytes for Desktop verification before decrypting.
 * @param ciphertext - bytes exactly as retained by the Platform blob store.
 * @returns lowercase hex SHA-256.
 */
export async function hashCompanionCiphertext(ciphertext: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', localBytes(ciphertext))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function localBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.constructor === Uint8Array && Object.getPrototypeOf(bytes) === Uint8Array.prototype
    && bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes)
}
