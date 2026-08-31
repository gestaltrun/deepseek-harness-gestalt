/** Browser H264 playback from a signed Annex-B capture URL onto one canvas. */

/** Callbacks and browser resources for one H264 playback lifecycle. */
export interface PhoneH264PlaybackOptions {
  /** Signed same-origin `video/h264` URL. */
  readonly url: string
  /** Canvas that receives the most recently decoded frame. */
  readonly canvas: HTMLCanvasElement
  /** Called when decoded display dimensions first appear or change. */
  readonly onSurface: (width: number, height: number) => void
  /** Called once when fetch, parsing, decoding, or drawing fails. */
  readonly onError: (error: unknown) => void
}

/** Handle that synchronously prevents later drawing and callbacks. */
export interface PhoneH264Playback {
  /**
   * Abort fetch, release the decoder, and await playback quiescence.
   * Repeated calls share the same non-rejecting settlement.
   * @returns completion after reader cancellation and the decode run stop.
   */
  close(): Promise<void>
}

interface AnnexBAccessUnit {
  readonly data: Uint8Array
  readonly key: boolean
  readonly codec?: string
}

interface StartCode {
  readonly index: number
  readonly length: 3 | 4
}

const MAX_DECODE_QUEUE = 2
const ACCESS_UNIT_PREFIX_TYPES = new Set([6, 7, 8, 9, 14, 15, 16, 17, 18])

function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function startCodesIn(data: Uint8Array): StartCode[] {
  const starts: StartCode[] = []
  for (let index = 0; index < data.length - 2; index += 1) {
    const four = index + 3 < data.length
      && data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 0 && data[index + 3] === 1
    const three = !four && data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1
    if (!four && !three) continue
    const length = four ? 4 : 3
    starts.push({ index, length })
    index += length - 1
  }
  return starts
}

function nalHeaderOffset(nal: Uint8Array): number {
  const four = nal.length >= 5
    && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1
  if (four) return 4
  const three = nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1
  if (three) return 3
  throw new Error('phone H264 stream contains a NAL without an Annex-B start code')
}

function nalType(nal: Uint8Array): number {
  const view = new DataView(nal.buffer, nal.byteOffset, nal.byteLength)
  return view.getUint8(nalHeaderOffset(nal)) & 0x1f
}

function codecOfSps(nal: Uint8Array): string {
  const payload = nalHeaderOffset(nal) + 1
  const profile = nal[payload]
  const compatibility = nal[payload + 1]
  const level = nal[payload + 2]
  if (profile === undefined || compatibility === undefined || level === undefined) {
    throw new Error('phone H264 stream contains a truncated SPS')
  }
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `avc1.${hex(profile)}${hex(compatibility)}${hex(level)}`
}

function rbspOf(nal: Uint8Array): Uint8Array {
  const source = nal.subarray(nalHeaderOffset(nal) + 1)
  const bytes: number[] = []
  for (const byte of source) {
    if (bytes.length >= 2 && bytes.at(-2) === 0 && bytes.at(-1) === 0 && byte === 3) continue
    bytes.push(byte)
  }
  return Uint8Array.from(bytes)
}

class RbspReader {
  private bitOffset = 0

  constructor(
    private readonly bytes: Uint8Array,
    private readonly label: 'SPS' | 'PPS' | 'slice header',
  ) {}

  bit(): number {
    const byte = this.bytes.at(this.bitOffset >> 3)
    if (byte === undefined) throw new Error(`phone H264 stream contains a truncated ${this.label}`)
    const value = (byte >> (7 - (this.bitOffset & 7))) & 1
    this.bitOffset += 1
    return value
  }

  bits(width: number): number {
    let value = 0
    for (let index = 0; index < width; index += 1) value = value * 2 + this.bit()
    return value
  }

  ue(): number {
    let zeroCount = 0
    while (this.bit() === 0) {
      zeroCount += 1
      if (zeroCount > 31) throw new Error(`phone H264 stream contains an invalid ${this.label}`)
    }
    let value = 1
    for (let index = 0; index < zeroCount; index += 1) value = value * 2 + this.bit()
    return value - 1
  }
}

interface SequenceParameterSet {
  readonly id: number
  readonly log2MaxFrameNum: number
  readonly picOrderCntType: number
  readonly log2MaxPicOrderCntLsb: number
}

interface PictureParameterSet {
  readonly id: number
  readonly spsId: number
}

