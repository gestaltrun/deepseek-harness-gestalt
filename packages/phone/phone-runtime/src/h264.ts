/** Bounded Host-side syntax recognition of one Annex-B H264 key access unit. */

import { inspectRecognizable, readUntilRecognizable, type RecognizableStreamInspection } from './recognizable-stream.ts'

interface StartCode {
  readonly index: number
  readonly length: 3 | 4
}

/** Inputs for one bounded H264 key-access-unit verification. */
export interface H264KeyAccessUnitVerificationOptions {
  /** Caller cancellation for the body read. */
  readonly signal: AbortSignal
  /** Maximum bytes accepted before SPS, PPS, and a complete IDR are found. */
  readonly maxBytes: number
}

/**
 * Read until a complete SPS → PPS → IDR Annex-B sequence is recognizable.
 * Leading zero bytes are legal; non-zero preamble bytes, empty NAL units,
 * forbidden-zero-bit headers, partial input, and oversized input are rejected.
 * The reader cancellation settles before this function returns or throws.
 * @param body - live upstream H264 response body.
 * @param options - cancellation and byte ceiling.
 * @returns completion after one key access unit is recognizable and reader cancellation settles.
 */
export async function verifyAnnexBH264KeyAccessUnit(
  body: ReadableStream<Uint8Array>,
  options: H264KeyAccessUnitVerificationOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError('H264 verification maxBytes must be a positive safe integer')
  }
  const probe = new AnnexBKeyAccessUnitProbe(options.maxBytes)
  await readUntilRecognizable(
    body, options.signal, probe,
    'phone H264 stream ended before a complete SPS, PPS, and IDR key access unit',
  )
}

/**
 * Inspect an Annex-B stream through one key access unit while preserving every
 * byte for playback or renderer-side failure handling.
 * @param body - Live upstream H264 response body.
 * @param options - Cancellation and byte ceiling.
 * @returns recognition facts plus a replayable continuation.
 */
export async function inspectAnnexBH264KeyAccessUnit(
  body: ReadableStream<Uint8Array>,
  options: H264KeyAccessUnitVerificationOptions,
): Promise<RecognizableStreamInspection> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError('H264 verification maxBytes must be a positive safe integer')
  }
  return await inspectRecognizable(
    body,
    options.signal,
    new AnnexBKeyAccessUnitProbe(options.maxBytes),
    'phone H264 stream ended before a complete SPS, PPS, and IDR key access unit',
  )
}

class AnnexBKeyAccessUnitProbe {
  private pending = new Uint8Array()
  private received = 0
  private phase: 'sps' | 'pps' | 'idr' | 'complete' = 'sps'
  private admittedFirstStart = false
  private sequence: SequenceParameterSet | undefined
  private picture: PictureParameterSet | undefined

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): boolean {
    this.received += chunk.byteLength
    if (this.received > this.maxBytes) {
      throw new Error(`phone H264 key-access-unit probe exceeded ${String(this.maxBytes)} bytes`)
    }
    this.pending = append(this.pending, chunk)
    const starts = startCodesIn(this.pending)
    if (starts.length === 0) return false
    this.admitPreamble(starts[0] as StartCode)
    if (starts.length < 2) return false
    const last = starts.reduce((start, following) => {
      this.acceptNal(this.pending.subarray(start.index + start.length, following.index))
      return following
    })
    this.pending = this.pending.slice(last.index)
    if (this.phase === 'idr') this.acceptLiveTrailingIdr()
    return this.phase === 'complete'
  }

  finish(): boolean {
    const starts = startCodesIn(this.pending)
    const start = starts[0]
    if (start === undefined) return false
    this.admitPreamble(start)
    this.acceptNal(this.pending.subarray(start.index + start.length))
    this.pending = new Uint8Array()
    return this.phase === 'complete'
  }

  private admitPreamble(start: StartCode): void {
    if (this.admittedFirstStart) return
    this.admittedFirstStart = true
    if (this.pending.subarray(0, start.index).some(byte => byte !== 0)) {
      throw new Error('phone H264 stream has a non-zero preamble before its first Annex-B start code')
    }
  }

  private acceptNal(nal: Uint8Array): void {
    if (nal.byteLength === 0) throw new Error('phone H264 stream contains an empty Annex-B NAL')
    const header = nal[0] as number
    if ((header & 0x80) !== 0) throw new Error('phone H264 stream contains a forbidden-zero-bit NAL')
    const type = header & 0x1f
    if (this.phase === 'sps' && type === 7) {
      this.sequence = parseSps(nal)
      this.phase = 'pps'
    } else if (this.phase === 'pps' && type === 8) {
      this.picture = parsePps(nal, this.sequence as SequenceParameterSet)
      this.phase = 'idr'
    } else if (this.phase === 'idr' && type === 5) {
      parseIdr(nal, this.sequence as SequenceParameterSet, this.picture as PictureParameterSet)
      this.phase = 'complete'
    }
  }

  private acceptLiveTrailingIdr(): void {
    const start = startCodesIn(this.pending)[0] as StartCode
    const nal = this.pending.subarray(start.index + start.length)
    const header = nal[0]
    if (header === undefined || (header & 0x1f) !== 5) return
    try {
      parseIdr(nal, this.sequence as SequenceParameterSet, this.picture as PictureParameterSet)
      this.phase = 'complete'
    } catch (error) {
      if (error instanceof Error && error.message.includes('truncated IDR')) return
      throw error
    }
  }
}

