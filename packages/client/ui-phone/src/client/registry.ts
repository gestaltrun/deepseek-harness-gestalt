/**
 * Phone tab registration core: the shared value vocabulary (listing source,
 * device summaries), the 「手机」 tab descriptor with per-device tab
 * instances (`phone:<serial>` ids, serial dedupeKey), and the fiber-scoped
 * mount into the better-sidebar registry.
 *
 * This module carries no stylesheet and no JSX on purpose: the Node-face
 * invariant companion imports it to prove register/dispose symmetry against
 * a same-process fake service. The browser-only icon and tab bodies arrive
 * as `PhoneTabView` parts at mount time.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { PhoneConnectionController } from './phone-connection.ts'

/** The tab descriptor id; also the `SidebarTab.type` of opened phone tabs. */
export const PHONE_TAB_ID = 'phone'

/** Product copy of the + menu row and the picker tab title (locked mockup). */
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
  /** Stable device identity (Android serial or iOS UDID). */
  readonly id: string
  /** Display name shown in the row (emulator AVD name, device model). */
  readonly name: string
  /** Which group header the row belongs under. */
  readonly channel: 'emulator' | 'usb'
  /** Whether the device currently reports an open connection. */
  readonly online: boolean
}

/** One committed listing: summaries grouped per platform segment. */
export interface PhoneListingSnapshot {
  /** Devices the Android segment lists. */
  readonly android: readonly PhoneDeviceSummary[]
  /** Devices the iOS segment lists (simulators and physical handsets). */
  readonly ios: readonly PhoneDeviceSummary[]
}

/**
 * Device abstraction backing the strip badge and both tab bodies' lists.
 * The shipped implementation consumes the Host `GET /phone/devices` route
 * (see `phone-listing.ts`). `getBadge` sits on the per-render hot path and
 * must stay cheap and synchronous; `snapshot` keeps its reference stable
 * between commits so it can seat `useSyncExternalStore`.
 */
export interface PhoneListingSource {
  /** Current badge snapshot (strip pill value). */
  getBadge(): PhoneBadgeSnapshot
  /** Current committed listing; the same reference until the next commit. */
  snapshot(): PhoneListingSnapshot
  /** Pull the latest fleet listing from the Host; commits only on success. */
  refresh(): Promise<void>
  /** Subscribe to commits; returns the disposer. */
  subscribe(listener: () => void): () => void
}

/**
 * Strip-badge pill value: the online count when any device is connected,
 * otherwise quiet. `BetterSidebarService` renders null badges as no pill at
 * all — the locked mockup's gray dot has no rendering path through today's
 * string/number pill contract, so the quiet arm stays invisible until the
 * contract extends (see the README's known limitation).
 */
/**
 * Strip-badge pill value from one listing source.
 * @param source - Device listing the strip badge reads.
 * @returns the online count, or `null` when none are connected.
 */
export function phoneBadgeValue(source: PhoneListingSource): number | null {
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

/**
 * Tab instance id of the per-device tab for one serial (`phone:<serial>`).
 * @param serial - Android serial or iOS UDID.
 * @returns the sidebar tab id for that device.
 */
export function phoneTabIdOf(serial: string): string {
  return `${PHONE_TAB_ID}:${serial}`
}

/**
 * Tab title of a per-device tab (`手机·<name>`, locked mockup cell B).
 * @param name - Display name of the device.
 * @returns the sidebar tab title.
 */
export function phoneTabTitleOf(name: string): string {
  return `手机·${name}`
}

/** Meta payload carried by every per-device tab (JSON-serializable). */
export interface PhoneDeviceTabMeta {
  /** Closed discriminant separating device tabs from the picker tab. */
  readonly kind: 'device'
  /** Stable device identity the tab streams and addresses io with. */
  readonly serial: string
  /** Display name shown in the tab title and the device dropdown. */
  readonly name: string
}

/**
 * Read the device meta back from a persisted tab. Layout restores carry
 * `meta` verbatim, so anything but a well-formed device payload (including
 * the picker tab's own meta) reads as the picker body.
 * @param meta - untrusted `SidebarTab.meta` value.
 * @returns the device payload when the tab addresses one device.
 */
export function phoneDeviceTabMetaOf(meta: unknown): PhoneDeviceTabMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as Record<string, unknown>
  if (record.kind !== 'device') return undefined
  if (typeof record.serial !== 'string' || record.serial.length === 0) return undefined
  if (typeof record.name !== 'string' || record.name.length === 0) return undefined
  return { kind: 'device', serial: record.serial, name: record.name }
}

