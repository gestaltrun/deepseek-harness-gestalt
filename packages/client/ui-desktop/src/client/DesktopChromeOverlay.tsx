/**
 * Native overlay document menu, stacked above official page
 * `WebContentsView`s. Settings remain owned by the sidebar settings seat.
 * @module @deepseek-ai/dsh-client-ui-desktop/client/DesktopChromeOverlay
 */

import { useEffect, useState, type ReactNode } from 'react'
import {
  IconBranchOutline16, IconCodeOutline16, IconFolderOpen16, IconGlobeOutline14,
  IconThinkOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChromeOverlayShowRequest, DesktopBridge } from '../protocol.ts'

/** Overlay verbs consumed by this renderer. */
export type OverlayDesktopBridge = Pick<
  DesktopBridge,
  'chromeOverlayGetState' | 'chromeOverlayResult' | 'onChromeOverlayState'
>

/**
 * Map a tab-descriptor id onto the same glyph the in-page + menu uses.
 * @param id - serialized `icon` from the Host chrome request.
 * @returns the glyph, or undefined when the id is unknown.
 */
export function overlayMenuIcon(id: string | undefined): ReactNode {
  if (id === 'editor') return <IconFolderOpen16 size={16} />
  if (id === 'git') return <IconBranchOutline16 size={16} />
  if (id === 'subagent') return <IconThinkOutline16 size={16} />
  if (id === 'browser') return <IconGlobeOutline14 size={16} />
  if (id === 'terminal') return <IconCodeOutline16 size={16} />
  return undefined
}

/**
 * Read overlay verbs when this document is the Desktop overlay renderer.
 * @param bridge - `window.dshDesktop` or a test double.
 * @returns the verbs, or undefined in `dsh web`.
 */
export function overlayDesktopBridgeOf(bridge: unknown): OverlayDesktopBridge | undefined {
  if (typeof bridge !== 'object' || bridge === null) return undefined
  const record = bridge as Record<string, unknown>
  if (
    typeof record.chromeOverlayGetState !== 'function'
    || typeof record.chromeOverlayResult !== 'function'
    || typeof record.onChromeOverlayState !== 'function'
  ) return undefined
  return record as unknown as OverlayDesktopBridge
}

/**
 * Render the native overlay Menu. The sidebar settings seat independently
 * observes settings requests.
 * @returns the menu tree, or null while hidden or showing Settings.
 */
export function DesktopChromeOverlay(): ReactNode {
  const [request, setRequest] = useState<ChromeOverlayShowRequest | null>(null)
  useEffect(() => {
    const bridge = overlayDesktopBridgeOf((globalThis as { dshDesktop?: unknown }).dshDesktop)
    if (bridge === undefined) return
    void bridge.chromeOverlayGetState().then(setRequest)
    return bridge.onChromeOverlayState(setRequest)
  }, [])

  if (request === null || request.kind !== 'menu') return null
  return (
    <Menu
      open
      portal
      align={request.align ?? 'start'}
      side={request.side ?? 'bottom'}
      items={request.items.map((item) => {
        const icon = overlayMenuIcon(item.icon)
        return {
          id: item.id,
          label: item.label,
          ...(item.disabled === true ? { disabled: true } : {}),
          ...(icon === undefined ? {} : { icon }),
        }
      })}
      getAnchorRect={() => new DOMRect(
        request.anchor.x, request.anchor.y, request.anchor.width, request.anchor.height,
      )}
      onSelect={(id) => {
        overlayDesktopBridgeOf((globalThis as { dshDesktop?: unknown }).dshDesktop)
          ?.chromeOverlayResult({ type: 'select', requestId: request.requestId, id })
      }}
      onClose={() => {
        overlayDesktopBridgeOf((globalThis as { dshDesktop?: unknown }).dshDesktop)
          ?.chromeOverlayResult({ type: 'close', requestId: request.requestId })
      }}
      anchor={<span />}
    />
  )
}
