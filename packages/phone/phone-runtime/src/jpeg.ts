/** Bounded Host-side recognition of one complete JPEG picture in an MJPEG body. */

import { readUntilRecognizable, rejectWhenAborted } from './recognizable-stream.ts'
import type { PhoneRotation } from './types.ts'

/** Maximum JPEG prefix inspected for EXIF orientation. */
export const JPEG_EXIF_PREFIX_MAX_BYTES = 256 * 1024

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
 * Read EXIF orientation from a bounded JPEG prefix.
 * @param bytes - JPEG bytes beginning at SOI.
 * @param maxBytes - maximum prefix admitted for metadata inspection.
 * @returns exact clockwise display rotation, or undefined when EXIF orientation is absent.
 */
export function jpegExifRotation(
  bytes: Uint8Array,
  maxBytes: number = JPEG_EXIF_PREFIX_MAX_BYTES,
): PhoneRotation | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new TypeError('JPEG EXIF maxBytes must be a safe integer of at least 4')
  if (bytes.byteLength > maxBytes) throw new Error(`JPEG EXIF prefix exceeded ${String(maxBytes)} bytes`)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG EXIF input must begin with SOI')
  let offset = 2
  while (offset < bytes.byteLength) {
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    if (marker === undefined) throw new Error('JPEG EXIF marker is truncated')
    offset += 1
    if (marker === 0xd9 || marker === 0xda) return undefined
    if (marker === 0x00 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) continue
    const high = bytes[offset]
    const low = bytes[offset + 1]
    if (high === undefined || low === undefined) throw new Error('JPEG EXIF segment length is truncated')
    const length = high * 256 + low
    if (length < 2) throw new Error('JPEG EXIF segment length is invalid')
    const payload = offset + 2
    const end = offset + length
    if (end > bytes.byteLength) throw new Error('JPEG EXIF segment is truncated')
    if (marker === 0xe1 && hasExifHeader(bytes, payload, end)) return exifRotation(bytes, payload + 6, end)
    offset = end
  }
  return undefined
}

/** Incremental bounded observer that reports metadata for each structurally complete JPEG frame. */
export class JpegFrameOrientationObserver {
  private state: 'seek' | 'marker' | 'marker-code' | 'length-high' | 'length-low' | 'payload' | 'entropy' | 'entropy-marker' = 'seek'
  private seekFf = false
  private marker = 0
  private lengthHigh = 0
  private remaining = 0
  private segment: number[] = []
  private metadataBytes = 0
  private metadataOversized = false
  private rotation: PhoneRotation | undefined
  private dimensioned = false
  private scanned = false
  private entropyPayload = false

