import { describe, expect, it } from 'vitest'
import { verifyMjpegJpegPicture } from '../src/jpeg.ts'
import { buildGradientJpeg } from './fixtures/u3-visible-frames.ts'

function streamOf(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2
  return [0xff, marker, length >> 8, length & 0xff, ...payload]
}

const VALID_DQT = [0, ...new Array<number>(64).fill(1)]
const VALID_DHT = [
  0, 1, ...new Array<number>(15).fill(0), 0,
  0x10, 1, ...new Array<number>(15).fill(0), 0,
]
const VALID_SOF = [8, 0, 16, 0, 16, 1, 1, 0x11, 0]
const VALID_SOS = [1, 1, 0, 0, 63, 0]
const PROGRESSIVE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wgALCAAQABABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAAAAYH/9oACAEBAAAAAaJnT//EABUQAQEAAAAAAAAAAAAAAAAAAAAU/9oACAEBAAEFArFixY//xAAVEAEBAAAAAAAAAAAAAAAAAAAAMf/aAAgBAQAGPwKqqv/EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8hFV//2gAIAQEAAAAQP//EABYQAAMAAAAAAAAAAAAAAAAAAAAR8P/aAAgBAQABPxC2Wy2Wz//Z',
  'base64',
)

function structuralJpeg(options: {
  readonly dqt?: readonly number[]
  readonly dht?: readonly number[]
  readonly sof?: readonly number[]
  readonly sos?: readonly number[]
  readonly scan?: readonly number[]
} = {}): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    ...segment(0xdb, options.dqt ?? VALID_DQT),
    ...segment(0xc4, options.dht ?? VALID_DHT),
    ...segment(0xc0, options.sof ?? VALID_SOF),
    ...segment(0xda, options.sos ?? VALID_SOS),
    ...(options.scan ?? [0]),
    0xff, 0xd9,
  ])
}

