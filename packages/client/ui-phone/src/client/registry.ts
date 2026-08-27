/**
 * Phone tab registration core: the shared value vocabulary (badge source,
 * device summaries), the tab descriptor for the always-reachable 「手机」
 * entry, and the fiber-scoped mount into the better-sidebar registry.
 *
 * This module carries no stylesheet and no JSX on purpose: the Node-face
 * invariant companion imports it to prove register/dispose symmetry against
 * a same-process fake service. The browser-only icon and tab body arrive as
 * `PhoneTabView` parts at mount time.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'

/** The tab descriptor id; also the `SidebarTab.type` of opened phone tabs. */
export const PHONE_TAB_ID = 'phone'

/** Product copy of the tab title and the + menu row (locked by the mockup). */
export const PHONE_TAB_TITLE = '手机'

/** + menu sort order: after the built-in browser (50), before the default 100. */
export const PHONE_TAB_ORDER = 55

/** Cordis effect label owning the registration inside the plugin fiber. */
const PHONE_TAB_EFFECT = 'ui-phone: phone tab'

/** Platforms the device list can be grouped under. */
export const PHONE_PLATFORMS = ['android', 'ios'] as const

/** One platform segment of the empty state's platform selector. */
export type PhonePlatform = typeof PHONE_PLATFORMS[number]

/**
 * Plain-data snapshot the strip badge reads on every sidebar render. Numbers
 * stay JSON-compatible so a future provider may publish it from any channel
 * (client AGENTS rule: UI domains share plain data and callbacks).
 */
export interface PhoneBadgeSnapshot {
  /** How many devices currently report an open connection. */
  readonly onlineCount: number
}

/** One row of the device list the empty state renders per platform. */
export interface PhoneDeviceSummary {
  /** Stable device identity (future serials dedupe per-device tabs). */
  readonly id: string
  /** Display name shown in the row (emulator AVD name, device model). */
  readonly name: string
  /** Which group header the row belongs under. */
  readonly channel: 'emulator' | 'usb'
  /** Whether the device currently reports an open connection. */
  readonly online: boolean
}

/**
 * Consumer-supplied device abstraction backing both the strip badge and the
 * tab body's list. The shipped default reports no devices; the mobilecli
 * provider mounts here in a later ticket. `getBadge` sits on the per-render
 * hot path and must stay cheap and synchronous.
 */
export interface PhoneBadgeSource {
  /** Current badge snapshot (strip pill value). */
  getBadge(): PhoneBadgeSnapshot
  /** Devices listed under one platform segment. */
  listDevices(platform: PhonePlatform): readonly PhoneDeviceSummary[]
}

/** The shipped no-op source: no online devices, an empty list everywhere. */
export const NULL_PHONE_BADGE_SOURCE: PhoneBadgeSource = {
  getBadge: () => ({ onlineCount: 0 }),
  listDevices: () => [],
}

/**
 * Strip-badge pill value: the online count when any device is connected,
 * otherwise quiet. `BetterSidebarService` renders null badges as no pill at
 * all — the locked mockup's gray dot has no rendering path through today's
 * string/number pill contract, so the quiet arm stays invisible until the
 * contract extends (see the README's known limitation).
 */
export function phoneBadgeValue(source: PhoneBadgeSource): number | null {
  const { onlineCount } = source.getBadge()
  return onlineCount > 0 ? onlineCount : null
}

/** What a symmetry probe observed about one registration round-trip. */
export interface PhoneSymmetryProbe {
  /** Whether the registry exposed the `phone` tab after activation. */
  readonly mounted: boolean
  /** Whether the tab survived the owning plugin fiber's disposal. */
  readonly survivedDispose: boolean
}

/**
 * Assert register/dispose symmetry for the `phone` tab against any
 * better-sidebar-compatible registry view. Both failure arms attribute to
 * this package's invariant (`PHONE_TAB_ID` names the checked registration).
 * @param probe - observations taken around one mount/dispose round-trip.
 * @param fail - reporter bound to the registering package.
 */
export function assertPhoneTabSymmetry(
  probe: PhoneSymmetryProbe,
  fail: (message: string) => never,
): void {
  if (!probe.mounted) fail(`the "${PHONE_TAB_ID}" tab is missing after the plugin fiber activated`)
  if (probe.survivedDispose) fail(`the "${PHONE_TAB_ID}" tab leaked past plugin-fiber disposal`)
}