  constructor(
    private readonly onFrame: (rotation: PhoneRotation | undefined) => void,
    private readonly maxBytes: number = JPEG_EXIF_PREFIX_MAX_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
      throw new TypeError('JPEG frame observer maxBytes must be a safe integer of at least 4')
    }
  }

  /** Accept the next unchanged byte chunk from an MJPEG stream.
   * @param chunk - Next source bytes in stream order.
   */
  push(chunk: Uint8Array): void {
    for (const byte of chunk) this.pushByte(byte)
  }

  private pushByte(byte: number): void {
    switch (this.state) {
      case 'seek':
        if (this.seekFf && byte === 0xd8) this.beginFrame()
        else this.seekFf = byte === 0xff
        return
      case 'marker':
        if (byte !== 0xff) {
          this.discardFrame(byte === 0xff)
          return
        }
        this.state = 'marker-code'
        return
      case 'marker-code':
        if (byte === 0xff) return
        if (byte === 0xd8) {
          this.beginFrame()
          return
        }
        if (byte === 0xd9) {
          this.finishFrame()
          return
        }
        if (byte === 0x00 || byte >= 0xd0 && byte <= 0xd7) {
          this.discardFrame(byte === 0xff)
          return
        }
        if (byte === 0x01) return
        this.marker = byte
        this.state = 'length-high'
        return
      case 'length-high':
        this.lengthHigh = byte
        this.state = 'length-low'
        return
      case 'length-low': {
        const length = this.lengthHigh * 256 + byte
        if (length < 2) {
          this.discardFrame(false)
          return
        }
        this.remaining = length - 2
        this.segment = []
        this.metadataBytes += length + 2
        if (this.metadataBytes > this.maxBytes) this.metadataOversized = true
        if (this.remaining === 0) this.finishSegment()
        else this.state = 'payload'
        return
      }
      case 'payload':
        if (!this.metadataOversized || this.marker === 0xe1 || isStartOfFrame(this.marker)) {
          if (this.segment.length < this.maxBytes) this.segment.push(byte)
        }
        this.remaining -= 1
        if (this.remaining === 0) this.finishSegment()
        return
      case 'entropy':
        if (byte === 0xff) this.state = 'entropy-marker'
        else this.entropyPayload = true
        return
      case 'entropy-marker':
        if (byte === 0x00) {
          this.entropyPayload = true
          this.state = 'entropy'
        } else if (byte === 0xff) {
          return
        } else if (byte >= 0xd0 && byte <= 0xd7) {
          this.state = 'entropy'
        } else if (byte === 0xd9) {
          this.finishFrame()
        } else if (byte === 0xd8) {
          this.beginFrame()
        } else {
          this.state = 'marker-code'
          this.pushByte(byte)
        }
        return
      default:
        return assertNever(this.state)
    }
  }

  private beginFrame(): void {
    this.state = 'marker'
    this.seekFf = false
    this.marker = 0
    this.remaining = 0
    this.segment = []
    this.metadataBytes = 2
    this.metadataOversized = false
    this.rotation = undefined
    this.dimensioned = false
    this.scanned = false
    this.entropyPayload = false
  }

  private finishSegment(): void {
    if (isStartOfFrame(this.marker) && this.segment.length >= 5) {
      const height = (this.segment[1] as number) * 256 + (this.segment[2] as number)
      const width = (this.segment[3] as number) * 256 + (this.segment[4] as number)
      this.dimensioned = width > 0 && height > 0
    } else if (this.marker === 0xe1 && !this.metadataOversized && this.rotation === undefined) {
      this.rotation = rotationOfExifPayload(Uint8Array.from(this.segment))
    }
    if (this.marker === 0xda) {
      this.scanned = true
      this.state = 'entropy'
    } else {
      this.state = 'marker'
    }
  }

  private finishFrame(): void {
    if (this.dimensioned && this.scanned && this.entropyPayload) {
      this.onFrame(this.metadataOversized ? undefined : this.rotation)
    }
    this.discardFrame(false)
  }

  private discardFrame(seekFf: boolean): void {
    this.state = 'seek'
    this.seekFf = seekFf
    this.segment = []
  }
}

function rotationOfExifPayload(payload: Uint8Array): PhoneRotation | undefined {
  if (!hasExifHeader(payload, 0, payload.byteLength)) return undefined
  try {
    return exifRotation(payload, 6, payload.byteLength)
  } catch (malformedExif) {
    // Truncated TIFF/IFD, invalid byte order/magic, or invalid orientation is not EXIF 1/3/6/8; later frames still count.
    void malformedExif
    return undefined
  }
}

/** Read through the first MJPEG frame carrying a supported EXIF orientation.
 * @param body - MJPEG byte stream owned by the caller.
 * @param signal - Probe cancellation signal.
 * @param maxBytes - Maximum retained JPEG prefix bytes.
 * @param cleanupTimeoutMs - Maximum wait for foreign reader cancellation.
 * @param reportLateCleanupError - Optional exact-once sink for rejection after cleanup abandonment.
 * @returns exact clockwise display rotation.
 */
export async function probeMjpegExifRotation(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes: number = JPEG_EXIF_PREFIX_MAX_BYTES,
  cleanupTimeoutMs: number = 1_000,
  reportLateCleanupError?: (error: unknown) => void,
): Promise<PhoneRotation> {
  const reader = body.getReader()
  const abortRace = rejectWhenAborted(signal)
  let received = 0
  let resolved: PhoneRotation | undefined
  const observer = new JpegFrameOrientationObserver((rotation) => { resolved ??= rotation }, maxBytes)
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), abortRace.promise])
      if (read.done) throw new Error('phone MJPEG stream ended before exact EXIF rotation was known')
      received += read.value.byteLength
      if (received > maxBytes) throw new Error(`phone MJPEG rotation probe exceeded ${String(maxBytes)} bytes`)
      observer.push(read.value)
      if (resolved !== undefined) return resolved
    }
  } finally {
    abortRace.dispose()
    const cancellation = Promise.resolve().then(() => reader.cancel())
    let abandoned = false
    const observed = cancellation.catch((error: unknown) => {
      if (abandoned) reportLateCleanupError?.(error)
    })
    let expire!: () => void
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { abandoned = true; resolve() }, cleanupTimeoutMs)
      expire = () => { clearTimeout(timer); resolve() }
    })
    await Promise.race([observed, timeout])
    expire()
  }
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
  await readUntilRecognizable(
    body, options.signal, new JpegPictureProbe(options.maxBytes, minimumDimension),
    'phone MJPEG stream ended before a complete recognizable JPEG picture',
  )
}

class JpegPictureProbe {
  private received = new Uint8Array()