interface SequenceParameterSet {
  readonly id: number
  readonly log2MaxFrameNum: number
  readonly picOrderCntType: number
  readonly log2MaxPicOrderCntLsb: number
  readonly macroblockCount: number
}

interface PictureParameterSet {
  readonly id: number
  readonly spsId: number
  readonly bottomFieldPicOrderInFramePresent: boolean
  readonly redundantPicCountPresent: boolean
  readonly deblockingFilterControlPresent: boolean
}

function parseSps(nal: Uint8Array): SequenceParameterSet {
  const reader = new RbspReader(rbspOf(nal), 'SPS')
  const profile = reader.bits(8)
  reader.bits(8)
  reader.bits(8)
  const id = reader.ue()
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chromaFormat = reader.ue()
    if (chromaFormat > 2) throw new Error('phone H264 SPS has an unsupported chroma format')
    reader.ue()
    reader.ue()
    reader.bit()
    if (reader.bit() === 1) throw new Error('phone H264 SPS has unsupported scaling matrices')
  }
  const log2MaxFrameNum = reader.ue() + 4
  const picOrderCntType = reader.ue()
  let log2MaxPicOrderCntLsb = 0
  if (picOrderCntType === 0) log2MaxPicOrderCntLsb = reader.ue() + 4
  else if (picOrderCntType === 1) throw new Error('phone H264 SPS has unsupported picture order type 1')
  else if (picOrderCntType !== 2) throw new Error('phone H264 SPS has an invalid picture order type')
  reader.ue()
  reader.bit()
  const widthInMacroblocks = reader.ue() + 1
  const heightInMapUnits = reader.ue() + 1
  const frameMbsOnly = reader.bit()
  if (frameMbsOnly !== 1) throw new Error('phone H264 SPS describes an unsupported interlaced picture')
  reader.bit()
  const cropped = reader.bit()
  if (cropped === 1) {
    const left = reader.ue()
    const right = reader.ue()
    const top = reader.ue()
    const bottom = reader.ue()
    if (left + right >= widthInMacroblocks * 8 || top + bottom >= heightInMapUnits * 8) {
      throw new Error('phone H264 SPS has invalid picture cropping')
    }
  }
  if (log2MaxFrameNum > 20 || log2MaxPicOrderCntLsb > 20
    || widthInMacroblocks > 16_384 || heightInMapUnits > 16_384) {
    throw new Error('phone H264 SPS exceeds the bounded picture syntax')
  }
  return {
    id, log2MaxFrameNum, picOrderCntType, log2MaxPicOrderCntLsb,
    macroblockCount: widthInMacroblocks * heightInMapUnits,
  }
}

