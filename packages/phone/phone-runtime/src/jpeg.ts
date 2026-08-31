/** Bounded Host-side recognition of one complete JPEG picture in an MJPEG body. */

/** Inputs for one bounded MJPEG/JPEG picture verification. */
export interface MjpegPictureVerificationOptions {
  /** Caller cancellation for the live response body. */
  readonly signal: AbortSignal
  /** Maximum bytes accepted before one complete picture is found. */
  readonly maxBytes: number
  /** Smallest admitted encoded width and height. */
  readonly minimumDimension?: number
}

/**
 * Read an MJPEG response until one dimensioned JPEG scan is complete.
 * Multipart headers are ignored, while JPEG marker order, segment bounds,
 * dimensions, scan data, and the end marker must all be recognizable.
 * @param body - live upstream MJPEG response body.
 * @param options - cancellation, byte ceiling, and minimum picture dimension.
 * @returns completion after one recognizable JPEG picture and reader cancellation settle.
 */
export async function verifyMjpegJpegPicture(
  body: ReadableStream<Uint8Array>,
  options: MjpegPictureVerificationOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError('MJPEG verification maxBytes must be a positive safe integer')
  }
  const minimumDimension = options.minimumDimension ?? 16
  if (!Number.isSafeInteger(minimumDimension) || minimumDimension < 1) {
    throw new TypeError('MJPEG minimumDimension must be a positive safe integer')
  }
  const reader = body.getReader()
  let received = new Uint8Array()
  let rejectAbort: (reason?: unknown) => void = () => {}
  const halt = (): void => { rejectAbort(options.signal.reason) }
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
    if (options.signal.aborted) halt()
    else options.signal.addEventListener('abort', halt, { once: true })
  })
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (chunk.done) {
        if (containsPicture(received, minimumDimension)) return
        throw new Error('phone MJPEG stream ended before a complete recognizable JPEG picture')
      }
      received = append(received, chunk.value)
      if (received.byteLength > options.maxBytes) {
        throw new Error(`phone MJPEG picture probe exceeded ${String(options.maxBytes)} bytes`)
      }
      if (containsPicture(received, minimumDimension)) return
    }
  } finally {
    options.signal.removeEventListener('abort', halt)
    await reader.cancel().catch(() => {})
  }
}

function containsPicture(bytes: Uint8Array, minimumDimension: number): boolean {
  for (let start = 0; start < bytes.byteLength - 1; start += 1) {
    if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) continue
    let offset = start + 2
    let dimensioned = false
    let scanned = false
    while (offset < bytes.byteLength - 1) {
      if (bytes[offset] !== 0xff) {
        if (!scanned) break
        offset += 1
        continue
      }
      while (bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset]
      if (marker === undefined) return false
      offset += 1
      if (marker === 0xd9) return dimensioned && scanned
      if (marker === 0x00 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) continue
      const high = bytes[offset]
      const low = bytes[offset + 1]
      if (high === undefined || low === undefined) return false
      const length = high * 256 + low
      if (length < 2) break
      const end = offset + length
      if (end > bytes.byteLength) return false
      if (isStartOfFrame(marker)) {
        if (length < 8) break
        const height = (bytes[offset + 3] as number) * 256 + (bytes[offset + 4] as number)
        const width = (bytes[offset + 5] as number) * 256 + (bytes[offset + 6] as number)
        dimensioned = width >= minimumDimension && height >= minimumDimension
      }
      if (marker === 0xda) scanned = true
      offset = end
    }
  }
  return false
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}
