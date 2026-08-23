/**
 * Ref-counted lock for HTML overlays that must sit above a Desktop page view.
 * @module @deepseek-ai/dsh-client-ui-primitives/overlay-lock
 */

import { useEffect } from 'react'

/** Window event name for one overlay hold or release. */
export const OVERLAY_LOCK_EVENT = 'dsh-overlay-lock'

/**
 * Hold or release one overlay lock.
 * Desktop raises Host chrome above official page views while any lock is held.
 * @param held - True when this overlay is open.
 */
export function notifyOverlayLock(held: boolean): void {
  window.dispatchEvent(new CustomEvent(OVERLAY_LOCK_EVENT, { detail: { held } }))
}

/**
 * Subscribe to whether any overlay lock is held.
 * @param listener - Receives true while at least one holder is open.
 * @returns an unsubscribe function.
 */
export function subscribeOverlayLock(listener: (held: boolean) => void): () => void {
  let depth = 0
  const onEvent = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent
      ? (event as CustomEvent<unknown>).detail
      : undefined
    const held = typeof detail === 'object'
      && detail !== null
      && 'held' in detail
      && detail.held === true
    depth = held ? depth + 1 : Math.max(0, depth - 1)
    listener(depth > 0)
  }
  window.addEventListener(OVERLAY_LOCK_EVENT, onEvent)
  return () => {
    window.removeEventListener(OVERLAY_LOCK_EVENT, onEvent)
  }
}

/**
 * Hold the overlay lock for the lifetime of `held`.
 * @param held - True while this component's overlay is open.
 */
export function useOverlayLock(held: boolean): void {
  useEffect(() => {
    if (!held) return
    notifyOverlayLock(true)
    return () => {
      notifyOverlayLock(false)
    }
  }, [held])
}
