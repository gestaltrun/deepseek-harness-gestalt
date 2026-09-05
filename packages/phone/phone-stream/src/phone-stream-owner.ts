type Disposer = () => void
interface ClosingLanes {
  readonly fence: Promise<void>
  readonly http: Promise<void>
  readonly transport: Promise<void>
  readonly relay: Promise<void>
}
interface FiberLike { readonly uid: unknown }
interface CloseLanes {
  readonly http: () => Promise<void>
  readonly transport: () => Promise<void>
  readonly relay: () => Promise<void>
}
interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

/** Owns phone-stream lifecycle fencing, registrations, and ordered teardown. */
export class PhoneStreamOwner {
  private readonly disposers: Disposer[] = []
  private closing: ClosingLanes | undefined
  private disposal: Promise<void> | undefined
  private requestDisposal: (() => void) | undefined

  constructor(
    private readonly ownerFiber: FiberLike,
    subscribeLifecycle: (listener: (fiber: FiberLike) => void) => Disposer,
    registrations: readonly (() => Disposer)[],
    private readonly fence: () => void,
    private readonly lanes: CloseLanes,
  ) {
    try {
      this.disposers.push(subscribeLifecycle((fiber) => {
        if (fiber === this.ownerFiber && fiber.uid === null) this.beginClosing()
      }))
      for (const register of registrations) this.disposers.push(register())
    } catch (setupError) {
      const failures: unknown[] = [setupError]
      for (const dispose of [...this.disposers].reverse()) {
        try { dispose() } catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw setupError
      throw new AggregateError(failures, 'phone-stream registration failed')
    }
  }

  /** Publish every close lane before invoking the lifecycle fence or foreign cleanup.
   * @returns memoized fence, HTTP, transport, and relay outcomes.
   */
  beginClosing(): ClosingLanes {
    if (this.closing !== undefined) return this.closing
    const fence = deferred()
    const http = deferred()
    const transport = deferred()
    const relay = deferred()
    const disposal = deferred()
    const disposalRequest = deferred()
    this.closing = { fence: fence.promise, http: http.promise, transport: transport.promise, relay: relay.promise }
    this.disposal = disposal.promise
    let requested = false
    this.requestDisposal = () => {
      if (requested) return
      requested = true
      disposalRequest.resolve()
    }
    const failures: unknown[] = []
    const run = async (action: () => void | Promise<void>, outcome: Deferred): Promise<void> => {
      try { await action(); outcome.resolve() } catch (error) { outcome.reject(error) }
      await outcome.promise.then(() => {}, (error: unknown) => { failures.push(error) })
    }
    void (async () => {
      await run(this.fence, fence)
      await run(this.lanes.http, http)
      await run(this.lanes.transport, transport)
      await run(this.lanes.relay, relay)
      await disposalRequest.promise
      for (const dispose of [...this.disposers].reverse()) {
        try { dispose() } catch (error) { failures.push(error) }
      }
      if (failures.length === 0) disposal.resolve()
      else disposal.reject(failures.length === 1 ? failures[0] : new AggregateError(failures, 'phone-stream teardown failed'))
    })()
    return this.closing
  }

  /** Await close lanes, then unregister contributions in reverse order.
   * @returns exact memoized disposal promise.
   */
  dispose(): Promise<void> {
    this.beginClosing()
    this.requestDisposal?.()
    return this.disposal as Promise<void>
  }
}