interface PrimaryPictureIdentity {
  readonly firstMacroblock: number
  readonly ppsId: number
  readonly frameNum: number
  readonly nalRefIdc: number
  readonly idr: boolean
  readonly idrPicId: number
  readonly picOrderCntLsb: number
}

function parseSps(nal: Uint8Array): SequenceParameterSet {
  const reader = new RbspReader(rbspOf(nal), 'SPS')
  const profile = reader.bits(8)
  reader.bits(8)
  reader.bits(8)
  const id = reader.ue()
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chromaFormat = reader.ue()
    if (chromaFormat > 2) throw new Error(`phone H264 SPS uses unsupported chroma_format_idc ${String(chromaFormat)}`)
    reader.ue()
    reader.ue()
    reader.bit()
    if (reader.bit() === 1) throw new Error('phone H264 SPS uses unsupported scaling matrices')
  }
  const log2MaxFrameNum = reader.ue() + 4
  const picOrderCntType = reader.ue()
  let log2MaxPicOrderCntLsb = 0
  if (picOrderCntType === 0) {
    log2MaxPicOrderCntLsb = reader.ue() + 4
  } else if (picOrderCntType === 1) {
    throw new Error('phone H264 SPS uses unsupported pic_order_cnt_type 1')
  } else if (picOrderCntType !== 2) {
    throw new Error(`phone H264 SPS uses invalid pic_order_cnt_type ${String(picOrderCntType)}`)
  }
  reader.ue()
  reader.bit()
  reader.ue()
  reader.ue()
  if (reader.bit() !== 1) throw new Error('phone H264 SPS uses unsupported interlaced pictures')
  return {
    id,
    log2MaxFrameNum,
    picOrderCntType,
    log2MaxPicOrderCntLsb,
  }
}

function parsePps(nal: Uint8Array): PictureParameterSet {
  const reader = new RbspReader(rbspOf(nal), 'PPS')
  const id = reader.ue()
  const spsId = reader.ue()
  reader.bit()
  if (reader.bit() === 1) throw new Error('phone H264 PPS uses unsupported bottom-field picture order')
  return { id, spsId }
}

function parsePrimaryPicture(
  nal: Uint8Array,
  ppsById: ReadonlyMap<number, PictureParameterSet>,
  spsById: ReadonlyMap<number, SequenceParameterSet>,
): PrimaryPictureIdentity {
  const reader = new RbspReader(rbspOf(nal), 'slice header')
  const firstMacroblock = reader.ue()
  reader.ue()
  const ppsId = reader.ue()
  const pps = ppsById.get(ppsId)
  if (pps === undefined) throw new Error(`phone H264 slice references unknown PPS ${String(ppsId)}`)
  const sps = spsById.get(pps.spsId)
  if (sps === undefined) throw new Error(`phone H264 PPS references unknown SPS ${String(pps.spsId)}`)
  const frameNum = reader.bits(sps.log2MaxFrameNum)
  const type = nalType(nal)
  const idr = type === 5
  const idrPicId = idr ? reader.ue() : 0
  let picOrderCntLsb = 0
  if (sps.picOrderCntType === 0) {
    picOrderCntLsb = reader.bits(sps.log2MaxPicOrderCntLsb)
  }
  const header = new DataView(nal.buffer, nal.byteOffset, nal.byteLength).getUint8(nalHeaderOffset(nal))
  return {
    firstMacroblock,
    ppsId,
    frameNum,
    nalRefIdc: (header >> 5) & 0x03,
    idr,
    idrPicId,
    picOrderCntLsb,
  }
}

function isFollowingPrimaryPicture(
  previous: PrimaryPictureIdentity,
  following: PrimaryPictureIdentity,
): boolean {
  if (following.firstMacroblock !== 0) return false
  const keyOf = (picture: PrimaryPictureIdentity): string => [
    picture.frameNum,
    picture.ppsId,
    picture.nalRefIdc === 0 ? 0 : 1,
    picture.idr ? 1 : 0,
    picture.idrPicId,
    picture.picOrderCntLsb,
  ].join(':')
  return keyOf(following) !== keyOf(previous)
}

class AnnexBAccessUnitAssembler {
  private pending = new Uint8Array()
  private current: Uint8Array[] = []
  private currentHasVcl = false
  private currentPicture: PrimaryPictureIdentity | undefined
  private currentKey = false
  private currentCodec: string | undefined
  private readonly spsById = new Map<number, SequenceParameterSet>()
  private readonly ppsById = new Map<number, PictureParameterSet>()
  private readonly ready: AnnexBAccessUnit[] = []

