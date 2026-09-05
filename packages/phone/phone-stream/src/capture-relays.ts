import type { PhoneCaptureStream } from '@deepseek-ai/dsh-phone-runtime'

/** Response-side capture sink owned by one relay. */
export interface CaptureSink {
  expose(contentType: string): void
  write(chunk: Uint8Array, signal: AbortSignal): Promise<void>
  end(): void
  fail(error: unknown): void
  abort(reason: unknown): void
}
/** Independent primary, cleanup, and deadline diagnostics. */
export interface CaptureRelayDiagnostics {
  primary(error: unknown): void
  cleanup(error: unknown): void
  timeout(error: Error): void
}
/** Bounds caller-visible cleanup while detached observers own late settlement. */
export type CaptureCleanupDeadline = (cleanup: Promise<void>) => Promise<'settled' | 'timeout'>
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
interface Relay { close(reason: unknown): void; readonly settled: Promise<void> }
const ABORTED = Symbol('aborted')

/** Owns capture publication, backpressure, cancellation, and bounded cleanup. */
export class CaptureRelays {
  private readonly active = new Set<Relay>()
  private closed = false
  private closePromise: Promise<void> | undefined
  constructor(private readonly deadline: CaptureCleanupDeadline, private readonly diagnostics: CaptureRelayDiagnostics) {}

  /** Relay one capture with demand-only reads and bounded cleanup.
   * @param open - Capture opener receiving the relay lifetime signal.
   * @param sink - Response sink receiving headers and chunks.
   * @param caller - Optional caller cancellation signal.
   * @param transform - Optional demand-preserving body transform.
   * @returns relay completion after bounded cleanup ownership transfers.
   */
  run(open: (signal: AbortSignal) => Promise<PhoneCaptureStream>, sink: CaptureSink, caller?: AbortSignal,
    transform: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array> = body => body): Promise<void> {
    const lifetime = new AbortController()
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const cleanup = new Set<Promise<void>>()
    let cancelOwner: ((reason: unknown) => Promise<void>) | undefined
    let cancelRequested = false
    let cancelStarted = false
    let cancelReason: unknown
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const report = (kind: keyof CaptureRelayDiagnostics, value: unknown): void => {
      try { (this.diagnostics[kind] as (value: unknown) => void)(value) } catch (_diagnosticError) {
        /* Only the injected diagnostic callback can fail; relay settlement remains authoritative. */
      }
    }
    const own = <T>(task: Promise<Outcome<T>>): Promise<void> => {
      const observed = task.then((result) => {
        if (!result.ok && result.error !== cancelReason) report('cleanup', result.error)
      })
      cleanup.add(observed)
      void observed.then(() => { cleanup.delete(observed) })
      return observed
    }
    const startInstalledCancel = (): void => {
      if (!cancelRequested || cancelStarted || cancelOwner === undefined) return
      cancelStarted = true
      const owner = cancelOwner
      void own(outcomeCall(() => owner(cancelReason)))
    }
    const installCancel = (owner: (reason: unknown) => Promise<void>): void => { cancelOwner = owner; startInstalledCancel() }
    const close = (reason: unknown): void => {
      if (cancelRequested) return
      cancelRequested = true
      cancelReason = reason
      lifetime.abort(reason)
      try { sink.abort(reason) } catch (error) { report('cleanup', error) }
      startInstalledCancel()
    }
    const relay: Relay = { close, settled }
    if (this.closed || caller?.aborted === true) { close(caller?.reason ?? new Error('capture relays are closed')); settle()
      return settled }
    this.active.add(relay)
    const callerAbort = (): void => { close(caller?.reason) }
    caller?.addEventListener('abort', callerAbort, { once: true })

    void (async () => {
      let primary: unknown
      try {
        const opening = outcomeCall(() => open(lifetime.signal))
        const opened = await raceOutcome(opening, lifetime.signal)
        if (opened === ABORTED) {
          void own(opening.then(async (result) => {
            if (!result.ok) return { ok: false as const, error: result.error }
            return await outcomeCall(() => result.value.body.cancel(cancelReason))
          }).then(value => value))
          return
        }
        if (!opened.ok) throw opened.error
        installCancel(reason => opened.value.body.cancel(reason))
        if (isAborted(lifetime.signal)) return
        const transformed = transform(opened.value.body)
        const acquiredReader = transformed.getReader()
        reader = acquiredReader
        installCancel(reason => acquiredReader.cancel(reason))
        if (isAborted(lifetime.signal)) return
        sink.expose(opened.value.contentType)
        if (isAborted(lifetime.signal)) return
        for (;;) {
          const reading = outcomeCall(() => acquiredReader.read())
          const read = await raceOutcome(reading, lifetime.signal)
          if (read === ABORTED) { void own(reading); return }
          if (!read.ok) throw read.error
          if (isAborted(lifetime.signal)) { void own(reading); return }
          if (read.value.done) break
          const chunk = read.value.value
          const writing = outcomeCall(() => sink.write(chunk, lifetime.signal))
          const wrote = await raceOutcome(writing, lifetime.signal)
          if (wrote === ABORTED) { void own(writing); return }
          if (!wrote.ok) throw wrote.error
          if (isAborted(lifetime.signal)) { void own(writing); return }
        }
        if (!isAborted(lifetime.signal)) sink.end()
      } catch (error) {
        if (!isAborted(lifetime.signal)) { primary = error; report('primary', error)
          try { sink.fail(error) } catch (failure) { report('cleanup', failure) } }
      } finally {
        try {
          caller?.removeEventListener('abort', callerAbort)
          cancelRequested = true
          cancelReason ??= primary
          startInstalledCancel()
          const all = drain(cleanup)
          let result: 'settled' | 'abandoned' = 'settled'
          try {
            if (await this.deadline(all) === 'timeout') {
              result = 'abandoned'
              report('timeout', new Error('phone capture cleanup exceeded its deadline'))
            }
          } catch (error) {
            result = 'abandoned'
            report('cleanup', error)
          }
          let released = false
          const release = (): void => {
            if (released) return
            released = true
            try { reader?.releaseLock() } catch (releaseError) { report('cleanup', releaseError) }
          }
          if (result === 'settled') release()
          else void all.then(release)
        } finally { this.active.delete(relay); settle() }
      }
    })()
    return settled
  }

