import { describe, expect, it, vi } from 'vitest'
import { buildGradientH264 } from './fixtures/u3-visible-frames.ts'
import { inspectAnnexBH264KeyAccessUnit, verifyAnnexBH264KeyAccessUnit } from '../src/h264.ts'
import { inspectRecognizable, readUntilRecognizable } from '../src/recognizable-stream.ts'

const REAL_ACCESS_UNIT = [...buildGradientH264(1)]
const SPS = REAL_ACCESS_UNIT.slice(0, 14)
const PPS = REAL_ACCESS_UNIT.slice(14, 22)
const AUD = [0, 0, 1, 0x09, 0xf0]

class Bits {
  private readonly values: number[] = []

  bit(value: number): this { this.values.push(value & 1); return this }
  bits(value: number, width: number): this {
    for (let shift = width - 1; shift >= 0; shift -= 1) this.bit(value >> shift)
    return this
  }
  ue(value: number): this {
    const code = value + 1
    const width = Math.floor(Math.log2(code))
    for (let index = 0; index < width; index += 1) this.bit(0)
    return this.bits(code, width + 1)
  }
  se(value: number): this { return this.ue(value <= 0 ? -value * 2 : value * 2 - 1) }
  bytes(trailing = true): number[] {
    if (trailing) this.bit(1)
    while (this.values.length % 8 !== 0) this.bit(0)
    const bytes: number[] = []
    for (let offset = 0; offset < this.values.length; offset += 8) {
      let byte = 0
      for (let index = 0; index < 8; index += 1) byte = byte * 2 + (this.values[offset + index] as number)
      bytes.push(byte)
    }
    return bytes
  }
}

interface SpsOptions {
  profile?: number
  chroma?: number
  scaling?: number
  frameBits?: number
  pocType?: number
  pocBits?: number
  width?: number
  height?: number
  frameOnly?: number
  crop?: readonly [number, number, number, number]
}

function sps(options: SpsOptions = {}): number[] {
  const profile = options.profile ?? 66
  const bits = new Bits().bits(profile, 8).bits(0, 8).bits(31, 8).ue(0)
  if (profile === 100) {
    bits.ue(options.chroma ?? 1).ue(0).ue(0).bit(0).bit(options.scaling ?? 0)
  }
  bits.ue((options.frameBits ?? 4) - 4)
  const pocType = options.pocType ?? 0
  bits.ue(pocType)
  if (pocType === 0) bits.ue((options.pocBits ?? 4) - 4)
  bits.ue(0).bit(0).ue((options.width ?? 1) - 1).ue((options.height ?? 1) - 1)
  bits.bit(options.frameOnly ?? 1).bit(1)
  const crop = options.crop
  bits.bit(crop === undefined ? 0 : 1)
  if (crop !== undefined) for (const value of crop) bits.ue(value)
  return [0x67, ...bits.bytes()]
}

interface PpsOptions {
  id?: number
  spsId?: number
  bottom?: number
  sliceGroups?: number
  redundant?: number
  deblocking?: number
  picInit?: number
}

function pps(options: PpsOptions = {}): number[] {
  const bits = new Bits()
    .ue(options.id ?? 0).ue(options.spsId ?? 0).bit(0).bit(options.bottom ?? 0)
    .ue(options.sliceGroups ?? 0).ue(0).ue(0).bit(0).bits(0, 2)
    .se(options.picInit ?? 0).se(0).se(0).bit(options.deblocking ?? 0).bit(0).bit(options.redundant ?? 0)
  return [0x68, ...bits.bytes()]
}

interface IdrOptions {
  header?: number
  first?: number
  sliceType?: number
  ppsId?: number
  frameBits?: number
  pocBits?: number
  bottom?: boolean
  redundant?: boolean
  deblocking?: boolean
  disableDeblocking?: number
  trailing?: boolean
}

function idr(options: IdrOptions = {}): number[] {
  const bits = new Bits()
    .ue(options.first ?? 0).ue(options.sliceType ?? 2).ue(options.ppsId ?? 0)
    .bits(0, options.frameBits ?? 4).ue(0)
  if (options.pocBits !== undefined) {
    bits.bits(0, options.pocBits)
    if (options.bottom === true) bits.se(0)
  }
  if (options.redundant === true) bits.ue(0)
  bits.bit(0).bit(0).se(0)
  if (options.deblocking === true) {
    const disable = options.disableDeblocking ?? 1
    bits.ue(disable)
    if (disable !== 1) bits.se(0).se(0)
  }
  return [options.header ?? 0x65, ...bits.bytes(options.trailing ?? true)]
}

function annex(...nals: readonly number[][]): number[] {
  return nals.flatMap(nal => [0, 0, 0, 1, ...nal])
}

function streamOf(...chunks: readonly number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
  })
}

