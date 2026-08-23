/**
 * Desktop Host attach for one official page over the sidebar viewport.
 * @module @deepseek-ai/dsh-client-ui-browser/client/desktop-page-surface
 */

import { useEffect, useRef, type RefObject } from 'react'
import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'

/** Query parameter the Desktop Host adds to the overlay `WebContentsView` URL. */
const DESKTOP_OVERLAY_PARAM = 'dsh-desktop-overlay'

/**
 * True when this renderer is the Desktop native overlay document.
 * Overlay must not present or conceal official pages.
 * @returns whether the overlay attribute or query is set.
 */
function isDesktopOverlayDocument(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-dsh-desktop-overlay')) {
    return true
  }
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search.replace(/^\?/, '')).get(DESKTOP_OVERLAY_PARAM) === '1'
}

/** Present/conceal verbs the Desktop preload may expose. */
export interface DesktopPageSurface {
  browserPresent: (request: {
    target: BrowserTarget
    bounds: { x: number; y: number; width: number; height: number }
  }) => void | Promise<void>
  browserConceal: (target: BrowserTarget) => void | Promise<void>
}

/** Content-relative DIP rectangle for one presented page. */
export interface PageSurfaceBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Read the Desktop page-surface verbs when the preload installed them.
 * @param bridge - `window.dshDesktop` or a test double.
 * @returns the verbs, or undefined in `dsh web`.
 */
export function desktopPageSurfaceOf(bridge: unknown): DesktopPageSurface | undefined {
  if (typeof bridge !== 'object' || bridge === null) return undefined
  const record = bridge as Record<string, unknown>
  if (typeof record.browserPresent !== 'function' || typeof record.browserConceal !== 'function') {
    return undefined
  }
  return record as unknown as DesktopPageSurface
}

/**
 * DIP bounds for one chrome viewport rectangle.
 * @param hole - Chrome viewport rectangle in content coordinates.
 * @returns DIP bounds to present, or undefined when the hole is too small.
 */
export function presentablePageBounds(hole: DOMRectReadOnly): PageSurfaceBounds | undefined {
  if (hole.width < 8 || hole.height < 8) return undefined
  return {
    x: Math.round(hole.x),
    y: Math.round(hole.y),
    width: Math.round(hole.width),
    height: Math.round(hole.height),
  }
}

/**
 * Keep one official Runtime page aligned with a chrome viewport element.
 * Settings and the sidebar + menu paint in a native overlay view above this page.
 * @param target - Session-owned tab, or undefined while create is in flight.
 * @param enabled - False when the snapshot tab is hidden.
 * @returns a ref for the viewport element.
 */
export function useDesktopPageSurface(
  target: BrowserTarget | undefined,
  enabled: boolean,
): RefObject<HTMLDivElement> {
  const viewport = useRef<HTMLDivElement>(null)
  const tabKey = target === undefined
    ? ''
    : `${target.profileId}/${target.workspaceId}/${target.browserId}/${target.tabId}`
  useEffect(() => {
    if (isDesktopOverlayDocument()) return
    const surface = desktopPageSurfaceOf((globalThis as { dshDesktop?: unknown }).dshDesktop)
    if (surface === undefined || target === undefined || !enabled) {
      if (surface !== undefined && target !== undefined) void surface.browserConceal(target)
      return
    }
    const current = target
    const node = viewport.current
    if (node === null) return
    let last = ''
    const send = (): void => {
      const bounds = presentablePageBounds(node.getBoundingClientRect())
      if (bounds === undefined) {
        last = ''
        void surface.browserConceal(current)
        return
      }
      const next = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
      if (next === last) return
      last = next
      void surface.browserPresent({ target: current, bounds })
    }
    send()
    const Observer = globalThis.ResizeObserver
    const observer = typeof Observer === 'function' ? new Observer(send) : undefined
    observer?.observe(node)
    window.addEventListener('resize', send)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', send)
      void surface.browserConceal(current)
    }
  }, [tabKey, enabled])
  return viewport
}