  push(bytes: Uint8Array): AnnexBAccessUnit[] {
    this.pending = append(this.pending, bytes)
    const starts = startCodesIn(this.pending)
    if (starts[0] !== undefined && starts[0].index !== 0) {
      throw new Error('phone H264 stream contains bytes without an Annex-B start code')
    }
    if (starts.length < 2) return []
    const last = starts.reduce((start, following) => {
      this.acceptNal(this.pending.slice(start.index, following.index))
      return following
    })
    this.pending = this.pending.slice(last.index)
    return this.drain()
  }

  finish(): AnnexBAccessUnit[] {
    const starts = startCodesIn(this.pending)
    const start = starts.at(0)
    if (this.pending.length > 0 && start === undefined) {
      throw new Error('phone H264 stream contains bytes without an Annex-B start code')
    }
    if (start !== undefined) this.acceptNal(this.pending.slice(start.index))
    this.pending = new Uint8Array()
    this.emitCurrent()
    return this.drain()
  }

  private acceptNal(nal: Uint8Array): void {
    const type = nalType(nal)
    if (type >= 2 && type <= 4) {
      throw new Error(`phone H264 stream uses unsupported data partition NAL type ${String(type)}`)
    }
    const primaryVcl = type === 1 || type === 5
    const beginsFollowingUnit = ACCESS_UNIT_PREFIX_TYPES.has(type)
    if (this.currentHasVcl && beginsFollowingUnit) this.emitCurrent()
    if (primaryVcl) {
      const picture = parsePrimaryPicture(nal, this.ppsById, this.spsById)
      if (this.currentPicture !== undefined && isFollowingPrimaryPicture(this.currentPicture, picture)) {
        this.emitCurrent()
      } else if (this.currentPicture !== undefined && picture.firstMacroblock !== 0
        && isFollowingPrimaryPicture(this.currentPicture, { ...picture, firstMacroblock: 0 })) {
        throw new Error('phone H264 picture identity changes after its first slice')
      }
      if (this.currentPicture === undefined && picture.firstMacroblock !== 0) {
        throw new Error('phone H264 picture starts after its first macroblock')
      }
      this.currentPicture ??= picture
    }
    this.current.push(nal)
    if (primaryVcl) {
      this.currentHasVcl = true
      if (type === 5) this.currentKey = true
    }
    if (type === 7) {
      this.currentCodec = codecOfSps(nal)
      const sps = parseSps(nal)
      this.spsById.set(sps.id, sps)
    }
    if (type === 8) {
      const pps = parsePps(nal)
      this.ppsById.set(pps.id, pps)
    }
    if (type === 10 || type === 11) this.emitCurrent()
  }

  private emitCurrent(): void {
    if (this.currentHasVcl) {
      const unit: AnnexBAccessUnit = {
        data: concatenate(this.current),
        key: this.currentKey,
        ...(this.currentCodec === undefined ? {} : { codec: this.currentCodec }),
      }
      this.ready.push(unit)
    }
    this.current = []
    this.currentHasVcl = false
    this.currentPicture = undefined
    this.currentKey = false
    this.currentCodec = undefined
  }

  private drain(): AnnexBAccessUnit[] {
    return this.ready.splice(0)
  }
}

/**
 * Fetch and decode one signed Annex-B H264 stream into a canvas.
 * The module owns access-unit parsing, decoder backpressure, frame release,
 * and cancellation; the caller owns the canvas and closes the returned handle.
 * @param options - signed URL, canvas, and lifecycle callbacks.
 * @returns the idempotent playback handle.
 */
