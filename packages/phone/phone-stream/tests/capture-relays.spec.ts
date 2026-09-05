import { describe, expect, it, vi } from 'vitest'
import { CaptureRelays, type CaptureSink } from '../src/capture-relays.ts'
import { normalizeMultipartImageStream } from '../src/multipart-normalize.ts'

function barrier(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  return { promise: new Promise((resolve) => { release = resolve }), release }
}

function harness() {
  const errors = { primary: vi.fn(), cleanup: vi.fn(), timeout: vi.fn() }
  let expire: (() => void) | undefined
  let requested = false
  const relays = new CaptureRelays(
    async cleanup => await Promise.race([cleanup.then(() => 'settled' as const), new Promise<'timeout'>((resolve) => {
      expire = () => { resolve('timeout') }
      if (requested) expire()
    })]),
    errors,
  )
  return { relays, errors, expire: () => { requested = true; expire?.() } }
}

type TestSink = Omit<CaptureSink, 'expose' | 'write' | 'abort'> & {
  expose: ReturnType<typeof vi.fn<(contentType: string) => void>>
  write: ReturnType<typeof vi.fn<(chunk: Uint8Array, signal: AbortSignal) => Promise<void>>>
  abort: ReturnType<typeof vi.fn<(reason: unknown) => void>>
}
function sink(write = async (): Promise<void> => {}): TestSink {
  return {
    expose: vi.fn<(contentType: string) => void>(),
    write: vi.fn(async (_chunk: Uint8Array, _signal: AbortSignal) => { await write() }),
    end: vi.fn(),
    fail: vi.fn(),
    abort: vi.fn<(reason: unknown) => void>(),
  }
}

