// @vitest-environment jsdom
/** H264 playback through the browser fetch, WebCodecs, and canvas interfaces. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playPhoneH264Stream } from '../src/client/phone-h264-playback.ts'

const START = [0, 0, 0, 1] as const

function nal(header: number, ...rbsp: number[]): Uint8Array {
  return Uint8Array.from([...START, header, ...rbsp])
}

function nal3(header: number, ...rbsp: number[]): Uint8Array {
  return Uint8Array.from([0, 0, 1, header, ...rbsp])
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
  closeCount = 0

  constructor(width = 390, height = 844) {
    this.codedWidth = width
    this.codedHeight = height
    this.displayWidth = width
    this.displayHeight = height
  }

  close(): void { this.closeCount += 1 }
}

class FakeVideoDecoder {
  static readonly instances: FakeVideoDecoder[] = []
  static failFlush = false
  static failDecode = false
  static supported = true
  static closeBeforeFlushError = false
  static frameSizes: ReadonlyArray<{ readonly width: number; readonly height: number }> = []
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
      const frame = new FakeVideoFrame(size?.width, size?.height)
      this.frames.push(frame)
      this.init.output(frame)
    }
    this.decodeQueueSize = 0
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

afterEach(() => {
  FakeVideoDecoder.instances.length = 0
  FakeVideoDecoder.failFlush = false
  FakeVideoDecoder.failDecode = false
  FakeVideoDecoder.supported = true
  FakeVideoDecoder.closeBeforeFlushError = false
  FakeVideoDecoder.frameSizes = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('playPhoneH264Stream', () => {
  it('assembles Annex-B access units, paints their frames, and closes every frame', async () => {
    const sps = nal(0x67, 0x42, 0xc0, 0x1f, 0x80)
    const pps = nal(0x68, 0x80)
    const firstIdr = nal(0x65, 0x80)
    const secondIdr = nal(0x65, 0x80)
    const payload = concat(sps, pps, firstIdr, secondIdr)
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
    expect(Array.from(decoder.chunks[1]!.data)).toEqual(Array.from(secondIdr))
    expect(surfaces).toEqual([{ width: 390, height: 844 }])
    expect(canvas.width).toBe(390)
    expect(canvas.height).toBe(844)
    expect(decoder.frames.every(frame => frame.closeCount === 1)).toBe(true)
    expect(errors).toEqual([])
    playback.close()
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
      sps, pps, firstSlice, secondSlice, nextPicture,
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
    expect(Array.from(chunks[1]!.data)).toEqual(Array.from(nextPicture))
    expect(errors).toEqual([])
  })

  it('flushes decoder pressure before accepting an unbounded input queue', async () => {
    const units = [
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80),
      nal(0x68, 0x80),
      nal(0x65, 0x80),
      nal(0x65, 0x80),
      nal(0x65, 0x80),
      nal(0x65, 0x80),
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

    await vi.waitFor(() => { expect(FakeVideoDecoder.instances[0]?.frames).toHaveLength(4) })
    expect(FakeVideoDecoder.instances[0]!.flushCount).toBe(2)
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
    playback.close()
    playback.close()

    await vi.waitFor(() => { expect(cancelCount).toBe(1) })
    expect(fetchSignal?.aborted).toBe(true)
    expect(FakeVideoDecoder.instances[0]!.closeCount).toBe(1)
    expect(errors).toEqual([])
  })

  it('closes a frame and reports one failure when canvas drawing throws', async () => {
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(concat(
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80),
      nal(0x65, 0x80), nal(0x65, 0x80), nal(0x65, 0x80), nal(0x65, 0x80),
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
      nal(0x67, 0x42, 0xc0, 0x1f, 0x80), nal(0x68, 0x80), nal(0x65, 0x80), nal(0x65, 0x80),
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
    }
  })

  it('accepts a parameterized H264 MIME and three-byte Annex-B start codes', async () => {
    const payload = concat(
      nal3(0x67, 0x42, 0xc0, 0x1f, 0x80),
      nal3(0x68, 0x80),
      nal3(0x65, 0x80, 0, 0, 3, 1),
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
        message: 'phone H264 stream starts without an SPS',
      },
      {
        payload: new Uint8Array(),
        message: 'phone H264 stream ended before a frame was decoded',
      },
    ]
    for (const testCase of cases) {
      const error = await reportedError(streamResponse(testCase.payload))
      expect(error).toEqual(new Error(testCase.message))
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it('rejects a codec profile that the browser does not support', async () => {
    FakeVideoDecoder.supported = false
    const error = await reportedError(streamResponse(concat(
      nal(0x67, 0x64, 0, 0x2a, 0x80), nal(0x68, 0x80), nal(0x65, 0x80),
    )))
    expect(error).toEqual(new Error('WebCodecs does not support avc1.64002a'))
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
      nal(0x65, 0x80), nal(0x65, 0x80), nal(0x65, 0x80),
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

    playback.close()
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
    playback.close()
    resolveFetch?.(streamResponse())
    await new Promise((resolve) => { setTimeout(resolve, 0) })
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
    playback.close()
    rejectFetch?.(new DOMException('caller aborted', 'AbortError'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
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
    playback.close()
    resolveSupport?.({ supported: true, config: { codec: 'avc1.42c01f' } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(FakeVideoDecoder.instances[0]!.chunks).toEqual([])
    expect(FakeVideoDecoder.instances[0]!.closeCount).toBe(1)
  })
})