  /** Test-private count of relays still owned by this module.
   * @returns active relay ownership count.
   */
  ownershipSnapshot(): number { return this.active.size }

  /** Fence admission and close every active relay.
   * @param reason - Exact cancellation reason for active relays.
   * @returns bounded completion of all module-owned relays.
   */
  close(reason: unknown): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    let resolveClose!: () => void
    let rejectClose!: (error: unknown) => void
    this.closePromise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject })
    this.closed = true
    const relays = [...this.active]
    try {
      for (const relay of relays) relay.close(reason)
      void Promise.all(relays.map(relay => relay.settled)).then(() => { resolveClose() }, rejectClose)
    } catch (error) {
      rejectClose(error)
    }
    return this.closePromise
  }
}

function outcomeCall<T>(call: () => Promise<T>): Promise<Outcome<T>> {
  try { return Promise.resolve(call()).then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error })) }
  catch (error) { return Promise.resolve({ ok: false, error }) }
}
function isAborted(signal: AbortSignal): boolean { return signal.aborted }

async function raceOutcome<T>(operation: Promise<Outcome<T>>, signal: AbortSignal): Promise<Outcome<T> | typeof ABORTED> {
  if (signal.aborted) return ABORTED
  let resolveAbort!: () => void
  const aborted = (): void => { resolveAbort() }
  const interruption = new Promise<typeof ABORTED>((resolve) => { resolveAbort = () => { resolve(ABORTED) }
    signal.addEventListener('abort', aborted, { once: true }) })
  try { return await Promise.race([operation, interruption]) } finally { signal.removeEventListener('abort', aborted) }
}
async function drain(tasks: Set<Promise<void>>): Promise<void> {
  while (tasks.size > 0) await Promise.all([...tasks])
}
