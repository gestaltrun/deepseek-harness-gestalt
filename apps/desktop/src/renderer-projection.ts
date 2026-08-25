/**
 * State-event projection across the Desktop renderer surfaces.
 * @module @deepseek-ai/dsh-desktop/renderer-projection
 */

/** Electron `WebContents` operations required by Desktop state projection. */
export interface DesktopRendererTarget {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * Send one state event to each distinct active Desktop renderer.
 * @param targets - Current main and overlay renderer targets.
 * @param channel - Preload protocol event channel.
 * @param payload - Authoritative state snapshot.
 */
export function projectDesktopRendererEvent(
  targets: readonly (DesktopRendererTarget | undefined)[],
  channel: string,
  payload: unknown,
): void {
  const projected = new Set<DesktopRendererTarget>()
  for (const target of targets) {
    if (target === undefined || target.isDestroyed() || projected.has(target)) continue
    projected.add(target)
    target.send(channel, payload)
  }
}
