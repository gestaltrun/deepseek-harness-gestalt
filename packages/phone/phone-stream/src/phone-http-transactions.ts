/** Bounds the caller-visible join while detached observers retain late foreign settlement. */
export type HttpCleanupDeadline = (task: Promise<void>) => Promise<'settled' | 'timeout'>

interface Transaction { readonly abort: AbortController; reject(): void; readonly outcome: Promise<void> }

/** Owns admitted phone HTTP transactions and their bounded lifecycle join. */
export class PhoneHttpTransactions {
  private accepting = true
  private readonly active = new Set<Transaction>()
  private closePromise: Promise<void> | undefined

  constructor(private readonly deadline: HttpCleanupDeadline) {}

  /** Admit one transaction before invoking foreign work.
   * @param work - Transaction body receiving the owner cancellation signal.
   * @param reject - Synchronous response rejection used when admission is closed.
   * @returns the transaction work outcome; lifecycle cancellation remains observable by the route.
   */
  run(work: (signal: AbortSignal) => Promise<void>, reject: () => void): Promise<void> {
    if (!this.accepting) { reject(); return Promise.resolve() }
    const abort = new AbortController()
    let resolveOutcome!: () => void
    let rejectOutcome!: (error: unknown) => void
    const outcome = new Promise<void>((resolve, rejectPromise) => { resolveOutcome = resolve; rejectOutcome = rejectPromise })
    const transaction: Transaction = { abort, reject, outcome }
    this.active.add(transaction)
    try { void Promise.resolve(work(abort.signal)).then(resolveOutcome, rejectOutcome) } catch (error) { rejectOutcome(error) }
    void outcome.then(() => { this.active.delete(transaction) }, () => { this.active.delete(transaction) })
    return outcome
  }

  /** Fence admission, detach module ownership, abort admitted work, and return the exact memoized bounded join.
   * @param reason - Cancellation reason delivered to admitted transactions.
   * @returns exact owner close promise; detached observers contain later foreign settlement.
   */
  close(reason: unknown): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.accepting = false
    let resolveClose!: () => void
    let rejectClose!: (error: unknown) => void
    this.closePromise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject })
    const admitted = [...this.active]
    this.active.clear()
    for (const transaction of admitted) {
      transaction.abort.abort(reason)
      try { transaction.reject() } catch (_responseError) {
        /* Only the response rejection callback can fail after transaction authority is revoked. */
      }
    }
    const joined = Promise.allSettled(admitted.map(transaction => transaction.outcome)).then(() => {})
    try {
      void Promise.resolve(this.deadline(joined)).then((result) => {
        if (result === 'timeout') rejectClose(new Error('phone HTTP transaction cleanup timed out'))
        else resolveClose()
      }, rejectClose)
    } catch (error) { rejectClose(error) }
    return this.closePromise
  }

  /** Return transaction records still owned by this module.
   * @returns active ownership count; bounded abandonment reports zero while detached observers remain.
   */
  ownershipSnapshot(): number { return this.active.size }
}