/** Chrome that only the browser half can supply (JSX icon + styled body).
 *  The body ignores the tab props in this skeleton — `visible`-gated
 *  streaming arrives with the connected-state tickets. */
export interface PhoneTabView {
  /** Monochrome inline SVG resolving the descriptor's `icon(size)` calls. */
  readonly icon: (size: number) => ReactNode
  /** Tab body component; the descriptor forwards the sidebar's tab props. */
  readonly component: () => ReactNode
}

/**
 * Structural slice of `BetterSidebarService.registerTab` this package
 * consumes. The pinned better-sidebar snapshot is not a composite project
 * in the client typecheck graph, so consumers declare the face locally
 * (the ui-workbench adapter precedent); `service.ts` in
 * `packages/client/ui-better-sidebar` stays the contract owner.
 */
export interface PhoneTabDescriptor {
  /** Unique tab type id (also the opened `SidebarTab.type`). */
  readonly id: string
  /** Display title; string or i18n resolver. */
  readonly title: string | (() => string)
  /** Tab-strip icon: inline node or `(size) => node`. */
  readonly icon?: (size: number) => ReactNode
  /** + menu sort order (ascending; default 100). */
  readonly order?: number
  /** Single-instance sugar: re-opening focuses the existing tab. */
  readonly single?: boolean
  /** + menu disabled predicate; returning true keeps the row usable. */
  readonly available?: (ctx: unknown, scope: unknown, state: unknown) => boolean
  /** Strip pill value per render; null hides it. */
  readonly badge?: (ctx: unknown, scope: unknown, state: unknown) => string | number | null | undefined
  /** Tab body renderer invoked with the sidebar's tab props. */
  readonly component: (props: never) => ReactNode
}

/** The registry face {@link installPhoneTab} touches. */
interface SidebarRegistry {
  /** Register one tab descriptor; the return value unregisters it. */
  registerTab(descriptor: PhoneTabDescriptor): () => void
}

/** What {@link installPhoneTab} needs beyond the cordis context. The enable
 *  gate does not ride here: it shapes only the tab body, which the browser
 *  half closes over when supplying {@link PhoneTabView}. */
export interface PhoneTabOptions {
  /** Device abstraction wired into the badge and the tab body list. */
  readonly source: PhoneBadgeSource
  /** Browser-only chrome (icon SVG + styled body). */
  readonly view: PhoneTabView
}

/**
 * Build the 「手机」descriptor. `single: true` keeps one instance per session:
 * re-opening focuses the existing tab. `available` never refuses — the entry
 * stays reachable with zero devices, which routes first-time guidance into
 * the tab body instead of a disabled menu row.
 * @param options - device source and browser-only chrome.
 * @returns the descriptor ready for `BetterSidebarService.registerTab`.
 */
export function buildPhoneTabDescriptor(options: PhoneTabOptions): PhoneTabDescriptor {
  return {
    id: PHONE_TAB_ID,
    title: PHONE_TAB_TITLE,
    icon: options.view.icon,
    order: PHONE_TAB_ORDER,
    single: true,
    available: () => true,
    badge: () => phoneBadgeValue(options.source),
    component: () => options.view.component(),
  }
}

/**
 * Mount the phone tab registration inside the caller's plugin fiber. The
 * `ctx.effect` disposer unregisters the tab when the fiber dies (HMR-safe
 * symmetry: after disposal the registry holds no `phone` entry — asserted by
 * this package's invariant companion). Fails loud when the Side card client
 * has not published `betterSidebar`, mirroring the ui-workbench adapter.
 * @param ctx - client context whose service store exposes betterSidebar.
 * @param options - gate value, device source, and browser-only chrome.
 */
export function installPhoneTab(ctx: Context, options: PhoneTabOptions): void {
  const sidebar = ctx.get('betterSidebar') as SidebarRegistry | undefined
  if (sidebar === undefined) {
    throw new Error('ui-phone: betterSidebar is not published; mount the Side card client first')
  }
  ctx.effect(() => sidebar.registerTab(buildPhoneTabDescriptor(options)), PHONE_TAB_EFFECT)
}
