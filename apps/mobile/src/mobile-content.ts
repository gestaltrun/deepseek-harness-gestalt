/** Shared Session content kinds Mobile may render in a full-screen conversation. */

/** Bounded terminal preview on Mobile; no terminal input is exposed. */
export const MOBILE_TERMINAL_PREVIEW_LINES = 8

/** One Desktop-confirmed content block projected for Mobile. */
export type MobileContentBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'tool'; name: string; args: unknown; result?: unknown }
  | { kind: 'diff'; path: string; text: string }
  | {
    kind: 'approval'
    summary: string
    interactionId?: string
    authorized?: readonly string[]
    settled?: { decision: string; persistent?: boolean }
  }
  | {
    kind: 'ask-user'
    question: string
    interactionId?: string
    authorized?: readonly string[]
    settled?: { decision: string; persistent?: boolean }
  }
  | { kind: 'terminal'; summary: string; lines: readonly string[] }
  | { kind: 'unknown-tool'; name: string; args: unknown; result?: unknown }

/**
 * Bound a terminal transcript to a read-only preview.
 * @param lines - full Desktop terminal lines.
 * @param ceiling - maximum lines Mobile may show.
 * @returns visible lines and how many spilled.
 */
export function previewTerminalLines(
  lines: readonly string[],
  ceiling: number = MOBILE_TERMINAL_PREVIEW_LINES,
): { visible: readonly string[]; spilled: number } {
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
    throw new TypeError('Mobile terminal preview ceiling must be a positive integer')
  }
  return {
    visible: lines.slice(0, ceiling),
    spilled: Math.max(0, lines.length - ceiling),
  }
}

/**
 * Format tool arguments for a generic read-only card.
 * @param args - recorded tool arguments.
 * @returns a compact JSON string, or a fallback when serialization fails.
 */
export function formatToolArgs(args: unknown): string {
  try {
    return JSON.stringify(args)
  } catch {
    return '[unserializable arguments]'
  }
}