describe('verifyAnnexBH264KeyAccessUnit', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maxBytes %s', async (maxBytes) => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf([]), { signal: new AbortController().signal, maxBytes },
    )).rejects.toThrow(TypeError)
  })

  it('rejects an already-aborted owner and contains reader cancellation failure', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already stopped'))
    await expect(verifyAnnexBH264KeyAccessUnit(
      new ReadableStream<Uint8Array>({ cancel() { throw new Error('cancel failed') } }),
      { signal: controller.signal, maxBytes: 1024 },
    )).rejects.toThrow('already stopped')
  })

  it('accepts a final IDR at EOF and contains reader cancellation failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.from(REAL_ACCESS_UNIT)); controller.close() },
      cancel() { throw new Error('already closed') },
    })
    await expect(verifyAnnexBH264KeyAccessUnit(
      body, { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).resolves.toBeUndefined()
  })
  it('accepts a chunk-split SPS, PPS, and IDR from the decodable gradient fixture', async () => {
    const bytes = [0, ...REAL_ACCESS_UNIT, ...AUD]
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf(bytes.slice(0, 17), bytes.slice(17, 65_537), bytes.slice(65_537)),
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).resolves.toBeUndefined()
  })

  it('accepts a live IDR once its slice header is complete without waiting for the next NAL', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(annex(sps(), pps(), idr({ pocBits: 4 }))))
      },
      cancel() { cancelled = true },
    })
    await expect(verifyAnnexBH264KeyAccessUnit(
      body,
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).resolves.toBeUndefined()
    expect(cancelled).toBe(true)
  })

  it('waits through a live truncated IDR and still honors cancellation', async () => {
    const signal = AbortSignal.timeout(10)
    await expect(verifyAnnexBH264KeyAccessUnit(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from(annex(
            sps(), pps(), [0x65],
          )))
        },
      }),
      { signal, maxBytes: 1024 * 1024 },
    )).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('surfaces a non-truncation error from a live trailing IDR', async () => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from(annex(
            sps(), pps(), idr({ ppsId: 1 }),
          )))
        },
      }),
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).rejects.toThrow('unknown PPS')
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

  it.each([
    ['a non-zero preamble', [9, ...annex(sps(), pps(), idr()), ...AUD]],
    ['an empty NAL', [...annex([]), ...annex(sps(), pps(), idr()), ...AUD]],
    ['a forbidden-zero-bit header', [...annex([0xe7, 1]), ...annex(sps(), pps(), idr()), ...AUD]],
  ])('rejects %s', async (_label, bytes) => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf(bytes), { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).rejects.toThrow(/H264 stream/u)
  })

  it.each([
    ['unsupported chroma', sps({ profile: 100, chroma: 3 }), pps(), idr()],
    ['scaling matrices', sps({ profile: 100, scaling: 1 }), pps(), idr()],
    ['picture order type 1', sps({ pocType: 1 }), pps(), idr()],
    ['invalid picture order type', sps({ pocType: 3 }), pps(), idr()],
    ['interlaced picture', sps({ frameOnly: 0 }), pps(), idr()],
    ['invalid horizontal crop', sps({ crop: [8, 0, 0, 0] }), pps(), idr()],
    ['invalid vertical crop', sps({ crop: [0, 0, 8, 0] }), pps(), idr()],
    ['oversized frame number', sps({ frameBits: 21 }), pps(), idr({ frameBits: 21 })],
    ['oversized picture order', sps({ pocBits: 21 }), pps(), idr({ pocBits: 21 })],
    ['oversized width', sps({ width: 16_385 }), pps(), idr()],
    ['unknown SPS', sps(), pps({ spsId: 1 }), idr()],
    ['slice groups', sps(), pps({ sliceGroups: 1 }), idr()],
    ['no reference priority', sps(), pps(), idr({ header: 0x05 })],
    ['unknown PPS', sps(), pps(), idr({ ppsId: 1 })],
    ['macroblock outside picture', sps(), pps(), idr({ first: 1 })],
    ['non-primary slice type', sps(), pps(), idr({ sliceType: 0 })],
  ])('rejects %s syntax', async (_label, sequence, picture, slice) => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf([...annex(sequence, picture, slice), ...AUD]),
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).rejects.toThrow(/H264/u)
  })

  it.each([
    ['high profile without scaling matrices', sps({ profile: 100 }), pps(), idr({ pocBits: 4 })],
    ['picture order and bottom-field delta', sps(), pps({ bottom: 1 }), idr({ pocBits: 4, bottom: true })],
    ['redundant picture count', sps(), pps({ redundant: 1 }), idr({ pocBits: 4, redundant: true })],
    ['disabled deblocking', sps(), pps({ deblocking: 1 }), idr({ pocBits: 4, deblocking: true })],
    ['deblocking offsets', sps(), pps({ deblocking: 1 }), idr({ pocBits: 4, deblocking: true, disableDeblocking: 0 })],
    ['positive signed syntax', sps(), pps({ picInit: 1 }), idr({ pocBits: 4 })],
  ])('accepts %s syntax', async (_label, sequence, picture, slice) => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf([...annex(sequence, picture, slice), ...AUD]),
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).resolves.toBeUndefined()
  })

  it('rejects a truncated IDR after parsing its slice header', async () => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf([...annex(
        sps(),
        pps({ bottom: 1, redundant: 1, deblocking: 1 }),
        idr({
          sliceType: 4, pocBits: 4, bottom: true, redundant: true,
          deblocking: true, disableDeblocking: 1, trailing: false,
        }),
      ), ...AUD]),
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 },
    )).rejects.toThrow(/truncated IDR slice payload/u)
  })

  it('rejects invalid and truncated exponential-Golomb syntax', async () => {
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf([...annex([0x67, 0, 0, 0, 0, 0, 0, 0]), ...AUD]),
      { signal: new AbortController().signal, maxBytes: 1024 },
    )).rejects.toThrow(/truncated SPS/u)
    await expect(verifyAnnexBH264KeyAccessUnit(
      streamOf([...annex([0x67, 0, 0, 0, 0, 0, 0, 0, 0]), ...AUD]),
      { signal: new AbortController().signal, maxBytes: 1024 },
    )).rejects.toThrow(/invalid SPS|truncated SPS/u)
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

