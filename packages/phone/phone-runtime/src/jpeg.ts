/** Bounded Host-side recognition of one complete JPEG picture in an MJPEG body. */

import { readUntilRecognizable } from './recognizable-stream.ts'

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
      if (marker === undefined) return false
      offset += 1
      if (marker === 0xd9) {
        return dimensioned && hasScanPayload
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
      if (high === undefined || low === undefined) return false
      const length = high * 256 + low
      if (length < 2) break
      const end = offset + length
      if (end > bytes.byteLength) return false
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

function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}
