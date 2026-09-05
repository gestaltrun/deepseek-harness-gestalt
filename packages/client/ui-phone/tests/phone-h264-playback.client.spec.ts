// @vitest-environment jsdom
/** H264 playback through the browser fetch, WebCodecs, and canvas interfaces. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playPhoneH264Stream } from '../src/client/phone-h264-playback.ts'

const START = [0, 0, 0, 1] as const

function rawNal(header: number, ...rbsp: number[]): Uint8Array {
  return Uint8Array.from([...START, header, ...rbsp])
}

function unsignedExpGolomb(value: number): number[] {
  const binary = (value + 1).toString(2)
  return [...Array.from({ length: binary.length - 1 }, () => 0), ...Array.from(binary, Number)]
}

function fixedBits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >> (width - index - 1)) & 1)
}

function rbspNal(header: number, bits: number[]): Uint8Array {
  bits.push(1)
  while ((bits.length & 7) !== 0) bits.push(0)
  const rbsp = Array.from({ length: bits.length / 8 }, (_, byte) => bits
    .slice(byte * 8, byte * 8 + 8).reduce((value, bit) => value * 2 + bit, 0))
  return rawNal(header, ...rbsp)
}

function primaryNal(
  header: number,
  firstMacroblock: number,
  idrPicId = 0,
  frameNum = 0,
  options: { readonly ppsId?: number; readonly picOrderCntLsb?: number } = {},
): Uint8Array {
  const bits = [
    ...unsignedExpGolomb(firstMacroblock),
    ...unsignedExpGolomb((header & 0x1f) === 5 ? 7 : 0),
    ...unsignedExpGolomb(options.ppsId ?? 0),
    ...fixedBits(frameNum, 4),
    ...((header & 0x1f) === 5 ? unsignedExpGolomb(idrPicId) : []),
    ...(options.picOrderCntLsb === undefined ? [] : fixedBits(options.picOrderCntLsb, 4)),
  ]
  return rbspNal(header, bits)
}

function configuredSps(options: {
  readonly profile?: number
  readonly chromaFormat?: number
  readonly scalingMatrices?: boolean
  readonly picOrderCntType?: number
  readonly frameMbsOnly?: boolean
} = {}): Uint8Array {
  const profile = options.profile ?? 66
  const bits = [
    ...fixedBits(profile, 8), ...fixedBits(0, 8), ...fixedBits(31, 8),
    ...unsignedExpGolomb(0),
  ]
  if (profile === 100) {
    bits.push(
      ...unsignedExpGolomb(options.chromaFormat ?? 1),
      ...unsignedExpGolomb(0),
      ...unsignedExpGolomb(0),
      0,
      options.scalingMatrices === true ? 1 : 0,
    )
  }
  const picOrderCntType = options.picOrderCntType ?? 2
  bits.push(...unsignedExpGolomb(0), ...unsignedExpGolomb(picOrderCntType))
  if (picOrderCntType === 0) bits.push(...unsignedExpGolomb(0))
  bits.push(
    ...unsignedExpGolomb(1),
    0,
    ...unsignedExpGolomb(1),
    ...unsignedExpGolomb(1),
    options.frameMbsOnly === false ? 0 : 1,
  )
  return rbspNal(0x67, bits)
}

function configuredPps(options: { readonly id?: number; readonly bottomFieldOrder?: boolean } = {}): Uint8Array {
  return rbspNal(0x68, [
    ...unsignedExpGolomb(options.id ?? 0),
    ...unsignedExpGolomb(0),
    0,
    options.bottomFieldOrder === true ? 1 : 0,
  ])
}

function nal(header: number, ...rbsp: number[]): Uint8Array {
  if (header === 0x67 && rbsp.join(',') === '66,192,31,128') {
    return Uint8Array.from([...START, 103, 66, 192, 31, 218, 6, 65, 175, 154, 208])
  }
  if (header === 0x68 && rbsp.join(',') === '128') {
    return Uint8Array.from([...START, 104, 206, 56, 128])
  }
  if (((header & 0x1f) === 1 || (header & 0x1f) === 5) && rbsp.join(',') === '128') {
    return primaryNal(header, 0)
  }
  if (((header & 0x1f) === 1 || (header & 0x1f) === 5) && rbsp.join(',') === '64') {
    return primaryNal(header, 1)
  }
  return rawNal(header, ...rbsp)
}

function nal3(header: number, ...rbsp: number[]): Uint8Array {
  return Uint8Array.from([0, 0, 1, ...nal(header, ...rbsp).subarray(4)])
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

class FakeEncodedVideoChunk {
  readonly type: EncodedVideoChunkType
  readonly timestamp: number
  readonly data: Uint8Array

  constructor(init: EncodedVideoChunkInit) {
    this.type = init.type
    this.timestamp = init.timestamp
    this.data = ArrayBuffer.isView(init.data)
      ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength).slice()
      : new Uint8Array(init.data).slice()
  }
}

class FakeVideoFrame {
  readonly codedWidth: number
  readonly codedHeight: number
  readonly displayWidth: number
  readonly displayHeight: number
  readonly rotation?: number
  closeCount = 0

  constructor(width = 390, height = 844, rotation?: number) {
    this.codedWidth = width
    this.codedHeight = height
    this.displayWidth = width
    this.displayHeight = height
    if (rotation !== undefined) this.rotation = rotation
  }

  close(): void { this.closeCount += 1 }
}

class FakeVideoDecoder extends EventTarget {
  static readonly instances: FakeVideoDecoder[] = []
  static failFlush = false
  static failDecode = false
  static supported = true
  static closeBeforeFlushError = false
  static autoDequeue = true
  static frameSizes: ReadonlyArray<{
    readonly width: number
    readonly height: number
    readonly rotation?: number
  }> = []
  static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
    return { supported: FakeVideoDecoder.supported, config }
  }

  readonly chunks: FakeEncodedVideoChunk[] = []
  readonly frames: FakeVideoFrame[] = []
  readonly init: { output: (frame: FakeVideoFrame) => void; error: (error: DOMException) => void }
  config: VideoDecoderConfig | undefined
  decodeQueueSize = 0
  state: CodecState = 'unconfigured'
  closeCount = 0
  flushCount = 0

  constructor(init: { output: (frame: FakeVideoFrame) => void; error: (error: DOMException) => void }) {
    super()
    this.init = init
    FakeVideoDecoder.instances.push(this)
  }

  configure(config: VideoDecoderConfig): void {
    this.config = config
    this.state = 'configured'
  }

  decode(chunk: FakeEncodedVideoChunk): void {
    this.chunks.push(chunk)
    this.decodeQueueSize += 1
    if (FakeVideoDecoder.failDecode) this.init.error(new DOMException('decode failed', 'EncodingError'))
    if (FakeVideoDecoder.autoDequeue) queueMicrotask(() => { this.releaseQueue() })
  }

  releaseQueue(): void {
    if (this.state === 'closed') return
    this.decodeQueueSize = 0
    this.dispatchEvent(new Event('dequeue'))
  }

  async flush(): Promise<void> {
    this.flushCount += 1
    if (FakeVideoDecoder.failFlush) {
      const error = new DOMException('decoder rejected the access unit', 'EncodingError')
      if (FakeVideoDecoder.closeBeforeFlushError) this.state = 'closed'
      this.init.error(error)
      throw error
    }
    while (this.frames.length < this.chunks.length) {
      const size = FakeVideoDecoder.frameSizes[this.frames.length]
      const frame = new FakeVideoFrame(size?.width, size?.height, size?.rotation)
      this.frames.push(frame)
      this.init.output(frame)
    }
    this.releaseQueue()
  }

  close(): void {
    this.closeCount += 1
    this.state = 'closed'
  }
}

function streamResponse(...chunks: readonly Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'video/h264' } })
}

async function reportedError(response: Response): Promise<unknown> {
  vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
  vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const canvas = document.createElement('canvas')
  vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
  const errors: unknown[] = []
  playPhoneH264Stream({
    url: '/phone/stream/device/h264?token=test',
    canvas,
    onSurface: () => {},
    onError: (error) => { errors.push(error) },
  })
  await vi.waitFor(() => { expect(errors).toHaveLength(1) })
  return errors[0]
}

beforeEach(() => { vi.stubGlobal('isSecureContext', true) })

afterEach(() => {
  FakeVideoDecoder.instances.length = 0
  FakeVideoDecoder.failFlush = false
  FakeVideoDecoder.failDecode = false
  FakeVideoDecoder.supported = true
  FakeVideoDecoder.closeBeforeFlushError = false
  FakeVideoDecoder.autoDequeue = true
  FakeVideoDecoder.frameSizes = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('playPhoneH264Stream', () => {
  it('rejects bytes before the first Annex-B start code', async () => {
    const error = await reportedError(streamResponse(concat(
      Uint8Array.of(1),
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80),
      nal(0x68, 0x80),
    )))
    expect(error).toEqual(expect.objectContaining({
      message: 'phone H264 stream contains bytes without an Annex-B start code',
    }))
  })

  it('assembles Annex-B access units, paints their frames, and closes every frame', async () => {
    const sps = nal(0x67, 0x42, 0xc0, 0x1f, 0x80)
    const pps = nal(0x68, 0x80)
    const firstIdr = nal(0x65, 0x80)
    const secondIdr = nal(0x65, 0x80)
    const aud = nal(0x09, 0xf0)
    const payload = concat(Uint8Array.of(0, 0, 0), sps, pps, firstIdr, aud, secondIdr)
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(
      payload.subarray(0, 2),
      payload.subarray(2, 17),
      payload.subarray(17),
    )))
    const canvas = document.createElement('canvas')
    const drawImage = vi.fn()
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as never)
    const surfaces: Array<{ width: number; height: number }> = []
    const errors: unknown[] = []

    const playback = playPhoneH264Stream({
      url: '/phone/stream/emulator-5554/h264?token=test',
      canvas,
      onSurface: (width, height) => { surfaces.push({ width, height }) },
      onError: (error) => { errors.push(error) },
    })

    await vi.waitFor(() => { expect(drawImage).toHaveBeenCalledTimes(2) })
    const decoder = FakeVideoDecoder.instances[0]!
    expect(decoder.config).toMatchObject({ codec: 'avc1.42c01f', optimizeForLatency: true })
    expect(decoder.chunks.map(chunk => ({ type: chunk.type, timestamp: chunk.timestamp }))).toEqual([
      { type: 'key', timestamp: 0 },
      { type: 'key', timestamp: 1 },
    ])
    expect(Array.from(decoder.chunks[0]!.data)).toEqual(Array.from(concat(sps, pps, firstIdr)))
    expect(Array.from(decoder.chunks[1]!.data)).toEqual(Array.from(concat(aud, secondIdr)))
    expect(surfaces).toEqual([{ width: 390, height: 844 }])
    expect(canvas.width).toBe(390)
    expect(canvas.height).toBe(844)
    expect(decoder.frames.every(frame => frame.closeCount === 1)).toBe(true)
    expect(errors).toEqual([])
    await playback.close()
    expect(decoder.closeCount).toBe(1)
  })

  it('keeps every slice of one picture in the same access unit', async () => {
    const sps = nal(0x67, 0x42, 0xc0, 0x1f, 0x80)
    const pps = nal(0x68, 0x80)
    const firstSlice = nal(0x61, 0x80)
    const secondSlice = nal(0x61, 0x40)
    const nextPicture = nal(0x61, 0x80)
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      sps, pps, firstSlice, secondSlice, nal(0x09, 0xf0), nextPicture,
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    const errors: unknown[] = []

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })

    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.chunks).toHaveLength(2) })
    const chunks = FakeVideoDecoder.instances[0]!.chunks
    expect(chunks.map(chunk => chunk.type)).toEqual(['delta', 'delta'])
    expect(Array.from(chunks[0]!.data)).toEqual(Array.from(concat(sps, pps, firstSlice, secondSlice)))
    expect(Array.from(chunks[1]!.data)).toEqual(Array.from(concat(nal(0x09, 0xf0), nextPicture)))
    expect(errors).toEqual([])
  })

  it('separates primary pictures without AUD from their slice-header identity', async () => {
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80),
      nal(0x68, 0x80),
      primaryNal(0x65, 0, 0),
      primaryNal(0x65, 0, 1),
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: () => {},
    })
    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.chunks).toHaveLength(2) })
  })

  it('rejects data-partitioned slices instead of parsing partition B or C as slice headers', async () => {
    for (const type of [2, 3, 4]) {
      const error = await reportedError(streamResponse(concat(
        nal(0x67, 0x42, 0xc0, 0x1f, 0x80),
        nal(0x68, 0x80),
        nal(0x60 | type, 0x80),
      )))
      expect(error).toEqual(new Error(`phone H264 stream uses unsupported data partition NAL type ${String(type)}`))
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.stubGlobal('isSecureContext', true)
    }
  })

  it('rejects a primary-picture identity change after the first slice', async () => {
    const error = await reportedError(streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80),
      nal(0x68, 0x80),
      primaryNal(0x41, 0, 0, 0),
      primaryNal(0x41, 1, 0, 1),
    )))
    expect(error).toEqual(new Error('phone H264 picture identity changes after its first slice'))
  })

  it('associates parameter sets after a picture with the following AUD-delimited picture', async () => {
    const sps = nal(0x67, 0x42, 0xc0, 0x1f, 0x80)
    const pps = nal(0x68, 0x80)
    const idr = nal(0x65, 0x80)
    const nextSps = nal(0x67, 0x42, 0xc0, 0x1f, 0x80)
    const nextPps = nal(0x68, 0x80)
    const aud = nal(0x09, 0xf0)
    const delta = nal(0x41, 0x80)
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      sps, pps, idr, nextSps, nextPps, aud, delta,
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: () => {},
    })

    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.chunks).toHaveLength(2) })
    expect(Array.from(FakeVideoDecoder.instances[0]!.chunks[1]!.data))
      .toEqual(Array.from(concat(nextSps, nextPps, aud, delta)))
    expect(FakeVideoDecoder.instances[0]!.chunks.map(chunk => chunk.type)).toEqual(['key', 'delta'])
  })

  it('uses high-profile POC and zero-reference identity fields to split pictures', async () => {
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      configuredSps({ profile: 100, picOrderCntType: 0 }),
      configuredPps(),
      primaryNal(0x65, 0, 0, 0, { picOrderCntLsb: 0 }),
      primaryNal(0x01, 0, 0, 1, { picOrderCntLsb: 1 }),
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: () => {},
    })
    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.chunks).toHaveLength(2) })
    expect(FakeVideoDecoder.instances[0]!.config?.codec).toBe('avc1.64001f')
    expect(FakeVideoDecoder.instances[0]!.chunks.map(chunk => chunk.type)).toEqual(['key', 'delta'])
  })

  it('waits for decoder dequeue before feeding delta pressure and flushes only at EOF', async () => {
    FakeVideoDecoder.autoDequeue = false
    const units = [
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
      nal(0x09, 0xf0), nal(0x41, 0x80),
      nal(0x09, 0xf0), nal(0x41, 0x80),
      nal(0x09, 0xf0), nal(0x41, 0x80),
    ]
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(...units))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: () => {},
    })

    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.chunks).toHaveLength(2) })
    const decoder = FakeVideoDecoder.instances[0]!
    expect(decoder.flushCount).toBe(0)
    decoder.releaseQueue()
    await vi.waitFor(() => { expect(decoder.frames).toHaveLength(4) })
    expect(decoder.chunks.map(chunk => chunk.type)).toEqual(['key', 'delta', 'delta', 'delta'])
    expect(decoder.flushCount).toBe(1)
  })

  it('wakes a decoder-capacity wait during close without admitting another chunk', async () => {
    FakeVideoDecoder.autoDequeue = false
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
      nal(0x09, 0xf0), nal(0x41, 0x80), nal(0x09, 0xf0), nal(0x41, 0x80),
    ))))
    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: () => {},
    })
    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.chunks).toHaveLength(2) })
    await playback.close()
    expect(FakeVideoDecoder.instances[0]!.chunks).toHaveLength(2)
  })

  it('aborts the reader and closes the decoder without reporting cancellation as failure', async () => {
    let fetchSignal: AbortSignal | undefined
    let cancelCount = 0
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelCount += 1
        return Promise.reject(new Error('reader cancellation failed'))
      },
    })
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined
      return new Response(body, { status: 200, headers: { 'content-type': 'video/h264' } })
    }))
    const canvas = document.createElement('canvas')
    const errors: unknown[] = []

    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    await vi.waitFor(() => { expect(FakeVideoDecoder.instances).toHaveLength(1) })
    const firstClose = playback.close()
    const secondClose = playback.close()

    await vi.waitFor(() => { expect(cancelCount).toBe(1) })
    await Promise.all([firstClose, secondClose])
    expect(fetchSignal?.aborted).toBe(true)
    expect(FakeVideoDecoder.instances[0]!.closeCount).toBe(1)
    expect(errors).toEqual([])
  })

  it('settles close only after reader cancellation and the decode run are quiescent', async () => {
    let releaseCancel: (() => void) | undefined
    const cancellation = new Promise<void>((resolve) => { releaseCancel = resolve })
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel: () => cancellation,
    })
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'video/h264' },
    })))
    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: () => {},
    })
    await vi.waitFor(() => { expect(FakeVideoDecoder.instances).toHaveLength(1) })

    let settled = false
    const closing = playback.close().then(() => { settled = true })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(settled).toBe(false)
    releaseCancel?.()
    await closing
    expect(settled).toBe(true)
    expect(FakeVideoDecoder.instances[0]!.closeCount).toBe(1)
  })

  it('closes a frame and reports one failure when canvas drawing throws', async () => {
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80),
      nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80),
      nal(0x09, 0xf0), nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80),
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      drawImage: () => { throw new Error('canvas lost') },
    } as never)
    const errors: unknown[] = []

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })

    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(errors[0]).toEqual(new Error('canvas lost'))
    expect(FakeVideoDecoder.instances[0]!.frames[0]!.closeCount).toBe(1)
    expect(FakeVideoDecoder.instances[0]!.closeCount).toBe(1)
  })

  it('stops queued access units after a synchronous decoder callback failure', async () => {
    FakeVideoDecoder.failDecode = true
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80),
      nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80),
    ))))
    const errors: unknown[] = []
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(FakeVideoDecoder.instances[0]!.chunks).toHaveLength(1)
  })

  it('reports a decoder error once and releases the failed decoder', async () => {
    FakeVideoDecoder.failFlush = true
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
    ))))
    const errors: unknown[] = []

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })

    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(errors[0]).toBeInstanceOf(DOMException)
    expect(FakeVideoDecoder.instances[0]!.closeCount).toBe(1)
  })

  it('fails when WebCodecs is unavailable before issuing a fetch', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('VideoDecoder', undefined)
    vi.stubGlobal('fetch', fetchStub)
    const errors: unknown[] = []
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(errors[0]).toEqual(new Error('WebCodecs VideoDecoder is unavailable'))
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('fails before fetch outside a secure context', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', fetchStub)
    const errors: unknown[] = []
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(errors[0]).toEqual(new Error('phone H264 playback requires a secure context'))
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('contains a surface observer exception while decoded frames continue', async () => {
    FakeVideoDecoder.frameSizes = [{ width: 390, height: 844 }, { width: 400, height: 800 }]
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80),
      nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80),
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    const errors: unknown[] = []
    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test', canvas,
      onSurface: () => { throw new Error('surface consumer failed') },
      onError: error => errors.push(error),
    })
    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.frames).toHaveLength(2) })
    expect(errors).toEqual([])
    await expect(playback.close()).resolves.toBeUndefined()
    expect(FakeVideoDecoder.instances[0]).toBeDefined()
  })

  it('reports an unsolicited fetch AbortError as a playback failure', async () => {
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('network aborted', 'AbortError') }))
    const errors: unknown[] = []
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(errors[0]).toMatchObject({ name: 'AbortError', message: 'network aborted' })
  })

  it('rejects HTTP, MIME, missing MIME, and missing-body responses', async () => {
    const cases: ReadonlyArray<{ readonly response: Response; readonly message: string }> = [
      {
        response: new Response('', { status: 403, headers: { 'content-type': 'video/h264' } }),
        message: 'phone H264 fetch failed with HTTP 403',
      },
      {
        response: new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }),
        message: 'phone H264 fetch returned text/plain',
      },
      {
        response: {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
        } as Response,
        message: 'phone H264 fetch returned no content type',
      },
      {
        response: {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'video/h264' }),
          body: null,
        } as Response,
        message: 'phone H264 fetch returned no response body',
      },
    ]
    for (const testCase of cases) {
      const error = await reportedError(testCase.response)
      expect(error).toEqual(new Error(testCase.message))
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.stubGlobal('isSecureContext', true)
    }
  })

  it('accepts a parameterized H264 MIME and three-byte Annex-B start codes', async () => {
    const idr = primaryNal(0x65, 0)
    const payload = concat(
      nal3(0x67, 0x42, 0xc0, 0x1f, 0x80),
      nal3(0x68, 0x80),
      Uint8Array.from([0, 0, 1, ...idr.subarray(4), 0, 0, 3, 1]),
    )
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from(payload).buffer, {
      status: 200,
      headers: { 'content-type': 'Video/H264; charset=binary' },
    })))
    const canvas = document.createElement('canvas')
    const drawImage = vi.fn()
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as never)

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: () => {},
    })

    await vi.waitFor(() => { expect(drawImage).toHaveBeenCalledOnce() })
    expect(FakeVideoDecoder.instances[0]!.chunks).toHaveLength(1)
  })

  it('rejects malformed Annex-B, SPS, and slice inputs at the network boundary', async () => {
    const sps = nal(0x67, 0x42, 0xc0, 0x1f, 0x80)
    const pps = nal(0x68, 0x80)
    const cases: ReadonlyArray<{ readonly payload: Uint8Array; readonly message: string }> = [
      {
        payload: Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1]),
        message: 'phone H264 stream contains a NAL without an Annex-B start code',
      },
      {
        payload: concat(nal(0x67, 0x42), nal(0x65, 0x80)),
        message: 'phone H264 stream contains a truncated SPS',
      },
      {
        payload: concat(sps, pps, nal(0x65), nal(0x09, 0xf0)),
        message: 'phone H264 stream contains a truncated slice header',
      },
      {
        payload: concat(sps, pps, nal(0x65, 0, 0, 0, 0, 0x80), nal(0x09, 0xf0)),
        message: 'phone H264 stream contains an invalid slice header',
      },
      {
        payload: concat(pps, nal(0x65, 0x80)),
        message: 'phone H264 PPS references unknown SPS 0',
      },
      {
        payload: new Uint8Array(),
        message: 'phone H264 stream ended before a frame was decoded',
      },
      {
        payload: new TextEncoder().encode('Error: Error 0x80001001'),
        message: 'phone H264 stream contains bytes without an Annex-B start code',
      },
    ]
    for (const testCase of cases) {
      const error = await reportedError(streamResponse(testCase.payload))
      expect(error).toEqual(new Error(testCase.message))
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.stubGlobal('isSecureContext', true)
    }
  })

  it('rejects unsupported SPS and PPS coding modes explicitly', async () => {
    const cases: ReadonlyArray<{ readonly payload: Uint8Array; readonly message: string }> = [
      {
        payload: configuredSps({ profile: 100, chromaFormat: 3 }),
        message: 'phone H264 SPS uses unsupported chroma_format_idc 3',
      },
      {
        payload: configuredSps({ profile: 100, scalingMatrices: true }),
        message: 'phone H264 SPS uses unsupported scaling matrices',
      },
      {
        payload: configuredSps({ picOrderCntType: 1 }),
        message: 'phone H264 SPS uses unsupported pic_order_cnt_type 1',
      },
      {
        payload: configuredSps({ picOrderCntType: 3 }),
        message: 'phone H264 SPS uses invalid pic_order_cnt_type 3',
      },
      {
        payload: configuredSps({ frameMbsOnly: false }),
        message: 'phone H264 SPS uses unsupported interlaced pictures',
      },
      {
        payload: concat(configuredSps(), configuredPps({ bottomFieldOrder: true })),
        message: 'phone H264 PPS uses unsupported bottom-field picture order',
      },
    ]
    for (const testCase of cases) {
      const error = await reportedError(streamResponse(testCase.payload))
      expect(error).toEqual(new Error(testCase.message))
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.stubGlobal('isSecureContext', true)
    }
  })

  it('rejects missing parameter sets, missing first slices, and detached codec metadata', async () => {
    const cases: ReadonlyArray<{ readonly payload: Uint8Array; readonly message: string }> = [
      {
        payload: concat(configuredSps(), primaryNal(0x65, 0, 0, 0, { ppsId: 1 })),
        message: 'phone H264 slice references unknown PPS 1',
      },
      {
        payload: concat(configuredSps(), configuredPps(), primaryNal(0x65, 1)),
        message: 'phone H264 picture starts after its first macroblock',
      },
      {
        payload: concat(configuredSps(), configuredPps(), nal(0x0a, 0x80), primaryNal(0x65, 0)),
        message: 'phone H264 stream starts without an SPS',
      },
    ]
    for (const testCase of cases) {
      const error = await reportedError(streamResponse(testCase.payload))
      expect(error).toEqual(new Error(testCase.message))
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.stubGlobal('isSecureContext', true)
    }
  })

  it('rejects a codec profile that the browser does not support', async () => {
    FakeVideoDecoder.supported = false
    const error = await reportedError(streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
    )))
    expect(error).toEqual(new Error('WebCodecs does not support avc1.42c01f'))
  })

  it('recognizes prefix and end NALs without splitting slices from their picture', async () => {
    const sps = nal(0x67, 0x42, 0xc0, 0x1f, 0x80)
    const idr = nal(0x65, 0x80)
    const payload = concat(
      sps, nal(0x68, 0x80), idr,
      nal(0x06, 0x80), idr,
      sps, idr,
      nal(0x68, 0x80), idr,
      nal(0x09, 0xf0), idr,
      nal(0x6e, 0x80), idr,
      nal(0x0a, 0x80), nal(0x0b, 0x80),
    )
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(payload)))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: () => {},
    })

    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.frames).toHaveLength(6) })
    expect(FakeVideoDecoder.instances[0]!.chunks.every(chunk => chunk.type === 'key')).toBe(true)
  })

  it.each([
    { rotation: 90, canvasWidth: 2248, canvasHeight: 1080 },
    { rotation: 270, canvasWidth: 2248, canvasHeight: 1080 },
    { rotation: 180, canvasWidth: 1080, canvasHeight: 2248 },
    { rotation: 0, canvasWidth: 1080, canvasHeight: 2248 },
    { rotation: 45, canvasWidth: 1080, canvasHeight: 2248 },
  ])('paints rotation=$rotation at post-rotation $canvasWidth×$canvasHeight', async ({
    rotation, canvasWidth, canvasHeight,
  }) => {
    FakeVideoDecoder.frameSizes = [{ width: 1080, height: 2248, rotation }]
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
    ))))
    const canvas = document.createElement('canvas')
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
    }
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as never)
    const surfaces: Array<{ width: number; height: number }> = []
    const errors: unknown[] = []

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: (width, height) => { surfaces.push({ width, height }) },
      onError: (error) => { errors.push(error) },
    })

    await vi.waitFor(() => { expect(context.drawImage).toHaveBeenCalledOnce() })
    expect(errors).toEqual([])
    expect(surfaces).toEqual([{ width: canvasWidth, height: canvasHeight }])
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: canvasWidth, height: canvasHeight })
    expect(context.drawImage.mock.calls[0]?.[0]).toBe(FakeVideoDecoder.instances[0]!.frames[0])
    if (rotation === 0 || rotation === 45) {
      expect(context.translate).not.toHaveBeenCalled()
      expect(context.rotate).not.toHaveBeenCalled()
      expect(context.drawImage).toHaveBeenCalledWith(
        FakeVideoDecoder.instances[0]!.frames[0], 0, 0, 1080, 2248,
      )
      return
    }
    expect(context.save).toHaveBeenCalledOnce()
    expect(context.restore).toHaveBeenCalledOnce()
    expect(context.rotate).toHaveBeenCalledWith(rotation * Math.PI / 180)
    if (rotation === 90) expect(context.translate).toHaveBeenCalledWith(2248, 0)
    else if (rotation === 270) expect(context.translate).toHaveBeenCalledWith(0, 1080)
    else expect(context.translate).toHaveBeenCalledWith(1080, 2248)
    expect(context.drawImage).toHaveBeenCalledWith(
      FakeVideoDecoder.instances[0]!.frames[0], 0, 0, 1080, 2248,
    )
  })

  it('reports same-size opposite rotations but not repeated complete identities', async () => {
    FakeVideoDecoder.frameSizes = [
      { width: 390, height: 844, rotation: 0 },
      { width: 390, height: 844, rotation: 180 },
      { width: 844, height: 390, rotation: 90 },
      { width: 844, height: 390, rotation: 270 },
      { width: 844, height: 390, rotation: 270 },
    ]
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80),
      nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80), nal(0x09, 0xf0),
      nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80),
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn() } as never)
    const surfaces: string[] = []
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test', canvas,
      onSurface: (width, height, rotation) => { surfaces.push(`${String(width)}x${String(height)}@${String(rotation)}`) },
      onError: () => {},
    })
    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.frames).toHaveLength(5) })
    expect(surfaces).toEqual(['390x844@0', '390x844@180', '390x844@90', '390x844@270'])
  })

  it('reports dimension changes but not repeated dimensions', async () => {
    FakeVideoDecoder.frameSizes = [
      { width: 390, height: 844 },
      { width: 390, height: 844 },
      { width: 400, height: 800 },
    ]
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80),
      nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80), nal(0x09, 0xf0), nal(0x65, 0x80),
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    const surfaces: string[] = []

    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: (width, height) => { surfaces.push(`${String(width)}x${String(height)}`) },
      onError: () => {},
    })

    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.frames).toHaveLength(3) })
    expect(surfaces).toEqual(['390x844', '400x800'])
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 400, height: 800 })
  })

  it('rejects empty frames and a canvas without a 2D context', async () => {
    for (const size of [{ width: 0, height: 844 }, { width: 390, height: 0 }]) {
      FakeVideoDecoder.frameSizes = [size]
      const error = await reportedError(streamResponse(concat(
        nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
      )))
      expect(error).toEqual(new Error('phone H264 decoder produced an empty frame'))
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.stubGlobal('isSecureContext', true)
    }

    FakeVideoDecoder.frameSizes = []
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
    ))))
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    const errors: unknown[] = []
    playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(errors[0]).toEqual(new Error('phone H264 canvas has no 2D context'))
  })

  it('drops stale frames after close and suppresses repeated failures', async () => {
    FakeVideoDecoder.failFlush = true
    FakeVideoDecoder.closeBeforeFlushError = true
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
    ))))
    const errors: unknown[] = []
    const canvas = document.createElement('canvas')
    const drawImage = vi.fn()
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as never)
    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas,
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    const decoder = FakeVideoDecoder.instances[0]!
    decoder.init.error(new DOMException('second error', 'EncodingError'))
    const failedFrame = new FakeVideoFrame()
    decoder.init.output(failedFrame)
    expect(failedFrame.closeCount).toBe(1)
    expect(errors).toHaveLength(1)
    expect(decoder.closeCount).toBe(0)

    await playback.close()
    const closedFrame = new FakeVideoFrame()
    decoder.init.output(closedFrame)
    expect(closedFrame.closeCount).toBe(1)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('stops before decoder creation when close races the fetch', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve })))
    const errors: unknown[] = []
    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    const closing = playback.close()
    resolveFetch?.(streamResponse())
    await closing
    expect(FakeVideoDecoder.instances).toEqual([])
    expect(errors).toEqual([])
  })

  it('suppresses a fetch rejection that settles after caller cancellation', async () => {
    let rejectFetch: ((error: unknown) => void) | undefined
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject })))
    const errors: unknown[] = []
    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: (error) => { errors.push(error) },
    })
    const closing = playback.close()
    rejectFetch?.(new DOMException('caller aborted', 'AbortError'))
    await closing
    expect(errors).toEqual([])
  })

  it('stops a decoder while codec support resolution is pending', async () => {
    let resolveSupport: ((support: VideoDecoderSupport) => void) | undefined
    const support = vi.spyOn(FakeVideoDecoder, 'isConfigSupported').mockImplementation(async () => await new Promise(
      (resolve) => { resolveSupport = resolve },
    ))
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
    ))))
    const playback = playPhoneH264Stream({
      url: '/phone/stream/device/h264?token=test',
      canvas: document.createElement('canvas'),
      onSurface: () => {},
      onError: () => {},
    })
    await vi.waitFor(() => { expect(support).toHaveBeenCalledOnce() })
    const closing = playback.close()
    resolveSupport?.({ supported: true, config: { codec: 'avc1.42c01f' } })
    await closing
    expect(FakeVideoDecoder.instances[0]!.chunks).toEqual([])
    expect(FakeVideoDecoder.instances[0]!.closeCount).toBe(1)
  })
})
