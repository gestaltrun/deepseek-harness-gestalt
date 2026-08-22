/** Allocate a single-settlement promise controlled by the owning lifecycle.
 * @returns the promise and its owner-only resolver.
 */
export function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
