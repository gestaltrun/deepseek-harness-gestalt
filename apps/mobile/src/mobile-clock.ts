/** Live Mobile presentation clock used by shared relative-time rows. */

/** Observable epoch-millisecond clock consumed by the Mobile presentation. */
export interface MobilePresentationClock {
  /** @returns the current presentation instant. */
  getSnapshot(): number
  /** @param listener - observer invoked when relative-time labels may change. @returns disposer. */
  subscribe(listener: () => void): () => void
}

/** System clock that publishes on the next minute boundary while observed. */
export class LiveMobilePresentationClock implements MobilePresentationClock {
  readonly #listeners = new Set<() => void>()
  #now = Date.now()
  #timer: ReturnType<typeof setTimeout> | undefined

  /** @returns the latest system-clock sample. */
  getSnapshot(): number {
    return this.#now
  }

  /**
   * Listener failures are reported together after every observer runs and do not stop later ticks.
   * @param listener - relative-time observer.
   * @returns disposer.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    if (this.#listeners.size === 1) {
      this.#now = Date.now()
      this.schedule()
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0 && this.#timer !== undefined) {
        clearTimeout(this.#timer)
        this.#timer = undefined
      }
    }
  }

  private schedule(): void {
    const now = Date.now()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#now = Date.now()
      const errors: unknown[] = []
      for (const listener of [...this.#listeners]) {
        try { listener() } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) {
        console.error('[mobile-clock] subscriber failures:', new AggregateError(errors))
      }
      if (this.#listeners.size > 0) this.schedule()
    }, 60_000 - now % 60_000)
  }
}

/** @param now - immutable snapshot instant. @returns deterministic clock for examples and tests. */
export function fixedMobilePresentationClock(now: number): MobilePresentationClock {
  if (!Number.isFinite(now)) throw new TypeError('Mobile presentation clock must be a finite epoch millisecond')
  return { getSnapshot: () => now, subscribe: () => () => {} }
}
