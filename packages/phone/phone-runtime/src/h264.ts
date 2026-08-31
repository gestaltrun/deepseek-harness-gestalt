/** Bounded Host-side recognition of one complete Annex-B H264 key picture. */

interface StartCode {
  readonly index: number
  readonly length: 3 | 4
}

/** Inputs for one bounded H264 picture verification. */
export interface H264PictureVerificationOptions {
  /** Caller cancellation for the body read. */
  readonly signal: AbortSignal
  /** Maximum bytes accepted before SPS, PPS, and a complete IDR are found. */
  readonly maxBytes: number
}

/**
 * Read until a complete SPS → PPS → IDR Annex-B sequence is recognizable.
 * Leading zero bytes are legal; non-zero preamble bytes, empty NAL units,
 * forbidden-zero-bit headers, partial input, and oversized input are rejected.
 * The reader cancellation settles before this function returns or throws.
 * @param body - live upstream H264 response body.
 * @param options - cancellation and byte ceiling.
 * @returns completion after one key picture is recognizable and reader cancellation settles.
 */
export async function verifyAnnexBH264Picture(
  body: ReadableStream<Uint8Array>,
  options: H264PictureVerificationOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError('H264 verification maxBytes must be a positive safe integer')
  }
  const reader = body.getReader()
  const probe = new AnnexBPictureProbe(options.maxBytes)
  let rejectAbort: (reason?: unknown) => void = () => {}
  const halt = (): void => { rejectAbort(options.signal.reason) }
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
    if (options.signal.aborted) halt()
    else options.signal.addEventListener('abort', halt, { once: true })
  })
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (chunk.done) {
        if (probe.finish()) return
        throw new Error('phone H264 stream ended before a complete SPS, PPS, and IDR picture')
      }
      if (probe.push(chunk.value)) return
    }
  } finally {
    options.signal.removeEventListener('abort', halt)
    await reader.cancel().catch(() => {})
  }
}

class AnnexBPictureProbe {
  private pending = new Uint8Array()
  private received = 0
  private phase: 'sps' | 'pps' | 'idr' | 'complete' = 'sps'
  private admittedFirstStart = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): boolean {
    this.received += chunk.byteLength
    if (this.received > this.maxBytes) {
      throw new Error(`phone H264 picture probe exceeded ${String(this.maxBytes)} bytes`)
    }
    this.pending = append(this.pending, chunk)
    const starts = startCodesIn(this.pending)
    if (starts.length === 0) return false
    this.admitPreamble(starts[0] as StartCode)
    if (starts.length < 2) return false
    const last = starts.reduce((start, following) => {
      this.acceptNal(this.pending.subarray(start.index + start.length, following.index))
      return following
    })
    this.pending = this.pending.slice(last.index)
    return this.phase === 'complete'
  }

  finish(): boolean {
    const starts = startCodesIn(this.pending)
    const start = starts[0]
    if (start === undefined) return false
    this.admitPreamble(start)
    this.acceptNal(this.pending.subarray(start.index + start.length))
    this.pending = new Uint8Array()
    return this.phase === 'complete'
  }

  private admitPreamble(start: StartCode): void {
    if (this.admittedFirstStart) return
    this.admittedFirstStart = true
    if (this.pending.subarray(0, start.index).some(byte => byte !== 0)) {
      throw new Error('phone H264 stream has a non-zero preamble before its first Annex-B start code')
    }
  }

  private acceptNal(nal: Uint8Array): void {
    if (nal.byteLength === 0) throw new Error('phone H264 stream contains an empty Annex-B NAL')
    const header = nal[0] as number
    if ((header & 0x80) !== 0) throw new Error('phone H264 stream contains a forbidden-zero-bit NAL')
    const type = header & 0x1f
    if (this.phase === 'sps' && type === 7) {
      if (nal.byteLength < 4) throw new Error('phone H264 stream contains a truncated SPS')
      this.phase = 'pps'
    } else if (this.phase === 'pps' && type === 8) {
      if (nal.byteLength < 2) throw new Error('phone H264 stream contains a truncated PPS')
      this.phase = 'idr'
    } else if (this.phase === 'idr' && type === 5) {
      if (nal.byteLength < 2) throw new Error('phone H264 stream contains a truncated IDR')
      this.phase = 'complete'
    }
  }
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}

function startCodesIn(bytes: Uint8Array): StartCode[] {
  const starts: StartCode[] = []
  for (let index = 0; index < bytes.byteLength - 2; index += 1) {
    const four = index + 3 < bytes.byteLength
      && bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 0 && bytes[index + 3] === 1
    const three = !four && bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1
    if (!four && !three) continue
    const length = four ? 4 : 3
    starts.push({ index, length })
    index += length - 1
  }
  return starts
}
