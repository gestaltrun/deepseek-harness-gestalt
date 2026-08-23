/**
 * Detect the Desktop native-overlay document (`?dsh-desktop-overlay=1`).
 * @module @deepseek-ai/dsh-client-web/desktop-overlay-mode
 */

/** HTML attribute stamped on the overlay document. */
export const DESKTOP_OVERLAY_ATTR = 'data-dsh-desktop-overlay'

/** Query parameter the Desktop Host adds to the overlay `WebContentsView` URL. */
export const DESKTOP_OVERLAY_PARAM = 'dsh-desktop-overlay'

/**
 * True when this renderer is the native overlay document.
 * @param search - `location.search`, including a leading `?`.
 * @returns whether the overlay query is present.
 */
export function isDesktopOverlaySearch(search: string): boolean {
  return new URLSearchParams(search.replace(/^\?/, '')).get(DESKTOP_OVERLAY_PARAM) === '1'
}

/**
 * True when this document paints Settings and the sidebar + menu as the native overlay.
 * @returns whether the overlay attribute or query is set.
 */
export function isDesktopOverlayDocument(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute(DESKTOP_OVERLAY_ATTR)) {
    return true
  }
  if (typeof location === 'undefined') return false
  return isDesktopOverlaySearch(location.search)
}

/**
 * Stamp the overlay attribute when this document booted from the overlay query.
 */
export function markDesktopOverlayDocument(): void {
  if (typeof document === 'undefined') return
  if (isDesktopOverlaySearch(typeof location === 'undefined' ? '' : location.search)) {
    document.documentElement.setAttribute(DESKTOP_OVERLAY_ATTR, '')
  }
}
