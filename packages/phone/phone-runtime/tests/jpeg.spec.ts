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

describe('verifyMjpegJpegPicture', () => {
  it('accepts a chunk-split real JPEG inside multipart framing', async () => {
    const jpeg = buildGradientJpeg(1)
    const header = new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
    await expect(verifyMjpegJpegPicture(streamOf(
      header, jpeg.subarray(0, 11), jpeg.subarray(11, 1_001), jpeg.subarray(1_001),
    ), { signal: new AbortController().signal, maxBytes: 1024 * 1024 })).resolves.toBeUndefined()
  })

  it.each([
    ['an empty body', new Uint8Array()],
    ['error bytes', new TextEncoder().encode('Error: capture unavailable')],
    ['a tiny impostor', Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9])],
    ['a truncated picture', buildGradientJpeg(2).subarray(0, -2)],
  ])('rejects %s', async (_label, bytes) => {
    await expect(verifyMjpegJpegPicture(streamOf(bytes), {
      signal: new AbortController().signal, maxBytes: 1024 * 1024,
    })).rejects.toThrow(/MJPEG stream/)
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
})
