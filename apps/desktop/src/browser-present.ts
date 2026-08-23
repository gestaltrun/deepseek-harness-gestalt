/**
 * Validate renderer page-present IPC before moving a Runtime window.
 * @module @deepseek-ai/dsh-desktop/browser-present
 */

/** Tab identity the renderer reports for one official page. */
export interface BrowserPresentTarget {
  readonly profileId: string
  readonly workspaceId: string
  readonly browserId: string
  readonly tabId: string
}

/** Chrome viewport rectangle in CSS pixels relative to the Host content. */
export interface BrowserPresentBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Validated present request from the Session Surface. */
export interface BrowserPresentRequest {
  readonly target: BrowserPresentTarget
  readonly bounds: BrowserPresentBounds
}

const MAX_EDGE = 16_384

/**
 * Read one present request from untrusted IPC.
 * @param value - Renderer payload.
 * @returns the request, or undefined when any field is unusable.
 */
export function parseBrowserPresentRequest(value: unknown): BrowserPresentRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const target = parseBrowserPresentTarget(record.target)
  const bounds = parseBrowserPresentBounds(record.bounds)
  if (target === undefined || bounds === undefined) return undefined
  return { target, bounds }
}

/**
 * Read one tab identity from untrusted IPC.
 * @param value - Renderer payload.
 * @returns the identity, or undefined when any id is empty.
 */
export function parseBrowserPresentTarget(value: unknown): BrowserPresentTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const profileId = id(record.profileId)
  const workspaceId = id(record.workspaceId)
  const browserId = id(record.browserId)
  const tabId = id(record.tabId)
  if (
    profileId === undefined
    || workspaceId === undefined
    || browserId === undefined
    || tabId === undefined
  ) return undefined
  return { profileId, workspaceId, browserId, tabId }
}

/**
 * Translate a content-relative rectangle onto the screen.
 * Electron 41 `setBounds` stays in screen DIP after `setParentWindow`.
 * @param content - `BrowserWindow.getContentBounds()`.
 * @param bounds - Renderer `getBoundingClientRect()`.
 * @returns DIP screen bounds for the child window.
 */
export function screenBoundsOf(
  content: BrowserPresentBounds,
  bounds: BrowserPresentBounds,
): BrowserPresentBounds {
  return {
    x: Math.round(content.x + bounds.x),
    y: Math.round(content.y + bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
}

function parseBrowserPresentBounds(value: unknown): BrowserPresentBounds | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const x = finite(record.x)
  const y = finite(record.y)
  const width = finite(record.width)
  const height = finite(record.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  if (width < 8 || height < 8 || width > MAX_EDGE || height > MAX_EDGE) return undefined
  return { x, y, width, height }
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
