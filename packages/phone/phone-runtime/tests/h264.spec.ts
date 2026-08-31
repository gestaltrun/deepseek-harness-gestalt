import { describe, expect, it, vi } from 'vitest'
import { verifyAnnexBH264Picture } from '../src/h264.ts'

const SPS = [0, 0, 0, 1, 0x67, 0x64, 0, 0x1f]
const PPS = [0, 0, 1, 0x68, 0xce]
const IDR = [0, 0, 0, 1, 0x65, 0x88]
const AUD = [0, 0, 1, 0x09, 0xf0]

function streamOf(...chunks: readonly number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
  })
}

describe('verifyAnnexBH264Picture', () => {
  it('accepts a chunk-split SPS, PPS, and complete IDR sequence with leading zero bytes', async () => {
    const bytes = [0, ...SPS, ...PPS, ...IDR, ...AUD]
    await expect(verifyAnnexBH264Picture(
      streamOf(bytes.slice(0, 7), bytes.slice(7, 16), bytes.slice(16)),
      { signal: new AbortController().signal, maxBytes: 1024 },
    )).resolves.toBeUndefined()
  })

  it.each([
    ['an empty body', []],
    ['upstream Error bytes', [0x80, 0x00, 0x10, 0x01]],
    ['a bare start code', [0, 0, 0, 1]],
    ['parameter sets without IDR', [...SPS, ...PPS, ...AUD]],
  ])('rejects %s', async (_label, bytes) => {
    await expect(verifyAnnexBH264Picture(
      streamOf(bytes),
      { signal: new AbortController().signal, maxBytes: 1024 },
    )).rejects.toThrow(/H264 stream/)
  })

  it('rejects a partial stream at its byte ceiling', async () => {
    await expect(verifyAnnexBH264Picture(
      streamOf(new Array(32).fill(0x11) as number[]),
      { signal: new AbortController().signal, maxBytes: 16 },
    )).rejects.toThrow(/exceeded 16 bytes/)
  })

  it('stops a pending picture probe at the caller deadline', async () => {
    const signal = AbortSignal.timeout(10)
    await expect(verifyAnnexBH264Picture(
      new ReadableStream<Uint8Array>(),
      { signal, maxBytes: 1024 },
    )).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('removes its abort listener before a late caller abort', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let cancellations = 0
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(Uint8Array.from([...SPS, ...PPS, ...IDR, ...AUD]))
      },
      cancel() { cancellations += 1 },
    })

    await verifyAnnexBH264Picture(body, { signal: controller.signal, maxBytes: 1024 })
    const handler = add.mock.calls[0]?.[1]
    expect(handler).toBeTypeOf('function')
    expect(remove).toHaveBeenCalledWith('abort', handler)
    expect(cancellations).toBe(1)

    controller.abort(new Error('late abort'))
    await Promise.resolve()
    expect(cancellations).toBe(1)
  })
})
