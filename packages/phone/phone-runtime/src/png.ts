/** PNG signature checks for still screenshots. */

/** Eight-byte PNG file signature. */
export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

/**
 * Whether `bytes` begin with a PNG signature.
 * @param bytes - Candidate file bytes.
 * @returns true only when the PNG signature is present.
 */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength) return false
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}