  constructor(
    private readonly maxBytes: number,
    private readonly minimumDimension: number,
  ) {}

  push(chunk: Uint8Array): boolean {
    this.received = append(this.received, chunk)
    if (this.received.byteLength > this.maxBytes) {
      throw new Error(`phone MJPEG picture probe exceeded ${String(this.maxBytes)} bytes`)
    }
    return containsPicture(this.received, this.minimumDimension)
  }

  finish(): boolean {
    return containsPicture(this.received, this.minimumDimension)
  }
}

function hasExifHeader(bytes: Uint8Array, offset: number, end: number): boolean {
  return end - offset >= 6
    && bytes[offset] === 0x45 && bytes[offset + 1] === 0x78 && bytes[offset + 2] === 0x69
    && bytes[offset + 3] === 0x66 && bytes[offset + 4] === 0 && bytes[offset + 5] === 0
}

function exifRotation(bytes: Uint8Array, tiff: number, end: number): PhoneRotation | undefined {
  if (end - tiff < 8) throw new Error('JPEG EXIF TIFF header is truncated')
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d
  if (!little && !big) throw new Error('JPEG EXIF byte order is invalid')
  const u16 = (offset: number): number => {
    if (offset + 2 > end) throw new Error('JPEG EXIF value is truncated')
    return little
      ? (bytes[offset] as number) + (bytes[offset + 1] as number) * 256
      : (bytes[offset] as number) * 256 + (bytes[offset + 1] as number)
  }
  const u32 = (offset: number): number => {
    if (offset + 4 > end) throw new Error('JPEG EXIF value is truncated')
    return little
      ? (bytes[offset] as number) + (bytes[offset + 1] as number) * 256
        + (bytes[offset + 2] as number) * 65_536 + (bytes[offset + 3] as number) * 16_777_216
      : (bytes[offset] as number) * 16_777_216 + (bytes[offset + 1] as number) * 65_536
        + (bytes[offset + 2] as number) * 256 + (bytes[offset + 3] as number)
  }
  if (u16(tiff + 2) !== 42) throw new Error('JPEG EXIF TIFF magic is invalid')
  const ifd = tiff + u32(tiff + 4)
  const count = u16(ifd)
  if (count > 512) throw new Error('JPEG EXIF IFD entry count is oversized')
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > end) throw new Error('JPEG EXIF IFD is truncated')
    if (u16(entry) !== 0x0112) continue
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) throw new Error('JPEG EXIF orientation field is invalid')
    const orientation = u16(entry + 8)
    if (orientation === 1) return 0
    if (orientation === 6) return 90
    if (orientation === 3) return 180
    if (orientation === 8) return 270
    return undefined
  }
  return undefined
}

function containsPicture(bytes: Uint8Array, minimumDimension: number): boolean {
  for (let start = 0; start < bytes.byteLength - 1; start += 1) {
    if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) continue
    let offset = start + 2
    let dimensioned = false
    let frameComponents: ReadonlyMap<number, number> | undefined
    let inScan = false
    let hasScanPayload = false
    const quantizationTables = new Set<number>()
    const dcHuffmanTables = new Set<number>()
    const acHuffmanTables = new Set<number>()
    while (offset < bytes.byteLength - 1) {
      if (bytes[offset] !== 0xff) {
        if (!inScan) break
        hasScanPayload = true
        offset += 1
        continue
      }
      while (bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset]
      if (marker === undefined) break
      offset += 1
      if (marker === 0xd9) {
        if (dimensioned && hasScanPayload) return true
        break
      }
      if (marker === 0x00) {
        if (!inScan) break
        hasScanPayload = true
        continue
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        if (!inScan) break
        continue
      }
      if (marker === 0xd8) break
      inScan = false
      const high = bytes[offset]
      const low = bytes[offset + 1]
      if (high === undefined || low === undefined) break
      const length = high * 256 + low
      if (length < 2) break
      const end = offset + length
      if (end > bytes.byteLength) break
      if (isStartOfFrame(marker)) {
        const frame = frameHeader(bytes, offset, end, minimumDimension)
        if (frame === undefined) break
        dimensioned = frame.dimensioned
        frameComponents = frame.components
      }
      if (marker === 0xdb) {
        const ids = quantizationTableIds(bytes, offset, end)
        if (ids === undefined) break
        for (const id of ids) quantizationTables.add(id)
      }
      if (marker === 0xc4) {
        const tables = huffmanTableIds(bytes, offset, end)
        if (tables === undefined) break
        for (const id of tables.dc) dcHuffmanTables.add(id)
        for (const id of tables.ac) acHuffmanTables.add(id)
      }
      if (marker === 0xda) {
        if (!validScanHeader(
          bytes, offset, end, frameComponents,
          quantizationTables, dcHuffmanTables, acHuffmanTables,
        )) break
        inScan = true
      }
      offset = end
    }
  }
  return false
}