/** Structural slice of the sidebar tab the descriptor callbacks receive. */
export interface PhoneSidebarTab {
  /** Minted instance id (`phone` for the picker, `phone:<serial>` otherwise). */
  readonly id: string
  /** Plugin-owned payload persisted with the layout. */
  readonly meta?: unknown
}

/**
 * Dedupe key of one phone tab: the serial for device tabs, undefined for
 * the picker. Device re-opens with the same serial focus the existing tab
 * (decision-matrix axis 1 cell C); the picker stays single-instance through
 * the service's id safety net.
 * @param tab - the minted or existing sidebar tab.
 * @returns the dedupe key, or undefined when the tab never dedupes by key.
 */
export function phoneTabDedupeKey(tab: PhoneSidebarTab): string | undefined {
  return phoneDeviceTabMetaOf(tab.meta)?.serial
}

/** Body props every tab instance receives from the better-sidebar render. */
export interface PhoneTabBodyProps {
  /** The tab instance being rendered (id, title, meta). */
  readonly tab: PhoneSidebarTab
  /** Whether this tab is active and the panel open; false pauses the stream. */
  readonly visible: boolean
}

/** Structural slice of `BetterSidebarService` the device-tab opener needs. */
export interface PhoneTabOpenerFace {
  /** Seed-carried open; the service's default mint carries id/title/meta. */
  openTab(seed: {
    readonly type: string
    readonly id?: string
    readonly title?: string
    readonly meta?: unknown
  }): void
}

/**
 * Build the per-device tab opener against one sidebar face. The open seed
 * carries the serial explicitly (id `phone:<serial>`, meta payload, title
 * `手机·<name>`), so the service's serial dedupeKey can focus an already
 * open device tab. A disabled deployment drops the open: with detection off
 * no stream session can be minted, so the entry must not pretend otherwise.
 * @param sidebar - the better-sidebar face resolved from the client context.
 * @param isEnabled - current `ui-phone.enabled` gate read at call time.
 * @returns the opener the picker rows and the device dropdown call.
 */
export function createPhoneTabOpener(
  sidebar: PhoneTabOpenerFace,
  isEnabled: () => boolean,
): (serial: string, name: string) => void {
  return (serial, name) => {
    if (!isEnabled()) return
    sidebar.openTab({
      type: PHONE_TAB_ID,
      id: phoneTabIdOf(serial),
      title: phoneTabTitleOf(name),
      meta: { kind: 'device', serial, name },
    })
  }
}

/** Environment the descriptor hands each tab body at render time. */
export interface PhoneTabEnvironment {
  /** Current enable gate (the picker pins its strip from this). */
  readonly isEnabled: () => boolean
  /** Listing source backing the picker list and the device dropdown. */
  readonly source: PhoneListingSource
  /** Open (or focus) the per-device tab of one device. */
  readonly openDevice: (serial: string, name: string) => void
  /** Create the live connection controller for one device tab. */
  readonly createController: (serial: string) => PhoneConnectionController
}

/** Chrome that only the browser half can supply (JSX icon + styled bodies).
 *  The body splits picker and per-device instances on the tab meta; the
 *  descriptor supplies the environment, so components stay prop-driven. */