export function playPhoneH264Stream(options: PhoneH264PlaybackOptions): PhoneH264Playback {
  const abort = new AbortController()
  let closed = false
  let failed = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let decoder: VideoDecoder | undefined
  let decoderDequeueListener: (() => void) | undefined
  let resolveQueueDrain: (() => void) | undefined
  let stopPromise: Promise<void> | undefined
  let settlePromise: Promise<void> | undefined
  let paintedFrames = 0
  let surface: { width: number; height: number } | undefined
  const isStopped = (): boolean => closed || failed

  const wakeQueueDrain = (): void => {
    const resolve = resolveQueueDrain
    resolveQueueDrain = undefined
    resolve?.()
  }

  const closeDecoder = (): void => {
    wakeQueueDrain()
    if (decoder !== undefined && decoderDequeueListener !== undefined) {
      decoder.removeEventListener('dequeue', decoderDequeueListener)
    }
    decoderDequeueListener = undefined
    if (decoder?.state !== 'closed') decoder?.close()
    decoder = undefined
  }

  const stopResources = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise
    abort.abort()
    const activeReader = reader
    reader = undefined
    closeDecoder()
    stopPromise = activeReader?.cancel().catch(() => {
      // Reader cancellation failures are contained after the stream is no longer publishable.
    }) ?? Promise.resolve()
    return stopPromise
  }

  const fail = (error: unknown): void => {
    if (closed || failed) return
    failed = true
    void stopResources()
    try {
      options.onError(error)
    } catch {
      // Consumer notification failures cannot escape the playback lifecycle.
    }
  }

  const paint = (frame: VideoFrame): void => {
    try {
      if (isStopped()) return
      const width = frame.displayWidth
      const height = frame.displayHeight
      if (width <= 0 || height <= 0) throw new Error('phone H264 decoder produced an empty frame')
      const context = options.canvas.getContext('2d')
      if (context === null) throw new Error('phone H264 canvas has no 2D context')
      if (options.canvas.width !== width) options.canvas.width = width
      if (options.canvas.height !== height) options.canvas.height = height
      context.drawImage(frame, 0, 0, width, height)
      paintedFrames += 1
      if (surface?.width !== width || surface.height !== height) {
        surface = { width, height }
        options.onSurface(width, height)
      }
    } catch (error) {
      fail(error)
    } finally {
      frame.close()
    }
  }

  const run = async (): Promise<void> => {
    if (!globalThis.isSecureContext) throw new Error('phone H264 playback requires a secure context')
    if (typeof VideoDecoder !== 'function') throw new Error('WebCodecs VideoDecoder is unavailable')
    const response = await fetch(options.url, { signal: abort.signal })
    if (!response.ok) throw new Error(`phone H264 fetch failed with HTTP ${String(response.status)}`)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'video/h264') throw new Error(`phone H264 fetch returned ${contentType ?? 'no content type'}`)
    if (response.body === null) throw new Error('phone H264 fetch returned no response body')
    if (closed) return
    const streamReader = response.body.getReader()
    reader = streamReader
    const assembler = new AnnexBAccessUnitAssembler()
    let configured = false
    let timestamp = 0
    const codec = new VideoDecoder({ output: paint, error: fail })
    decoder = codec
    decoderDequeueListener = wakeQueueDrain
    codec.addEventListener('dequeue', decoderDequeueListener)

    const waitForCapacity = async (): Promise<void> => {
      while (!isStopped() && codec.decodeQueueSize >= MAX_DECODE_QUEUE) {
        await new Promise<void>((resolve) => { resolveQueueDrain = resolve })
      }
    }

    const decode = async (units: readonly AnnexBAccessUnit[]): Promise<void> => {
      for (const unit of units) {
        if (!configured) {
          if (unit.codec === undefined) throw new Error('phone H264 stream starts without an SPS')
          const config: VideoDecoderConfig = { codec: unit.codec, optimizeForLatency: true }
          const support = await VideoDecoder.isConfigSupported(config)
          if (isStopped()) return
          if (!support.supported) throw new Error(`WebCodecs does not support ${unit.codec}`)
          codec.configure(config)
          configured = true
        }
        await waitForCapacity()
        if (isStopped()) return
        codec.decode(new EncodedVideoChunk({
          type: unit.key ? 'key' : 'delta',
          timestamp,
          data: unit.data,
        }))
        timestamp += 1
      }
    }

    while (!isStopped()) {
      const read = await streamReader.read()
      if (read.done) break
      await decode(assembler.push(read.value))
    }
    if (isStopped()) return
    await decode(assembler.finish())
    if (codec.state === 'configured') await codec.flush()
    if (isStopped()) return
    if (paintedFrames === 0) throw new Error('phone H264 stream ended before a frame was decoded')
    reader = undefined
    streamReader.releaseLock()
    closeDecoder()
  }

  const runPromise = run().catch((error: unknown) => {
    if (closed) return
    fail(error)
  })
  const handle: PhoneH264Playback = {
    close(): Promise<void> {
      if (!closed) closed = true
      const stopping = stopResources()
      settlePromise ??= Promise.all([runPromise, stopping]).then(() => undefined)
      return settlePromise
    },
  }
  return handle
}