describe('inspectAnnexBH264KeyAccessUnit', () => {
  it('rejects invalid byte limits before acquiring the body', async () => {
    await expect(inspectAnnexBH264KeyAccessUnit(
      streamOf([]), { signal: new AbortController().signal, maxBytes: 0 },
    )).rejects.toThrow(TypeError)
  })

  it('recognizes a live prefix and replays it before the unread continuation', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const prefix = Uint8Array.from([...REAL_ACCESS_UNIT, ...AUD])
    const tail = Uint8Array.from([1, 2, 3])
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
        controller.enqueue(prefix)
      },
    })
    const inspected = await inspectAnnexBH264KeyAccessUnit(body, {
      signal: new AbortController().signal,
      maxBytes: 1024 * 1024,
    })
    source.enqueue(tail)
    source.close()

    expect(inspected.recognizable).toBe(true)
    expect(inspected.failure).toBeUndefined()
    expect(Buffer.from(await new Response(inspected.body).arrayBuffer()))
      .toEqual(Buffer.concat([Buffer.from(prefix), Buffer.from(tail)]))
  })

  it('returns failure facts and the complete invalid EOF body', async () => {
    const bytes = Uint8Array.from(Buffer.from('Error: Error 0x80001001'))
    const inspected = await inspectAnnexBH264KeyAccessUnit(
      new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      { signal: new AbortController().signal, maxBytes: 1024 },
    )

    expect(inspected.recognizable).toBe(false)
    expect(inspected.failure?.message).toContain('ended before a complete SPS')
    expect(Buffer.from(await new Response(inspected.body).arrayBuffer())).toEqual(Buffer.from(bytes))
  })
})

describe('recognizable stream replay', () => {
  it('recognizes an EOF-complete probe and closes its empty replay', async () => {
    const inspected = await inspectRecognizable(
      streamOf([]),
      new AbortController().signal,
      { push: () => false, finish: () => true },
      'incomplete',
    )
    expect(inspected.recognizable).toBe(true)
    expect((await new Response(inspected.body).arrayBuffer()).byteLength).toBe(0)
  })

  it('normalizes thrown probe values and replays the inspected prefix', async () => {
    const pushed = Uint8Array.from([1, 2])
    const pushFailure = await inspectRecognizable(
      streamOf([...pushed]),
      new AbortController().signal,
      { push: () => { throw 'push refusal' }, finish: () => false },
      'incomplete',
    )
    expect(pushFailure.failure?.message).toBe('push refusal')
    expect(Buffer.from(await new Response(pushFailure.body).arrayBuffer())).toEqual(Buffer.from(pushed))

    const finishFailure = await inspectRecognizable(
      streamOf([]),
      new AbortController().signal,
      { push: () => false, finish: () => { throw 'finish refusal' } },
      'incomplete',
    )
    expect(finishFailure.failure?.message).toBe('finish refusal')

    const exact = new Error('exact probe refusal')
    const errorFailure = await inspectRecognizable(
      streamOf([3]),
      new AbortController().signal,
      { push: () => { throw exact }, finish: () => false },
      'incomplete',
    )
    expect(errorFailure.failure).toBe(exact)
  })

  it('cancels the source when inspection is already aborted and contains cancellation failure', async () => {
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled += 1; throw new Error('cancel refusal') },
    })
    const controller = new AbortController()
    controller.abort('inspection stopped')
    await expect(inspectRecognizable(
      body,
      controller.signal,
      { push: () => false, finish: () => false },
      'incomplete',
    )).rejects.toThrow('phone stream verification was cancelled')
    expect(cancelled).toBe(1)
  })

  it('forwards replay cancellation to the unread source', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    let cancellation: unknown
    const body = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; controller.enqueue(Uint8Array.from([7])) },
      cancel(reason) { cancellation = reason },
    })
    const inspected = await inspectRecognizable(
      body,
      new AbortController().signal,
      { push: () => true, finish: () => false },
      'incomplete',
    )
    await inspected.body.cancel('renderer replaced')
    expect(cancellation).toBe('renderer replaced')
    expect(source).toBeDefined()
  })

  it('lets the non-replaying verifier accept completion at EOF', async () => {
    await expect(readUntilRecognizable(
      streamOf([]),
      new AbortController().signal,
      { push: () => false, finish: () => true },
      'incomplete',
    )).resolves.toBeUndefined()
  })
})