function parsePps(nal: Uint8Array, sps: SequenceParameterSet): PictureParameterSet {
  const reader = new RbspReader(rbspOf(nal), 'PPS')
  const id = reader.ue()
  const spsId = reader.ue()
  if (spsId !== sps.id) throw new Error(`phone H264 PPS references unknown SPS ${String(spsId)}`)
  reader.bit()
  const bottomFieldPicOrderInFramePresent = reader.bit() === 1
  if (reader.ue() !== 0) throw new Error('phone H264 PPS uses unsupported slice groups')
  reader.ue()
  reader.ue()
  reader.bit()
  reader.bits(2)
  reader.se()
  reader.se()
  reader.se()
  const deblockingFilterControlPresent = reader.bit() === 1
  reader.bit()
  const redundantPicCountPresent = reader.bit() === 1
  return {
    id, spsId, bottomFieldPicOrderInFramePresent, redundantPicCountPresent,
    deblockingFilterControlPresent,
  }
}

function parseIdr(nal: Uint8Array, sps: SequenceParameterSet, pps: PictureParameterSet): void {
  const header = nal[0] as number
  if (((header >> 5) & 0x03) === 0) throw new Error('phone H264 IDR has no reference priority')
  const reader = new RbspReader(rbspOf(nal), 'IDR slice')
  const firstMacroblock = reader.ue()
  const sliceType = reader.ue() % 5
  const ppsId = reader.ue()
  if (ppsId !== pps.id) throw new Error(`phone H264 IDR references unknown PPS ${String(ppsId)}`)
  if (firstMacroblock >= sps.macroblockCount || (sliceType !== 2 && sliceType !== 4)) {
    throw new Error('phone H264 IDR has invalid primary-picture syntax')
  }
  reader.bits(sps.log2MaxFrameNum)
  reader.ue()
  if (sps.picOrderCntType === 0) {
    reader.bits(sps.log2MaxPicOrderCntLsb)
    if (pps.bottomFieldPicOrderInFramePresent) reader.se()
  }
  if (pps.redundantPicCountPresent) reader.ue()
  reader.bit()
  reader.bit()
  reader.se()
  if (pps.deblockingFilterControlPresent) {
    const disableDeblocking = reader.ue()
    if (disableDeblocking !== 1) {
      reader.se()
      reader.se()
    }
  }
  if (reader.remainingBits < 1) throw new Error('phone H264 stream contains a truncated IDR slice payload')
}

function rbspOf(nal: Uint8Array): Uint8Array {
  const bytes: number[] = []
  for (let index = 1; index < nal.byteLength; index += 1) {
    const byte = nal[index] as number
    if (bytes.length >= 2 && bytes.at(-2) === 0 && bytes.at(-1) === 0 && byte === 3) continue
    bytes.push(byte)
  }
  return Uint8Array.from(bytes)
}

class RbspReader {
  private offset = 0

  constructor(
    private readonly bytes: Uint8Array,
    private readonly label: 'SPS' | 'PPS' | 'IDR slice',
  ) {}

  get remainingBits(): number { return this.bytes.byteLength * 8 - this.offset }

  bit(): number {
    const byte = this.bytes[this.offset >> 3]
    if (byte === undefined) throw new Error(`phone H264 stream contains a truncated ${this.label}`)
    const value = (byte >> (7 - (this.offset & 7))) & 1
    this.offset += 1
    return value
  }

  bits(width: number): number {
    let value = 0
    for (let index = 0; index < width; index += 1) value = value * 2 + this.bit()
    return value
  }

  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      zeros += 1
      if (zeros > 31) throw new Error(`phone H264 stream contains an invalid ${this.label}`)
    }
    let value = 1
    for (let index = 0; index < zeros; index += 1) value = value * 2 + this.bit()
    return value - 1
  }

  se(): number {
    const value = this.ue()
    return (value & 1) === 1 ? (value + 1) / 2 : -(value / 2)
  }
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}

function startCodesIn(bytes: Uint8Array): StartCode[] {
  const starts: StartCode[] = []
  for (let index = 0; index < bytes.byteLength - 2; index += 1) {
    const four = index + 3 < bytes.byteLength
      && bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 0 && bytes[index + 3] === 1
    const three = !four && bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1
    if (!four && !three) continue
    const length = four ? 4 : 3
    starts.push({ index, length })
    index += length - 1
  }
  return starts
}
