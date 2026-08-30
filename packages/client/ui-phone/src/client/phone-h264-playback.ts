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
  /** Abort fetch and release the decoder; repeated calls do nothing. */
  close(): void
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

function firstMacroblockOf(nal: Uint8Array): number {
  const rbsp = rbspOf(nal)
  let bitOffset = 0
  const readBit = (): number => {
    const byte = rbsp.at(bitOffset >> 3)
    if (byte === undefined) throw new Error('phone H264 stream contains a truncated slice header')
    const bit = (byte >> (7 - (bitOffset & 7))) & 1
    bitOffset += 1
    return bit
  }
  let zeroCount = 0
  while (readBit() === 0) {
    zeroCount += 1
    if (zeroCount > 31) throw new Error('phone H264 stream contains an invalid slice header')
  }
  let value = 1
  for (let index = 0; index < zeroCount; index += 1) value = value * 2 + readBit()
  return value - 1
}

class AnnexBAccessUnitAssembler {
  private pending = new Uint8Array()
  private current: Uint8Array[] = []
  private currentHasVcl = false
  private currentKey = false
  private currentCodec: string | undefined
  private readonly ready: AnnexBAccessUnit[] = []

  push(bytes: Uint8Array): AnnexBAccessUnit[] {
    this.pending = append(this.pending, bytes)
    const starts = startCodesIn(this.pending)
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
    if (start !== undefined) this.acceptNal(this.pending.slice(start.index))
    this.pending = new Uint8Array()
    this.emitCurrent()
    return this.drain()
  }

  private acceptNal(nal: Uint8Array): void {
    const type = nalType(nal)
    const vcl = type >= 1 && type <= 5
    const beginsPicture = vcl && firstMacroblockOf(nal) === 0
    const beginsFollowingUnit = ACCESS_UNIT_PREFIX_TYPES.has(type)
    if (this.currentHasVcl && (beginsPicture || beginsFollowingUnit)) this.emitCurrent()
    this.current.push(nal)
    if (vcl) {
      this.currentHasVcl = true
      if (type === 5) this.currentKey = true
    }
    if (type === 7) this.currentCodec = codecOfSps(nal)
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
  let paintedFrames = 0
  let surface: { width: number; height: number } | undefined
  const isStopped = (): boolean => closed || failed

  const closeDecoder = (): void => {
    if (decoder?.state !== 'closed') decoder?.close()
    decoder = undefined
  }

  const stopResources = (): void => {
    abort.abort()
    void reader?.cancel().catch(() => undefined)
    reader = undefined
    closeDecoder()
  }

  const fail = (error: unknown): void => {
    if (closed || failed) return
    failed = true
    stopResources()
    options.onError(error)
  }

  const handle: PhoneH264Playback = {
    close(): void {
      if (closed) return
      closed = true
      stopResources()
    },
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
    if (typeof VideoDecoder !== 'function') throw new Error('WebCodecs VideoDecoder is unavailable')
    const response = await fetch(options.url, { signal: abort.signal })
    if (!response.ok) throw new Error(`phone H264 fetch failed with HTTP ${String(response.status)}`)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'video/h264') throw new Error(`phone H264 fetch returned ${contentType ?? 'no content type'}`)
    if (response.body === null) throw new Error('phone H264 fetch returned no response body')
    if (closed) return
    reader = response.body.getReader()
    const assembler = new AnnexBAccessUnitAssembler()
    let configured = false
    let timestamp = 0
    const codec = new VideoDecoder({ output: paint, error: fail })
    decoder = codec

    const decode = async (units: readonly AnnexBAccessUnit[]): Promise<void> => {
      for (const unit of units) {
        if (isStopped()) return
        if (!configured) {
          if (unit.codec === undefined) throw new Error('phone H264 stream starts without an SPS')
          const config: VideoDecoderConfig = { codec: unit.codec, optimizeForLatency: true }
          const support = await VideoDecoder.isConfigSupported(config)
          if (isStopped()) return
          if (!support.supported) throw new Error(`WebCodecs does not support ${unit.codec}`)
          codec.configure(config)
          configured = true
        }
        if (codec.decodeQueueSize >= MAX_DECODE_QUEUE) await codec.flush()
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
      const read = await reader.read()
      if (read.done) break
      await decode(assembler.push(read.value))
    }
    if (isStopped()) return
    await decode(assembler.finish())
    if (codec.state === 'configured') await codec.flush()
    if (isStopped()) return
    if (paintedFrames === 0) throw new Error('phone H264 stream ended before a frame was decoded')
    closeDecoder()
  }

  void run().catch((error: unknown) => {
    if (closed) return
    fail(error)
  })
  return handle
}
