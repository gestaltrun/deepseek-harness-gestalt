/**
 * Browser-safe WDA swipe encoder shared by Host tools and the Desktop phone tab.
 * @module @deepseek-ai/dsh-phone-runtime/swipe
 */

/** Travel duration attached to the destination move, not to press. */
export const PHONE_SWIPE_MOVE_DURATION_MS = 150

/**
 * Encode a swipe as the WDA list mobilecli's iOS converter consumes.
 * Positioning pointerMove precedes pointerDown. Pause after the destination
 * move supplies drag duration. A pause after pointerDown would extend press
 * and become an iOS long-press.
 * @param points - capture-pixel path; first and last points bound the swipe.
 * @returns OpenRPC device.io.gesture actions, or empty when points is empty.
 */
export function phoneSwipeActions(
  points: readonly Readonly<{ x: number; y: number }>[],
): Array<Record<string, unknown>> {
  const start = points[0]
  const end = points[points.length - 1]
  if (start === undefined || end === undefined) return []
  return [
    { type: 'pointerMove', x: start.x, y: start.y },
    { type: 'pointerDown' },
    { type: 'pointerMove', x: end.x, y: end.y },
    { type: 'pause', duration: PHONE_SWIPE_MOVE_DURATION_MS },
    { type: 'pointerUp' },
  ]
}
