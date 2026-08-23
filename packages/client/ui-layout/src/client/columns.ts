/**
 * Pure concession-chain column solver for the three-column AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it (derived zero width — preferred width
 * preferences are never rewritten, so widening the window restores them).
 * The sidebar never concedes: its rendered width is always the drag
 * preference (or the collapsed rail), and center absorbs any remaining
 * deficit as the last resort. Inputs are the layout store's plain width
 * preferences (0 = closed); a closed sidebar resolves to the fixed
 * SIDEBAR_COLLAPSED control rail while closed details resolve to zero width.
 * The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, which decides
 * the effective sidebar preference before solving; the solver itself stays
 * breakpoint-free.
 */
import type { DetailsWidthRange } from './details-width.ts'

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Ordinary details drag clamp floor. */
export const DETAILS_MIN = 300
/** Ordinary details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Ordinary details width before any user drag. */
export const DETAILS_DEFAULT = 360

/** Width range used when a details occupant does not declare one. */
export const DEFAULT_DETAILS_WIDTH_RANGE: DetailsWidthRange = {
  minimum: DETAILS_MIN,
  default: DETAILS_DEFAULT,
  maximum: DETAILS_MAX,
}

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary. The active occupant range controls details clamping and the
 * minimum at which details auto-closes.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param detailsRange - active occupant's details clamp and reopen widths.
 * @returns resolved widths; details 0 closes the in-flow track without unmounting it. AppFrame may still paint
 * that occupant as a right overlay when the stored preference is open.
 */
export function computeColumns(
  viewport: number,
  sidebar: number,
  details: number,
  detailsRange: DetailsWidthRange = DEFAULT_DETAILS_WIDTH_RANGE,
): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, detailsRange.minimum, detailsRange.maximum)

  // Step 1: everything fits at preferred widths.
  if (s + d0 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d0, details: d0 }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(detailsRange.minimum, viewport - s - CENTER_MIN)
  if (s + d1 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1 }

  // Step 3: auto-close details (derived — preferences untouched); center
  // absorbs any remaining deficit (may drop below CENTER_MIN).
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 }
}

/**
 * Width of a right-edge details overlay when the in-flow track is derived
 * closed. The overlay may drop below the occupant's minimum so collapse and
 * chrome stay on-screen; it never exceeds the remaining frame beside the
 * rendered sidebar.
 * @param viewport - available frame width in px.
 * @param sidebarRendered - solved sidebar track width in px.
 * @param detailsPreference - stored details width in px (0 = closed).
 * @param detailsRange - active occupant's clamp.
 * @returns overlay width in px, or 0 when the preference is closed or no
 *   remaining width exists.
 */
export function overlayDetailsWidth(
  viewport: number,
  sidebarRendered: number,
  detailsPreference: number,
  detailsRange: DetailsWidthRange = DEFAULT_DETAILS_WIDTH_RANGE,
): number {
  if (detailsPreference <= 0) return 0
  const remaining = Math.max(0, viewport - sidebarRendered)
  if (remaining === 0) return 0
  const preferred = clampWidth(detailsPreference, detailsRange.minimum, detailsRange.maximum)
  return Math.min(preferred, remaining)
}