describe('verifyMjpegJpegPicture', () => {
  it.each([
    ['maxBytes', { maxBytes: 0 }],
    ['minimumDimension', { maxBytes: 1024, minimumDimension: 0 }],
  ])('rejects an invalid %s ceiling', async (_field, options) => {
    await expect(verifyMjpegJpegPicture(streamOf(), {
      signal: new AbortController().signal,
      ...options,
    })).rejects.toThrow(TypeError)
  })

  it('accepts a chunk-split real JPEG inside multipart framing', async () => {
    const jpeg = buildGradientJpeg(1)
    const header = new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
    await expect(verifyMjpegJpegPicture(streamOf(
      header, jpeg.subarray(0, 11), jpeg.subarray(11, 1_001), jpeg.subarray(1_001),
    ), { signal: new AbortController().signal, maxBytes: 1024 * 1024 })).resolves.toBeUndefined()
  })

  it('accepts a common progressive JPEG with DC-only and AC-only scans', async () => {
    await expect(verifyMjpegJpegPicture(streamOf(PROGRESSIVE_JPEG), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).resolves.toBeUndefined()
  })

  it('resynchronizes from malformed candidates onto a later complete picture', async () => {
    await expect(verifyMjpegJpegPicture(streamOf(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      buildGradientJpeg(4),
    ), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).resolves.toBeUndefined()
  })

  it.each([
    ['an empty body', new Uint8Array()],
    ['error bytes', new TextEncoder().encode('Error: capture unavailable')],
    ['a tiny impostor', Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9])],
    ['a dimensioned header with an empty scan', Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc0, 0, 8, 8, 0, 16, 0, 16, 1,
      0xff, 0xda, 0, 2,
      0xff, 0xd9,
    ])],
    ['a dimensioned scan without coding tables', Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc0, 0, 11, 8, 0, 16, 0, 16, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ])],
    ['empty coding-table segments', Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xdb, 0, 2,
      0xff, 0xc4, 0, 2,
      0xff, 0xc0, 0, 11, 8, 0, 16, 0, 16, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ])],
    ['a truncated picture', buildGradientJpeg(2).subarray(0, -2)],
  ])('rejects %s', async (_label, bytes) => {
    await expect(verifyMjpegJpegPicture(streamOf(bytes), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).rejects.toThrow(/MJPEG stream/)
  })

  it('rejects a malformed scan header even when real coding tables and entropy data follow', async () => {
    const jpeg = Uint8Array.from(buildGradientJpeg(3))
    const scan = jpeg.findIndex((byte, index) => byte === 0xff && jpeg[index + 1] === 0xda)
    if (scan < 0) throw new Error('real JPEG fixture omitted its scan header')
    jpeg[scan + 2] = 0
    jpeg[scan + 3] = 2
    await expect(verifyMjpegJpegPicture(streamOf(jpeg), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).rejects.toThrow(/MJPEG stream/u)
  })

  it.each([
    ['an invalid quantization precision', { dqt: [0x20, ...new Array<number>(64).fill(1)] }],
    ['an invalid quantization id', { dqt: [4, ...new Array<number>(64).fill(1)] }],
    ['a truncated quantization table', { dqt: [0, 1] }],
    ['a zero quantization value', { dqt: [0, 0, ...new Array<number>(63).fill(1)] }],
    ['an empty Huffman segment', { dht: [] }],
    ['an invalid Huffman class', { dht: [0x20, 1, ...new Array<number>(15).fill(0), 0] }],
    ['truncated Huffman counts', { dht: [0, ...new Array<number>(15).fill(0)] }],
    ['a Huffman table without symbols', { dht: [0, ...new Array<number>(16).fill(0)] }],
    ['truncated Huffman symbols', { dht: [0, 1, ...new Array<number>(15).fill(0)] }],
  ])('rejects %s', async (_label, options) => {
    await expect(verifyMjpegJpegPicture(streamOf(structuralJpeg(options)), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).rejects.toThrow(/MJPEG stream/u)
  })

  it('rejects an empty scan after a structurally complete 16-bit quantization table', async () => {
    const words = new Array<number>(64).fill(0).flatMap(() => [0, 1])
    await expect(verifyMjpegJpegPicture(streamOf(structuralJpeg({ dqt: [0x10, ...words], scan: [] })), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).rejects.toThrow(/MJPEG stream/u)
  })

  it('rejects a restart-only scan without entropy-coded payload', async () => {
    await expect(verifyMjpegJpegPicture(streamOf(structuralJpeg({ scan: [0xff, 0xd0] })), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).rejects.toThrow(/MJPEG stream/u)
  })

  it.each([
    ['a frame component with an invalid sampling factor', { sof: [8, 0, 16, 0, 16, 1, 1, 0, 0] }],
    ['a frame component referencing an absent quantization table', { sof: [8, 0, 16, 0, 16, 1, 1, 0x11, 1] }],
    ['a scan with a reversed spectral range', { sos: [1, 1, 0, 2, 1, 0] }],
    ['a scan component referencing absent Huffman tables', { sos: [1, 1, 0x11, 0, 63, 0] }],
  ])('rejects %s', async (_label, replacement) => {
    await expect(verifyMjpegJpegPicture(streamOf(structuralJpeg(replacement)), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).rejects.toThrow(/MJPEG stream/u)
  })

  it.each([
    ['scan data before a scan marker', [0xff, 0xd8, 0x01, 0x00]],
    ['a stuffed entropy byte before a scan', [0xff, 0xd8, 0xff, 0x00]],
    ['a restart marker before a scan', [0xff, 0xd8, 0xff, 0xd0]],
    ['a nested start-of-image marker', [0xff, 0xd8, 0xff, 0xd8]],
    ['a truncated marker', [0xff, 0xd8, 0xff, 0xff]],
    ['a marker without a segment length', [0xff, 0xd8, 0xff, 0xe0]],
    ['a one-byte segment', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]],
    ['a truncated segment', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01]],
    ['a short start-of-frame segment', [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0, 0, 0, 0, 0]],
  ])('rejects %s', async (_label, bytes) => {
    await expect(verifyMjpegJpegPicture(streamOf(Uint8Array.from(bytes)), {
      signal: new AbortController().signal, maxBytes: 1024,
    })).rejects.toThrow(/MJPEG stream/u)
  })

  it('rejects input at the byte ceiling', async () => {
    await expect(verifyMjpegJpegPicture(streamOf(new Uint8Array(32)), {
      signal: new AbortController().signal, maxBytes: 16,
    })).rejects.toThrow(/exceeded 16 bytes/)
  })

  it('stops a pending picture probe at the caller deadline', async () => {
    await expect(verifyMjpegJpegPicture(new ReadableStream<Uint8Array>(), {
      signal: AbortSignal.timeout(10), maxBytes: 1024,
    })).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('normalizes a non-Error cancellation and contains reader cancellation failure', async () => {
    const controller = new AbortController()
    const operation = verifyMjpegJpegPicture(new ReadableStream<Uint8Array>({
      cancel() { throw new Error('cancel failed') },
    }), { signal: controller.signal, maxBytes: 1024 })
    controller.abort('operator stopped capture')
    await expect(operation).rejects.toMatchObject({
      message: 'phone stream verification was cancelled',
      cause: 'operator stopped capture',
    })
  })
})