export interface PhoneTabView {
  /** Monochrome inline SVG resolving the descriptor's `icon(size)` calls. */
  readonly icon: (size: number) => ReactNode
  /** Tab body component; the descriptor forwards props and environment. */
  readonly component: (props: PhoneTabBodyProps, env: PhoneTabEnvironment) => ReactNode
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
  /** + menu disabled predicate; returning true keeps the row usable. */
  readonly available?: (ctx: unknown, scope: unknown, state: unknown) => boolean
  /** Strip pill value per render; null hides it. */
  readonly badge?: (ctx: unknown, scope: unknown, state: unknown) => string | number | null | undefined
  /**
   * Per-instance dedupe key. Device tabs key on their serial — re-opening a
   * connected device focuses the existing tab (axis 1 cell C); the picker
   * returns undefined and stays single-instance via the id safety net.
   */
  readonly dedupeKey?: (tab: PhoneSidebarTab) => string | undefined
  /** Tab body renderer invoked with the sidebar's tab props. */
  readonly component: (props: PhoneTabBodyProps) => ReactNode
}

/** The registry face {@link installPhoneTab} touches. */
interface SidebarRegistry {
  /** Register one tab descriptor; the return value unregisters it. */
  registerTab(descriptor: PhoneTabDescriptor): () => void
}

/** What {@link buildPhoneTabDescriptor} needs beyond the install options. */
export interface PhoneTabDescriptorOptions extends PhoneTabOptions {
  /** The opener {@link installPhoneTab} wired against the resolved sidebar. */
  readonly openDevice: (serial: string, name: string) => void
}

/** What {@link installPhoneTab} needs beyond the cordis context. */
export interface PhoneTabOptions {
  /** Listing source wired into the badge and the tab bodies. */
  readonly source: PhoneListingSource
  /** Browser-only chrome (icon SVG + styled bodies). */
  readonly view: PhoneTabView
  /** Current enable gate, read at open and render time. */
  readonly isEnabled: () => boolean
  /** Live connection controller factory for one device tab. */
  readonly createController: (serial: string) => PhoneConnectionController
}

/**
 * Build the 「手机」descriptor. There is no `single` flag and no createTab:
 * the picker rides the id safety net, and device tabs mint through
 * seed-carried `phone:<serial>` ids (the editor's per-path pattern) so the
 * serial dedupeKey focuses instead of duplicating. `available` never
 * refuses — the entry stays reachable with zero devices, which routes
 * first-time guidance into the picker body.
 * @param options - sources, chrome, gates, and the wired opener.
 * @returns the descriptor ready for `BetterSidebarService.registerTab`.
 */
export function buildPhoneTabDescriptor(options: PhoneTabDescriptorOptions): PhoneTabDescriptor {
  const env: PhoneTabEnvironment = {
    isEnabled: options.isEnabled,
    source: options.source,
    openDevice: options.openDevice,
    createController: options.createController,
  }
  return {
    id: PHONE_TAB_ID,
    title: PHONE_TAB_TITLE,
    icon: options.view.icon,
    order: PHONE_TAB_ORDER,
    available: () => true,
    badge: () => phoneBadgeValue(options.source),
    dedupeKey: phoneTabDedupeKey,
    component: props => options.view.component(props, env),
  }
}

/**
 * Mount the phone tab registration inside the caller's plugin fiber. The
 * `ctx.effect` disposer unregisters the tab when the fiber dies (HMR-safe
 * symmetry: after disposal the registry holds no `phone` entry — asserted by
 * this package's invariant companion). Fails loud when the Side card client
 * has not published `betterSidebar`, mirroring the ui-workbench adapter.
 * @param ctx - client context whose service store exposes betterSidebar.
 * @param options - gates, sources, chrome, and the controller factory.
 */
export function installPhoneTab(ctx: Context, options: PhoneTabOptions): void {
  const sidebar = ctx.get('betterSidebar') as (SidebarRegistry & PhoneTabOpenerFace) | undefined
  if (sidebar === undefined) {
    throw new Error('ui-phone: betterSidebar is not published; mount the Side card client first')
  }
  const openDevice = createPhoneTabOpener(sidebar, options.isEnabled)
  ctx.effect(() => sidebar.registerTab(buildPhoneTabDescriptor({ ...options, openDevice })), PHONE_TAB_EFFECT)
}
