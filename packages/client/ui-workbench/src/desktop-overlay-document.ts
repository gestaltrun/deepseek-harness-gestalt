/**
 * Detect the Desktop native-overlay document without importing the web shell.
 */

/** Query parameter the Desktop Host adds to the overlay `WebContentsView` URL. */
const DESKTOP_OVERLAY_PARAM = 'dsh-desktop-overlay'

/**
 * True when this renderer is the Desktop native overlay document.
 * @returns whether the overlay attribute or query is set.
 */
export function isDesktopOverlayDocument(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-dsh-desktop-overlay')) {
    return true
  }
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search.replace(/^\?/, '')).get(DESKTOP_OVERLAY_PARAM) === '1'
}
