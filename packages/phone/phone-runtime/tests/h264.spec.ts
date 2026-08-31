import { describe, expect, it, vi } from 'vitest'
import { buildGradientH264 } from './fixtures/u3-visible-frames.ts'
import { verifyAnnexBH264KeyAccessUnit } from '../src/h264.ts'

const REAL_ACCESS_UNIT = [...buildGradientH264(1)]
const SPS = REAL_ACCESS_UNIT.slice(0, 14)
const PPS = REAL_ACCESS_UNIT.slice(14, 22)
const AUD = [0, 0, 1, 0x09, 0xf0]

function streamOf(...chunks: readonly number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
  })
}

describe('verifyAnnexBH264KeyAccessUnit', () => {
  it('accepts a chunk-split SPS, PPS, and IDR from the decodable gradient fixture', async () => {
    const bytes = [0, ...REAL_ACCESS_UNIT, ...AUD]
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf(bytes.slice(0, 17), bytes.slice(17, 65_537), bytes.slice(65_537)),
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).resolves.toBeUndefined()
  })

  it.each([
    ['an empty body', []],
    ['upstream Error bytes', [0x80, 0x00, 0x10, 0x01]],
    ['a bare start code', [0, 0, 0, 1]],
    ['parameter sets without IDR', [...SPS, ...PPS, ...AUD]],
    ['a two-byte IDR impostor', [...SPS, ...PPS, 0, 0, 1, 0x65, 0x88, ...AUD]],
  ])('rejects %s', async (_label, bytes) => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf(bytes),
      { signal: new AbortController().signal, maxBytes: 1024 },
    )).rejects.toThrow(/H264 stream/)
  })

  it('rejects a partial stream at its byte ceiling', async () => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf(new Array(32).fill(0x11) as number[]),
      { signal: new AbortController().signal, maxBytes: 16 },
    )).rejects.toThrow(/exceeded 16 bytes/)
  })

  it('stops a pending picture probe at the caller deadline', async () => {
    const signal = AbortSignal.timeout(10)
    await expect(verifyAnnexBH264KeyAccessUnit(
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
        streamController.enqueue(Uint8Array.from([...REAL_ACCESS_UNIT, ...AUD]))
      },
      cancel() { cancellations += 1 },
    })

    await verifyAnnexBH264KeyAccessUnit(body, { signal: controller.signal, maxBytes: 1024 * 1024 })
    const handler = add.mock.calls[0]?.[1]
    expect(handler).toBeTypeOf('function')
    expect(remove).toHaveBeenCalledWith('abort', handler)
    expect(cancellations).toBe(1)

    controller.abort(new Error('late abort'))
    await Promise.resolve()
    expect(cancellations).toBe(1)
  })
})
