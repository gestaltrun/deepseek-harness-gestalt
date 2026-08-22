/** Concatenate endpoint-owned byte arrays without retaining caller buffers. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const value = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    value.set(part, offset)
    offset += part.byteLength
  }
  return value
}

/** Encode a bounded byte prefix for authentication words and fingerprints. */
export function hexPrefix(bytes: Uint8Array, length: number): string {
  return [...bytes.slice(0, length)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