describe('CaptureRelays', () => {
  it('cancels a body when open resolves immediately before close', async () => {
    const h = harness()
    let resolveOpen!: (capture: { contentType: string; body: ReadableStream<Uint8Array> }) => void
    const opening = new Promise<{ contentType: string; body: ReadableStream<Uint8Array> }>((resolve) => { resolveOpen = resolve })
    const cancelled = vi.fn(async () => {})
    const done = h.relays.run(async () => await opening, sink())
    resolveOpen({ contentType: 'video/h264', body: new ReadableStream<Uint8Array>({ cancel: cancelled }) })
    const close = h.relays.close(new Error('closed'))
    await Promise.all([done, close])
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('settles an open rejection before any cancellation owner exists', async () => {
    const h = harness()
    await h.relays.run(async () => { throw new Error('open failed') }, sink())
    expect(h.errors.primary).toHaveBeenCalledOnce()
    expect(h.errors.primary).toHaveBeenCalledWith(expect.objectContaining({ message: 'open failed' }))
    await h.relays.close(new Error('closed'))
  })

  it('does not open an already-aborted relay', async () => {
    const h = harness()
    const target = sink()
    const open = vi.fn(async () => ({ contentType: 'video/h264', body: new ReadableStream<Uint8Array>() }))
    const abort = new AbortController()
    abort.abort(new Error('stopped'))
    await h.relays.run(open, target, abort.signal)
    expect(open).not.toHaveBeenCalled()
    expect(target.abort).toHaveBeenCalledOnce()
    await h.relays.close(new Error('again'))
  })

  it.each([false, true])('does not read ahead while the sink is blocked (multipart=%s)', async (multipart) => {
    const drain = barrier()
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1
        controller.enqueue(Buffer.from(multipart ? '--x\r\nContent-Type: image/jpeg\r\n\r\na\r\n--x\r\n' : 'a')) },
    }, { highWaterMark: 0 })
    const h = harness()
    const contentType = multipart ? 'multipart/x-mixed-replace; boundary=x' : 'video/h264'
    const transform = multipart ? normalizeMultipartImageStream : (value: ReadableStream<Uint8Array>) => value
    const done = h.relays.run(
      async () => ({ contentType, body }),
      sink(async () => { await drain.promise }),
      undefined,
      transform,
    )
    await vi.waitFor(() => { expect(reads).toBe(1) })
    expect(reads).toBe(1)
    const close = h.relays.close(new Error('stop'))
    drain.release()
    h.expire()
    await Promise.all([done, close])
  })

  it('aborts a pending read and initiates cancellation before its foreign gate', async () => {
    const foreign = barrier()
    const cancelled = vi.fn(() => foreign.promise)
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel: cancelled }, { highWaterMark: 0 })
    const h = harness()
    const target = sink()
    const done = h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.expose).toHaveBeenCalledOnce() })
    const close = h.relays.close(new Error('stop'))
    expect(cancelled).toHaveBeenCalledOnce()
    h.expire()
    await Promise.all([done, close])
    foreign.release()
  })

  it('closes during delayed open without exposing headers', async () => {
    const opening = barrier()
    const h = harness()
    const target = sink()
    const done = h.relays.run(async () => { await opening.promise
      return { contentType: 'video/h264', body: new ReadableStream() } }, target)
    const close = h.relays.close(new Error('stop'))
    opening.release()
    await Promise.all([done, close])
    expect(target.expose).not.toHaveBeenCalled()
  })

  it('bounds a never-settling foreign cancellation and removes the relay', async () => {
    const h = harness()
    const target = sink()
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => {}) },
      cancel() { return new Promise(() => {}) },
    }, { highWaterMark: 0 })
    const done = h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.expose).toHaveBeenCalledOnce() })
    const close = h.relays.close(new Error('stop'))
    h.expire()
    await Promise.all([done, close])
    expect(h.errors.timeout).toHaveBeenCalledOnce()
    await h.relays.close(new Error('again'))
  })

  it('cancels a pending sink drain before foreign cancellation settles', async () => {
    const drain = barrier()
    const foreign = barrier()
    const cancelled = vi.fn(() => foreign.promise)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Uint8Array.of(1)) },
      cancel: cancelled,
    }, { highWaterMark: 0 })
    const h = harness()
    const target = sink(async () => { await drain.promise })
    const done = h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.write).toHaveBeenCalledOnce() })
    const close = h.relays.close(new Error('stop'))
    expect(cancelled).toHaveBeenCalledOnce()
    h.expire()
    await Promise.all([done, close])
    drain.release(); foreign.release()
  })

  it('cancels the source when transformation throws', async () => {
    const h = harness()
    const cancelled = vi.fn(() => Promise.reject(new Error('cleanup failed')))
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled }, { highWaterMark: 0 })
    await h.relays.run(async () => ({ contentType: 'video/h264', body }), sink(), undefined, () => { throw new Error('transform failed') })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(h.errors.primary).toHaveBeenCalledWith(expect.objectContaining({ message: 'transform failed' }))
    expect(h.errors.cleanup).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup failed' }))
  })

  it('fences a run racing close', async () => {
    const h = harness()
    await h.relays.close(new Error('closed'))
    const open = vi.fn(async () => ({ contentType: 'video/h264', body: new ReadableStream<Uint8Array>() }))
    const target = sink()
    await h.relays.run(open, target)
    expect(open).not.toHaveBeenCalled()
    expect(target.abort).toHaveBeenCalledOnce()
  })

  it('cancels a late body after delayed open without exposing it', async () => {
    const opening = barrier()
    const h = harness()
    const cancelled = vi.fn(async () => {})
    const target = sink()
    const done = h.relays.run(async () => { await opening.promise
      return { contentType: 'video/h264', body: new ReadableStream<Uint8Array>({ cancel: cancelled }) } }, target)
    const close = h.relays.close(new Error('closed'))
    opening.release()
    await Promise.all([done, close])
    await vi.waitFor(() => { expect(cancelled).toHaveBeenCalledOnce() })
    expect(target.expose).not.toHaveBeenCalled()
  })

  it('contains a synchronous cancellation throw from an acquired reader', async () => {
    const h = harness()
    const cancel = vi.fn(() => { throw new Error('sync cancel') })
    const reader = { read: async () => ({ done: true as const, value: undefined }), cancel, releaseLock: vi.fn() }
    const body = { getReader: () => reader, cancel: async () => {} } as unknown as ReadableStream<Uint8Array>
    await h.relays.run(async () => ({ contentType: 'video/h264', body }), sink())
    expect(h.errors.cleanup).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync cancel' }))
  })

  it('does not write when close follows a resolved read before continuation', async () => {
    const h = harness()
    let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve }),
      cancel: async () => {},
      releaseLock: vi.fn(),
    }
    const body = { getReader: () => reader, cancel: async () => {} } as unknown as ReadableStream<Uint8Array>
    const target = sink()
    const done = h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.expose).toHaveBeenCalledOnce() })
    resolveRead({ done: false, value: Uint8Array.of(1) })
    const close = h.relays.close(new Error('closed'))
    await Promise.all([done, close])
    expect(target.write).not.toHaveBeenCalled()
  })

  it('does not start another read when close follows a resolved write', async () => {
    const h = harness()
    let reads = 0
    let resolveWrite!: () => void
    const target = sink(() => new Promise<void>((resolve) => { resolveWrite = resolve }))
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads += 1
      controller.enqueue(Uint8Array.of(reads)) } }, { highWaterMark: 0 })
    const done = h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.write).toHaveBeenCalledOnce() })
    resolveWrite()
    const close = h.relays.close(new Error('closed'))
    await Promise.all([done, close])
    expect(reads).toBe(1)
  })

  it('releases an acquired reader lock exactly once', async () => {
    const h = harness()
    const releaseLock = vi.fn()
    const reader = { read: async () => ({ done: true as const, value: undefined }), cancel: async () => {}, releaseLock }
    const body = { getReader: () => reader, cancel: async () => {} } as unknown as ReadableStream<Uint8Array>
    await h.relays.run(async () => ({ contentType: 'video/h264', body }), sink())
    expect(releaseLock).toHaveBeenCalledOnce()
  })

  it('treats rejection by the exact close reason as expected cancellation', async () => {
    const h = harness()
    const reason = new Error('closed')
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => {}) },
      cancel() { return Promise.reject(reason) },
    }, { highWaterMark: 0 })
    const target = sink()
    const done = h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.expose).toHaveBeenCalledOnce() })
    await Promise.all([done, h.relays.close(reason)])
    expect(h.errors.cleanup).not.toHaveBeenCalled()
  })

  it.each(['read', 'write', 'cancel'] as const)('settles %s cleanup at deadline and observes one distinct late failure', async (lane) => {
    const h = harness()
    let rejectLate!: (error: unknown) => void
    const late = new Promise<never>((_resolve, reject) => { rejectLate = reject })
    let resolveOther!: () => void
    const other = new Promise<void>((resolve) => { resolveOther = resolve })
    let reads = 0
    const releaseLock = vi.fn()
    const reader = {
      read: vi.fn(() => {
        reads += 1
        if (lane === 'read') return late
        if (reads === 1) return Promise.resolve({ done: false as const, value: Uint8Array.of(1) })
        return other.then(() => ({ done: true as const, value: undefined }))
      }),
      cancel: vi.fn(() => lane === 'cancel' ? late : other),
      releaseLock,
    }
    const body = { getReader: () => reader, cancel: async () => {} } as unknown as ReadableStream<Uint8Array>
    const target = sink(lane === 'write' ? async () => await late : async () => {})
    const done = h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.expose).toHaveBeenCalledOnce() })
    if (lane === 'write') await vi.waitFor(() => { expect(target.write).toHaveBeenCalledOnce() })
    if (lane === 'cancel') await vi.waitFor(() => { expect(reader.read).toHaveBeenCalledTimes(2) })
    const close = h.relays.close(new Error('closed'))
    let settled = false
    void close.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    h.expire()
    await Promise.all([done, close])
    expect(h.errors.timeout).toHaveBeenCalledOnce()
    rejectLate(new Error(`${lane} late failure`))
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(h.errors.cleanup).toHaveBeenCalledTimes(1)
    expect(reader.cancel).toHaveBeenCalledOnce()
    resolveOther()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(h.errors.cleanup).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'] as const)('times out delayed open then owns its late %s', async (outcome) => {
    const h = harness()
    let resolveOpen!: (capture: { contentType: string; body: ReadableStream<Uint8Array> }) => void
    let rejectOpen!: (error: unknown) => void
    const opening = new Promise<{ contentType: string
      body: ReadableStream<Uint8Array> }>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject })
    const cancel = vi.fn(async () => {})
    const target = sink()
    const done = h.relays.run(async () => await opening, target)
    const close = h.relays.close(new Error('closed'))
    let settled = false
    void close.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    h.expire()
    await Promise.all([done, close])
    expect(h.errors.timeout).toHaveBeenCalledOnce()
    if (outcome === 'success') resolveOpen({ contentType: 'video/h264', body: { cancel } as unknown as ReadableStream<Uint8Array> })
    else rejectOpen(new Error('late open failed'))
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(target.expose).not.toHaveBeenCalled()
    if (outcome === 'success') expect(cancel).toHaveBeenCalledOnce()
    else expect(h.errors.cleanup).toHaveBeenCalledWith(expect.objectContaining({ message: 'late open failed' }))
  })

  it.each(['read', 'write', 'cancel'] as const)('abandons rejected deadline during pending %s until true cleanup settles', async (lane) => {
    const errors = { primary: vi.fn(), cleanup: vi.fn(), timeout: vi.fn() }
    const deadlineFailure = new Error('deadline failed')
    const relays = new CaptureRelays(async () => { throw deadlineFailure }, errors)
    let settleLane!: (outcome: { ok: true } | { ok: false; error: Error }) => void
    const laneGate = new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => { settleLane = resolve })
    let settleOther!: () => void
    const other = new Promise<void>((resolve) => { settleOther = resolve })
    let reads = 0
    const releaseLock = vi.fn()
    const reader = {
      read: vi.fn(async () => {
        reads += 1
        if (lane === 'read') { const result = await laneGate; if (!result.ok) throw result.error
          return { done: true as const, value: undefined } }
        if (reads === 1) return { done: false as const, value: Uint8Array.of(1) }
        await other; return { done: true as const, value: undefined }
      }),
      cancel: vi.fn(async () => { if (lane === 'cancel') { const result = await laneGate
        if (!result.ok) throw result.error } else await other }),
      releaseLock,
    }
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>
    const target = sink(async () => { if (lane === 'write') { const result = await laneGate; if (!result.ok) throw result.error } })
    const done = relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await vi.waitFor(() => { expect(target.expose).toHaveBeenCalledOnce() })
    if (lane === 'write') await vi.waitFor(() => { expect(target.write).toHaveBeenCalledOnce() })
    if (lane === 'cancel') await vi.waitFor(() => { expect(reader.read).toHaveBeenCalledTimes(2) })
    const close = relays.close(new Error('stop'))
    await Promise.all([done, close])
    expect(errors.cleanup).toHaveBeenCalledWith(deadlineFailure)
    expect(releaseLock).not.toHaveBeenCalled()
    expect(relays.ownershipSnapshot()).toBe(0)
    settleLane({ ok: true }); settleOther()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(releaseLock).toHaveBeenCalledOnce()
    expect(errors.cleanup).toHaveBeenCalledTimes(1)
  })

  it('publishes close before expose reentry and never reads after the fence', async () => {
    const errors = { primary: vi.fn(), cleanup: vi.fn(), timeout: vi.fn() }
    const relays = new CaptureRelays(async (cleanup) => { await cleanup; return 'settled' }, errors)
    const read = vi.fn(async () => ({ done: true as const, value: undefined }))
    const cancel = vi.fn(async () => {})
    const body = { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) } as unknown as ReadableStream<Uint8Array>
    const target = sink()
    const reason = new Error('reentrant close')
    let first!: Promise<void>; let nested!: Promise<void>
    target.expose.mockImplementation(() => { first = relays.close(reason); nested = relays.close(reason) })
    const done = relays.run(async () => ({ contentType: 'video/h264', body }), target)
    await done
    expect(nested).toBe(first); await first
    expect(read).not.toHaveBeenCalled(); expect(target.write).not.toHaveBeenCalled(); expect(target.end).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce(); expect(relays.ownershipSnapshot()).toBe(0)
  })

  it('abandons many rejected cleanup deadlines without retaining relay ownership', async () => {
    const errors = { primary: vi.fn(), cleanup: vi.fn(), timeout: vi.fn() }
    const relays = new CaptureRelays(async () => { throw new Error('deadline') }, errors)
    const releases: Array<() => void> = []; const locks: Array<ReturnType<typeof vi.fn>> = []
    const reads: Array<ReturnType<typeof vi.fn>> = []
    const runs = Array.from({ length: 32 }, () => {
      let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve }); releases.push(release)
      const lock = vi.fn(); locks.push(lock)
      const read = vi.fn(async () => { await pending; return { done: true as const, value: undefined } }); reads.push(read)
      const reader = { read, cancel: vi.fn(async () => { await pending }), releaseLock: lock }
      return relays.run(async () => ({ contentType: 'video/h264', body: { getReader: () => reader } as unknown as ReadableStream<Uint8Array> }), sink())
    })
    await vi.waitFor(() => { reads.forEach((read) => { expect(read).toHaveBeenCalledOnce() }) })
    const close = relays.close(new Error('stop')); await Promise.all([...runs, close])
    expect(relays.ownershipSnapshot()).toBe(0); locks.forEach((lock) => { expect(lock).not.toHaveBeenCalled() })
    releases.forEach((release) => { release() })
    await vi.waitFor(() => { locks.forEach((lock) => { expect(lock).toHaveBeenCalledOnce() }) })
    expect(errors.cleanup).toHaveBeenCalledTimes(32)
  })

  it('diagnoses one reader release failure without changing relay settlement', async () => {
    const h = harness(); const failure = new Error('release failed')
    const reader = {
      read: vi.fn(async () => ({ done: true as const, value: undefined })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(() => { throw failure }),
    }
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>
    await h.relays.run(async () => ({ contentType: 'video/h264', body }), sink())
    expect(h.errors.cleanup).toHaveBeenCalledTimes(1); expect(h.errors.cleanup).toHaveBeenCalledWith(failure)
    await h.relays.close(new Error('stop'))
  })

  it('observes primary and cancellation failures independently', async () => {
    const h = harness()
    const target = sink(async () => { throw new Error('sink failed') })
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Uint8Array.of(1)) }, cancel() { throw new Error('cancel failed') } }, { highWaterMark: 0 })
    await h.relays.run(async () => ({ contentType: 'video/h264', body }), target)
    expect(h.errors.primary).toHaveBeenCalledWith(expect.objectContaining({ message: 'sink failed' }))
    expect(h.errors.cleanup).toHaveBeenCalledWith(expect.objectContaining({ message: 'cancel failed' }))
  })
})
