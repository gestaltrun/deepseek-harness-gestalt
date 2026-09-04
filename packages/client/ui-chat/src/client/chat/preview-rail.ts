/**
 * Right-gutter geometry for the collapsed Browser preview beside the
 * centered message column. The rail must not shrink or push that column.
 */

/** Minimum right gutter that can host the preview without overlapping messages. */
export const BROWSER_PREVIEW_RAIL_MIN_PX = 240

/**
 * Width of the empty strip to the right of a centered column.
 * A zero or unknown scroller width is treated as roomy so jsdom tests
 * and the first layout pass do not hide the rail.
 * @param scrollWidth - Visible width of the conversation scrollport.
 * @param columnWidth - Width of the centered message column.
 * @returns the right gutter in CSS pixels.
 */
export function rightGutterPx(scrollWidth: number, columnWidth: number): number {
  if (scrollWidth <= 0 || columnWidth <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0, (scrollWidth - columnWidth) / 2)
}

/**
 * Whether the preview rail would overlap the message column.
 * @param scrollWidth - Visible width of the conversation scrollport.
 * @param columnWidth - Width of the centered message column.
 * @returns true when the rail must hide.
 */
export function previewRailTight(scrollWidth: number, columnWidth: number): boolean {
  return rightGutterPx(scrollWidth, columnWidth) < BROWSER_PREVIEW_RAIL_MIN_PX
}
