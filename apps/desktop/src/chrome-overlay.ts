/**
 * Native Host overlay view that paints Settings and the sidebar + menu.
 * @module @deepseek-ai/dsh-desktop/chrome-overlay
 */

import { DESKTOP_OVERLAY_PARAM } from '@deepseek-ai/dsh-client-ui-desktop/protocol'
import type {
  ChromeOverlayAnchor, ChromeOverlayMenuItem, ChromeOverlayResult, ChromeOverlayShowRequest,
} from '@deepseek-ai/dsh-client-ui-desktop/protocol'

const MAX_ITEMS = 32
const MAX_TEXT = 200
const MAX_ID = 128

/** Overlay `WebContentsView` verbs used to show, hide, and restack. */
export interface ChromeOverlayView {
  setBackgroundColor?(color: string): void
  setVisible?(visible: boolean): void
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void
  webContents?: {
    send?(channel: string, payload: unknown): void
    focus?(): void
  }
}

/** Host window face used to size and raise the overlay view. */
export interface ChromeOverlayWindow {
  contentView?: { addChildView?(view: ChromeOverlayView): void }
  getContentSize?(): number[]
}

/**
 * Stamp the Session Surface URL so that renderer boots as the overlay document.
 * @param hostUrl - loopback Web Host origin printed by `dsh web`.
 * @returns the overlay document URL.
 */
export function overlayUrlFromHost(hostUrl: string): string {
  const url = new URL(hostUrl)
  url.searchParams.set(DESKTOP_OVERLAY_PARAM, '1')
  return url.href
}

/**
 * Full-window DIP bounds for the overlay view.
 * @param size - `BrowserWindow.getContentSize()`.
 * @returns bounds, or undefined when the content is too small.
 */
export function overlayBoundsFromContentSize(size: readonly number[]): {
  x: number
  y: number
  width: number
  height: number
} | undefined {
  const width = size[0]
  const height = size[1]
  if (
    typeof width !== 'number' || typeof height !== 'number'
    || !Number.isFinite(width) || !Number.isFinite(height)
    || width < 8 || height < 8
  ) return undefined
  return { x: 0, y: 0, width: Math.round(width), height: Math.round(height) }
}

/**
 * Make a new overlay view transparent and hidden.
 * @param view - Desktop overlay `WebContentsView`.
 */
export function prepareChromeOverlayView(view: ChromeOverlayView): void {
  view.setBackgroundColor?.('#00000000')
  view.setVisible?.(false)
}

/**
 * Show the overlay above official pages and Host chrome.
 * @param window - Desktop Host `BrowserWindow`.
 * @param view - Overlay `WebContentsView`.
 */
export function showChromeOverlayView(window: ChromeOverlayWindow, view: ChromeOverlayView): void {
  const bounds = overlayBoundsFromContentSize(window.getContentSize?.() ?? [])
  if (bounds !== undefined) view.setBounds?.(bounds)
  view.setVisible?.(true)
  window.contentView?.addChildView?.(view)
  view.webContents?.focus?.()
}

/**
 * Hide the overlay without removing it from `contentView`.
 * @param view - Overlay `WebContentsView`.
 */
export function hideChromeOverlayView(view: ChromeOverlayView): void {
  view.setVisible?.(false)
}

/**
 * Keep the overlay sized to the Host content.
 * @param window - Desktop Host `BrowserWindow`.
 * @param view - Overlay `WebContentsView`.
 */
export function syncChromeOverlayBounds(window: ChromeOverlayWindow, view: ChromeOverlayView): void {
  const bounds = overlayBoundsFromContentSize(window.getContentSize?.() ?? [])
  if (bounds !== undefined) view.setBounds?.(bounds)
}

/**
 * Read one overlay paint request from untrusted IPC.
 * @param value - Renderer payload.
 * @returns the request, or undefined when any field is unusable.
 */
export function parseChromeOverlayShow(value: unknown): ChromeOverlayShowRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const requestId = text(record.requestId, MAX_ID)
  if (requestId === undefined) return undefined
  if (record.kind === 'settings') {
    const sectionId = record.sectionId === undefined ? undefined : text(record.sectionId, MAX_ID)
    if (record.sectionId !== undefined && sectionId === undefined) return undefined
    return sectionId === undefined
      ? { kind: 'settings', requestId }
      : { kind: 'settings', requestId, sectionId }
  }
  if (record.kind !== 'menu') return undefined
  const items = parseItems(record.items)
  const anchor = parseAnchor(record.anchor)
  if (items === undefined || anchor === undefined) return undefined
  const align = record.align === undefined || record.align === 'start' || record.align === 'end'
    ? record.align
    : undefined
  if (record.align !== undefined && align === undefined) return undefined
  const side = record.side === undefined
    || record.side === 'bottom' || record.side === 'top' || record.side === 'right'
    ? record.side
    : undefined
  if (record.side !== undefined && side === undefined) return undefined
  return {
    kind: 'menu',
    requestId,
    items,
    anchor,
    ...(align === undefined ? {} : { align }),
    ...(side === undefined ? {} : { side }),
  }
}

/**
 * Read one overlay reply from untrusted IPC.
 * @param value - Overlay-document payload.
 * @returns the reply, or undefined when any field is unusable.
 */
export function parseChromeOverlayResult(value: unknown): ChromeOverlayResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const requestId = text(record.requestId, MAX_ID)
  if (requestId === undefined) return undefined
  if (record.type === 'close') return { type: 'close', requestId }
  if (record.type !== 'select') return undefined
  const id = text(record.id, MAX_ID)
  if (id === undefined) return undefined
  return { type: 'select', requestId, id }
}

/**
 * True when this `webContents` is the overlay document, not Host chrome.
 * @param senderId - IPC event sender id.
 * @param overlayId - Overlay `webContents.id`, or undefined before the view exists.
 * @returns whether the sender is the overlay document.
 */
export function isOverlaySender(senderId: number, overlayId: number | undefined): boolean {
  return overlayId !== undefined && senderId === overlayId
}

function parseItems(value: unknown): ChromeOverlayMenuItem[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined
  const items: ChromeOverlayMenuItem[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as Record<string, unknown>
    const id = text(record.id, MAX_ID)
    const label = text(record.label, MAX_TEXT)
    if (id === undefined || label === undefined) return undefined
    if (record.disabled !== undefined && record.disabled !== true && record.disabled !== false) {
      return undefined
    }
    const icon = record.icon === undefined ? undefined : text(record.icon, MAX_ID)
    if (record.icon !== undefined && icon === undefined) return undefined
    items.push({
      id,
      label,
      ...(record.disabled === true ? { disabled: true } : {}),
      ...(icon === undefined ? {} : { icon }),
    })
  }
  return items
}

function parseAnchor(value: unknown): ChromeOverlayAnchor | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const x = finite(record.x)
  const y = finite(record.y)
  const width = finite(record.width)
  const height = finite(record.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  if (width < 0 || height < 0) return undefined
  return { x, y, width, height }
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