interface FrameHeader {
  readonly dimensioned: boolean
  readonly components: ReadonlyMap<number, number>
}

function frameHeader(bytes: Uint8Array, offset: number, end: number, minimumDimension: number): FrameHeader | undefined {
  const components = bytes[offset + 7]
  if (components === undefined || components < 1 || components > 4 || end - offset !== 8 + components * 3) {
    return undefined
  }
  const quantizationIds = new Map<number, number>()
  for (let index = 0; index < components; index += 1) {
    const component = bytes[offset + 8 + index * 3] as number
    const sampling = bytes[offset + 9 + index * 3] as number
    const quantizationId = bytes[offset + 10 + index * 3] as number
    if (quantizationIds.has(component) || (sampling >> 4) === 0 || (sampling & 0x0f) === 0 || quantizationId > 3) {
      return undefined
    }
    quantizationIds.set(component, quantizationId)
  }
  const height = (bytes[offset + 3] as number) * 256 + (bytes[offset + 4] as number)
  const width = (bytes[offset + 5] as number) * 256 + (bytes[offset + 6] as number)
  return { dimensioned: width >= minimumDimension && height >= minimumDimension, components: quantizationIds }
}

function validScanHeader(
  bytes: Uint8Array,
  offset: number,
  end: number,
  frameComponents: ReadonlyMap<number, number> | undefined,
  quantizationTables: ReadonlySet<number>,
  dcHuffmanTables: ReadonlySet<number>,
  acHuffmanTables: ReadonlySet<number>,
): boolean {
  const components = bytes[offset + 2]
  if (components === undefined || components < 1 || components > 4
    || end - offset !== 6 + components * 2 || frameComponents === undefined) return false
  const spectralStart = bytes[end - 3] as number
  const spectralEnd = bytes[end - 2] as number
  if (spectralStart > spectralEnd || spectralEnd > 63) return false
  const needsDcTable = spectralStart === 0
  const needsAcTable = spectralEnd > 0
  const admitted = new Set<number>()
  for (let index = 0; index < components; index += 1) {
    const component = bytes[offset + 3 + index * 2] as number
    const selector = bytes[offset + 4 + index * 2] as number
    const quantizationId = frameComponents.get(component)
    if (quantizationId === undefined || admitted.has(component) || !quantizationTables.has(quantizationId)
      || needsDcTable && !dcHuffmanTables.has(selector >> 4)
      || needsAcTable && !acHuffmanTables.has(selector & 0x0f)) return false
    admitted.add(component)
  }
  return true
}

function quantizationTableIds(bytes: Uint8Array, offset: number, end: number): readonly number[] | undefined {
  let cursor = offset + 2
  const ids: number[] = []
  while (cursor < end) {
    const selector = bytes[cursor] as number
    const precision = selector >> 4
    const id = selector & 0x0f
    if (precision > 1 || id > 3) return undefined
    const valueBytes = precision === 0 ? 64 : 128
    const valuesEnd = cursor + 1 + valueBytes
    if (valuesEnd > end) return undefined
    for (let index = cursor + 1; index < valuesEnd; index += precision + 1) {
      const value = precision === 0
        ? bytes[index]
        : (bytes[index] as number) * 256 + (bytes[index + 1] as number)
      if (value === 0) return undefined
    }
    ids.push(id)
    cursor = valuesEnd
  }
  return ids.length === 0 ? undefined : ids
}

interface HuffmanTableIds {
  readonly dc: readonly number[]
  readonly ac: readonly number[]
}

function huffmanTableIds(bytes: Uint8Array, offset: number, end: number): HuffmanTableIds | undefined {
  let cursor = offset + 2
  const dc: number[] = []
  const ac: number[] = []
  while (cursor < end) {
    const selector = bytes[cursor] as number
    if ((selector >> 4) > 1 || (selector & 0x0f) > 3) return undefined
    if (cursor + 17 > end) return undefined
    let values = 0
    for (let index = cursor + 1; index < cursor + 17; index += 1) values += bytes[index] as number
    if (values < 1 || values > 256 || cursor + 17 + values > end) return undefined
    if ((selector >> 4) === 0) dc.push(selector & 0x0f)
    else ac.push(selector & 0x0f)
    cursor += 17 + values
  }
  return dc.length === 0 && ac.length === 0 ? undefined : { dc, ac }
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
}

function assertNever(value: never): never { throw new TypeError(`unexpected JPEG observer state: ${String(value)}`) }

function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}
