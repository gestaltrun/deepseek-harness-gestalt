import { describe, expect, it } from 'vitest'
import { normalizeMultipartImageStream } from '../src/multipart-normalize.ts'
import { assertStructurallyDecodableJpeg } from '../../phone-runtime/tests/helpers.ts'
import {
  buildAllNotificationBody,
  buildPureFrameBody,
  buildR4UpstreamBody,
  R4_FRAME,
} from './fixtures/r4-upstream-stream.ts'

/** Collect the whole normalized stream (small bodies; the parser streams regardless). */
async function collect(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(Buffer.from(next.value))
  }
  return Buffer.concat(chunks)
}

/** Feed one body through the normalizer in tiny chunks to exercise incremental parsing. */
function streamOf(body: Buffer, chunkSize = 7): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, body.length)
      controller.enqueue(body.subarray(offset, end))
      offset = end
    },
  })
}

function emittedFrames(output: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let cursor = 0
  for (;;) {
    const headerEnd = output.indexOf('\r\n\r\n', cursor)
    if (headerEnd < 0) break
    const partStart = output.indexOf('--frame\r\n', cursor)
    if (partStart !== cursor) throw new Error(`expected a --frame delimiter at byte ${String(cursor)}`)
    const frameEnd = output.indexOf('\r\n--frame', headerEnd + 4)
    if (frameEnd < 0) break
    frames.push(output.subarray(headerEnd + 4, frameEnd))
    cursor = frameEnd + 2
  }
  return frames
}

describe('normalizeMultipartImageStream', () => {
  it('reduces the real R4 dual-boundary body to one boundary of decodable image frames', async () => {
    const output = await collect(normalizeMultipartImageStream(streamOf(buildR4UpstreamBody())))

    expect(output.toString('utf8')).not.toContain('BoundaryString')
    expect(output.toString('utf8')).not.toContain('mjpeg-frame-boundary')
    expect(output.toString('utf8')).not.toContain('notification')
    expect(output.toString('utf8').split('--frame\r\n').length - 1).toBe(2)

    const frames = emittedFrames(output)
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      expect(frame.equals(R4_FRAME)).toBe(true)
      assertStructurallyDecodableJpeg(frame)
    }
  })

  it('emits nothing for an all-notification body and still closes', async () => {
    const output = await collect(normalizeMultipartImageStream(streamOf(buildAllNotificationBody())))
    expect(output).toHaveLength(0)
  })

  it('passes pure-frame bodies through byte-identical payloads', async () => {
    const output = await collect(normalizeMultipartImageStream(streamOf(buildPureFrameBody())))
    const frames = emittedFrames(output)
    expect(frames).toHaveLength(2)
    for (const frame of frames) expect(frame.equals(R4_FRAME)).toBe(true)
  })

  it('accepts a custom output boundary', async () => {
    const output = await collect(normalizeMultipartImageStream(streamOf(buildR4UpstreamBody()), 'camera'))
    expect(output.toString('utf8')).toContain('--camera\r\n')
    expect(output.toString('utf8')).not.toContain('--frame\r\n')
  })

  it('drops an incomplete trailing part and keeps the frames before it', async () => {
    const full = buildPureFrameBody()
    // Cut 100 bytes: the final close marker plus the tail of frame 2's payload.
    const truncated = full.subarray(0, full.length - 100)
    const output = await collect(normalizeMultipartImageStream(streamOf(truncated)))
    const frames = emittedFrames(output)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.equals(R4_FRAME)).toBe(true)
  })

  it('resyncs past noise lines and a bogus headers block to the next real frame', async () => {
    const bogusHeaders = Buffer.from(`--BoundaryString\r\n${'x'.repeat(5_000)}\r\n`)
    const preamble = Buffer.from('preamble noise line\r\n')
    const good = Buffer.from('--mjpeg-frame-boundary\r\nContent-Type: image/jpeg\r\nContent-Length: 631\r\n\r\n')
    const body = Buffer.concat([preamble, bogusHeaders, good, R4_FRAME, Buffer.from('\r\n--mjpeg-frame-boundary--\r\n')])
    const output = await collect(normalizeMultipartImageStream(streamOf(body, 3)))
    const frames = emittedFrames(output)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.equals(R4_FRAME)).toBe(true)
  })

  it('ignores an overlong non-boundary line at the head of the body', async () => {
    const noise = Buffer.from(`--${'y'.repeat(200)}\r\n`)
    const good = Buffer.from('--mjpeg-frame-boundary\r\nContent-Type: image/jpeg\r\nContent-Length: 631\r\n\r\n')
    const body = Buffer.concat([noise, good, R4_FRAME, Buffer.from('\r\n--mjpeg-frame-boundary--\r\n')])
    const output = await collect(normalizeMultipartImageStream(streamOf(body)))
    const frames = emittedFrames(output)
    expect(frames).toHaveLength(1)
  })

  it('finishes when an oversized headers block has no resync target and the stream ends', async () => {
    const body = Buffer.from(`--BoundaryString\r\n${'x'.repeat(4_200)}\r\n\r\n`)
    const output = await collect(normalizeMultipartImageStream(streamOf(body)))
    expect(output).toHaveLength(0)
  })

  it('propagates cancellation to the upstream body', async () => {
    let upstreamCancelled = false
    let sent = false
    let releasePendingPull: () => void = () => {}
    // The upstream stays open after one body, like a live capture would: once
    // drained, its pull stalls until cancellation releases and closes it.
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          c.enqueue(buildR4UpstreamBody())
          sent = true
          return
        }
        return new Promise<void>((resolve) => {
          releasePendingPull = () => {
            c.close()
            resolve()
          }
        })
      },
      cancel() {
        upstreamCancelled = true
        releasePendingPull()
      },
    })
    const reader = normalizeMultipartImageStream(upstream).getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    // Start a second read so cancellation lands while a pull is in flight.
    const second = reader.read()
    const cancelPromise = reader.cancel()
    const secondResult = await second
    await cancelPromise
    expect(secondResult.done).toBe(true)
    expect(upstreamCancelled).toBe(true)
  })

  it('drops image-less parts that declare no content type at all', async () => {
    const body = Buffer.concat([
      Buffer.from('--BoundaryString\r\nX-Broken\r\n\r\n'),
      R4_FRAME,
      Buffer.from('\r\n--BoundaryString--\r\n'),
    ])
    const output = await collect(normalizeMultipartImageStream(streamOf(body)))
    expect(output).toHaveLength(0)
  })
})
