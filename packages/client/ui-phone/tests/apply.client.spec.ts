/**
 * Registration contract of the phone tab on a fake better-sidebar registry:
 * descriptor shape, badge value arms, gate config, and fiber-disposal
 * symmetry (apply registers id 'phone'; disposing the plugin fiber removes
 * it — mirrors what the invariant companion proves at runtime).
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, Config, inject } from '../src/client/index.tsx'
import { NS, zh } from '../src/client/locales.ts'
import { RecordingSidebar } from '../src/invariant.ts'
import type { PhoneSettings } from '../src/phone-settings.ts'
import {
  buildPhoneTabDescriptor, installPhoneTab,
  type PhoneListingSource, type PhoneTabView,
} from '../src/client/registry.ts'
import { createHttpPhoneListingSource } from '../src/client/phone-listing.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'

/** A registered tab descriptor as this suite observes it. */
interface RegisteredTab {
  available: (ctx: unknown, scope: unknown, state: unknown) => boolean
  badge: (ctx: unknown, scope: unknown, state: unknown) => number | null
  component: (props: unknown) => unknown
  dedupeKey?: (tab: { readonly id: string; readonly meta?: unknown }) => string | undefined
  icon: (size: number) => unknown
  id: string
  order: number
  single?: boolean
  title: string | (() => string)
}

/** The suite's view of the shared fake: one registered descriptor by id. */
class SidebarUnderTest extends RecordingSidebar {
  readonly updates: Array<{ tabId: string; patch: { readonly title?: string; readonly meta?: unknown } }> = []
  readonly opens: string[] = []
  panelOpen = false

  override getTab(id: string): RegisteredTab | undefined {
    return super.getTab(id) as RegisteredTab | undefined
  }

  updateTab(tabId: string, patch: { readonly title?: string; readonly meta?: unknown }): void {
    this.updates.push({ tabId, patch })
  }

  openTab(seed: { readonly type: string }): void {
    this.opens.push(seed.type)
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open
  }
}

function stubView(): PhoneTabView {
  return { icon: () => null, component: () => null }
}

function sourceWith(onlineCount: number): PhoneListingSource {
  return {
    getBadge: () => ({ onlineCount }),
    snapshot: () => ({ android: [], ios: [] }),
    refresh: () => Promise.resolve(),
    subscribe: () => () => undefined,
  }
}

async function mount(
  sidebar: SidebarUnderTest,
  settings?: ReturnType<typeof stubSettingsScope<PhoneSettings>>,
  config: { readonly enabled?: boolean } = Config({}),
) {
  const ctx = new Context()
  ctx.provide('betterSidebar', sidebar)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const host = settings ?? stubSettingsScope<PhoneSettings>()
  ctx.provide('settingsScope', { bind: () => host.scope })
  // The loader hands apply the schema-validated config; mimic its default here.
  const fiber = ctx.plugin({
    inject: [...inject],
    apply: (pluginCtx: Context) => { apply(pluginCtx, config) },
  })
  await fiber.await()
  return { ctx, fiber, host }
}

describe('ui-phone client apply', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('declares the Side card, locale, and settings-section service edges', () => {
    expect([...inject]).toEqual(['betterSidebar', 'slots', 'locale', 'settingsScope'])
  })

  it('contributes a top-level 手机设备 settings section and leaves Plugins empty', async () => {
    const sidebar = new SidebarUnderTest()
    const { ctx, fiber } = await mount(sidebar)
    const section = ctx.slots.entries('settings.section')[0]
    expect(section?.options).toMatchObject({ id: 'phone-devices', order: 40 })
    expect(section?.locale).toBe(NS)
    const label = section?.options.label
    expect(typeof label === 'function' ? label() : label).toBe(zh.nav)
    expect(ctx.slots.entries('settings.plugin.item')).toHaveLength(0)
    await fiber.dispose()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  })

  it('fails loud when betterSidebar has not been published', () => {
    const ctx = new Context()
    expect(() => {
      installPhoneTab(ctx, {
        source: createHttpPhoneListingSource(),
        view: stubView(),
        isEnabled: () => false,
        gate: { snapshot: () => false, subscribe: () => () => undefined },
        createController: () => {
          throw new Error('not expected in this spec')
        },
      })
    }).toThrow(/betterSidebar is not published/)
  })

  it('registers the locked 「手机」descriptor shape', async () => {
    const sidebar = new SidebarUnderTest()
    await mount(sidebar)
    const descriptor = sidebar.getTab('phone')!
    expect(descriptor.title).toBe('手机')
    expect(descriptor.order).toBe(55)
    // U1: the strip keeps exactly one 「手机」 tab; devices switch in place.
    expect(descriptor.single).toBe(true)
    expect(descriptor.dedupeKey).toBeUndefined()
    // 恒可达 decision: zero devices never disables the + menu row.
    expect(descriptor.available(undefined, undefined, undefined)).toBe(true)
    // The monochrome inline SVG resolves the icon(size) contract.
    expect(descriptor.icon(14)).toBeTruthy()
    // The body reads the settings scope when ready, else the composition Config.
    expect(descriptor.component({ tab: { id: 'phone', title: '手机' }, visible: false })).toBeTruthy()
  })

  it('reaches the ready inventory from a successful fleet listing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      android: [{ id: 'emulator-5554', name: 'Pixel_6_API_35', kind: 'emulator', state: 'online', online: true }],
      ios: { simulators: [], reals: [] },
    }), { status: 200 })))
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true },
      base: { enabled: false },
      user: { enabled: true },
      revision: 1,
    })
    const { ctx } = await mount(sidebar, host)
    const entry = ctx.slots.entries('settings.section')[0]!
    const face = (entry.inject as () => {
      hooks: { phoneSettingsCard: { getSnapshot: () => { view: { kind: string } } } }
      openDevice: (deviceId: string) => void
    })()
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('ready')
    })
    face.openDevice('missing')
    await vi.waitFor(() => { expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1) })
    expect(sidebar.opens).toEqual([])
    face.openDevice('emulator-5554')
    await vi.waitFor(() => { expect(sidebar.opens).toEqual(['phone']) })
    expect(sidebar.updates.at(-1)).toEqual({
      tabId: 'phone',
      patch: {
        title: '手机·Pixel_6_API_35',
        meta: { kind: 'device', serial: 'emulator-5554', name: 'Pixel_6_API_35' },
      },
    })
    expect(sidebar.panelOpen).toBe(true)
  })

  it('does not open a Settings device while the durable Phone gate is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      android: [{ id: 'fbcd1d21', name: 'MI 8', kind: 'real', state: 'online', online: true }],
      ios: { simulators: [], reals: [] },
    }), { status: 200 })))
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    host.publish({ status: 'ready', value: { enabled: false } })
    const { ctx } = await mount(sidebar, host)
    const face = (ctx.slots.entries('settings.section')[0]!.inject as () => {
      openDevice: (deviceId: string) => void
    })()
    face.openDevice('fbcd1d21')
    await vi.waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalled() })
    expect(sidebar.opens).toEqual([])
  })

  it('projects a Desktop Settings row through the overlay result channel', async () => {
    vi.stubGlobal('location', { search: '?dsh-desktop-overlay=1' })
    const chromeOverlayResult = vi.fn()
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => ({ kind: 'settings', requestId: 'settings-1' }),
      chromeOverlayResult,
      onChromeOverlayResult: () => () => {},
    })
    const sidebar = new SidebarUnderTest()
    const { ctx, fiber } = await mount(sidebar)
    const entry = ctx.slots.entries('settings.section')[0]!
    const face = (entry.inject as () => { openDevice: (deviceId: string) => void })()
    face.openDevice('fbcd1d21')
    await vi.waitFor(() => {
      expect(chromeOverlayResult).toHaveBeenCalledWith({
        type: 'select', requestId: 'settings-1', id: 'phone-device:fbcd1d21',
      })
    })
    await fiber.dispose()
  })

  it('contains a failed Desktop overlay state read', async () => {
    vi.stubGlobal('location', { search: '?dsh-desktop-overlay=1' })
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => { throw new Error('overlay closed') },
      chromeOverlayResult: () => {},
      onChromeOverlayResult: () => () => {},
    })
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sidebar = new SidebarUnderTest()
    const { ctx } = await mount(sidebar)
    const face = (ctx.slots.entries('settings.section')[0]!.inject as () => {
      openDevice: (deviceId: string) => void
    })()
    face.openDevice('fbcd1d21')
    await vi.waitFor(() => {
      expect(reported).toHaveBeenCalledWith(
        '[ui-phone] opening a Settings device failed:', expect.any(Error),
      )
    })
  })

  it('reports a non-cancellation failure from the main renderer Host pull', async () => {
    let listener: ((result: unknown) => void) | undefined
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayResult: (next: (result: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === '/phone/devices') throw new TypeError('Host offline')
      return new Response('{}', { status: 404 })
    }))
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sidebar = new SidebarUnderTest()
    await mount(sidebar)
    listener?.({ type: 'select', requestId: 'settings-1', id: 'phone-device:fbcd1d21' })
    await vi.waitFor(() => {
      expect(reported).toHaveBeenCalledWith(
        '[ui-phone] opening a Settings device failed:', expect.any(PhoneStreamHttpError),
      )
    })
  })

  it('refreshes the main renderer listing and waits for its settings gate before opening', async () => {
    let listener: ((result: unknown) => void) | undefined
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayResult: (next: (result: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    })
    let listingPulls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/phone/devices') return new Response('{}', { status: 404 })
      listingPulls += 1
      return new Response(JSON.stringify({
        android: [{ id: 'fbcd1d21', name: 'MI 8', kind: 'real', state: 'online', online: true }],
        ios: { simulators: [], reals: [] },
      }), { status: 200 })
    }))
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    await mount(sidebar, host)
    listener?.({ type: 'select', requestId: 'settings-1', id: 'unrelated' })
    listener?.({ type: 'select', requestId: 'settings-1', id: 'phone-device:fbcd1d21' })
    await vi.waitFor(() => { expect(listingPulls).toBe(1) })
    expect(sidebar.updates).toEqual([])
    host.publish({
      status: 'ready', writable: true, value: { enabled: true },
      base: { enabled: false }, user: { enabled: true }, revision: 1,
    })
    await vi.waitFor(() => {
      expect(sidebar.updates.at(-1)?.patch).toMatchObject({
        title: '手机·MI 8', meta: { serial: 'fbcd1d21' },
      })
    })
  })

  it('rejects a Settings selection that is offline in a fresh Host listing', async () => {
    let listener: ((result: unknown) => void) | undefined
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayResult: (next: (result: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    })
    let listingPulls = 0
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/phone/devices') return new Response('{}', { status: 404 })
      listingPulls += 1
      return new Response(JSON.stringify({
        android: [{
          id: 'fbcd1d21', name: 'MI 8', kind: 'real',
          state: listingPulls === 1 ? 'online' : 'offline', online: listingPulls === 1,
        }],
        ios: { simulators: [], reals: [] },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    host.publish({ status: 'ready', value: { enabled: true } })
    const { ctx } = await mount(sidebar, host)
    const face = (ctx.slots.entries('settings.section')[0]!.inject as () => {
      hooks: { phoneSettingsCard: { getSnapshot: () => { view: { kind: string } } } }
    })()
    await vi.waitFor(() => { expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('ready') })
    expect(listingPulls).toBe(1)
    listener?.({ type: 'select', requestId: 'settings-1', id: 'phone-device:fbcd1d21' })
    await vi.waitFor(() => { expect(listingPulls).toBe(2) })
    expect(sidebar.updates).toEqual([])
  })

  it('keeps the latest Settings selection when an older Host pull finishes last', async () => {
    let listener: ((result: unknown) => void) | undefined
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayResult: (next: (result: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    })
    const replies: Array<(response: Response) => void> = []
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/phone/devices') return Promise.resolve(new Response('{}', { status: 404 }))
      const signal = init?.signal
      if (!(signal instanceof AbortSignal)) throw new Error('selection fetch requires a signal')
      signals.push(signal)
      return new Promise<Response>((resolve, reject) => {
        replies.push(resolve)
        signal.addEventListener('abort', () => {
          reject(new DOMException('selection superseded', 'AbortError'))
        }, { once: true })
      })
    }))
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    await mount(sidebar, host)
    listener?.({ type: 'select', requestId: 'settings-1', id: 'phone-device:older' })
    listener?.({ type: 'select', requestId: 'settings-2', id: 'phone-device:newer' })
    await vi.waitFor(() => { expect(replies).toHaveLength(2) })
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    replies[1]!(new Response(JSON.stringify({
      android: [{ id: 'newer', name: 'Latest device', kind: 'real', state: 'online', online: true }],
      ios: { simulators: [], reals: [] },
    }), { status: 200 }))
    replies[0]!(new Response(JSON.stringify({
      android: [{ id: 'older', name: 'Old device', kind: 'real', state: 'online', online: true }],
      ios: { simulators: [], reals: [] },
    }), { status: 200 }))
    host.publish({ status: 'ready', value: { enabled: true } })
    await vi.waitFor(() => {
      expect(sidebar.updates.at(-1)?.patch).toMatchObject({
        title: '手机·Latest device', meta: { serial: 'newer' },
      })
    })
  })

  it('releases an obsolete Settings selection gate wait immediately', async () => {
    let listener: ((result: unknown) => void) | undefined
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayResult: (next: (result: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    })
    const replies: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/phone/devices') return Promise.resolve(new Response('{}', { status: 404 }))
      return new Promise<Response>((resolve) => { replies.push(resolve) })
    }))
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    await mount(sidebar, host)
    const baselineListeners = host.listenerCount()
    listener?.({ type: 'select', requestId: 'settings-1', id: 'phone-device:older' })
    await vi.waitFor(() => { expect(replies).toHaveLength(1) })
    replies[0]!(new Response(JSON.stringify({
      android: [{ id: 'older', name: 'Old device', kind: 'real', state: 'online', online: true }],
      ios: { simulators: [], reals: [] },
    }), { status: 200 }))
    await vi.waitFor(() => { expect(host.listenerCount()).toBe(baselineListeners + 1) })
    listener?.({ type: 'select', requestId: 'settings-2', id: 'phone-device:newer' })
    await vi.waitFor(() => { expect(host.listenerCount()).toBe(baselineListeners) })
  })

  it('drops a pending Settings selection when the main renderer disposes', async () => {
    let listener: ((result: unknown) => void) | undefined
    vi.stubGlobal('dshDesktop', {
      chromeOverlayGetState: async () => null,
      chromeOverlayResult: () => {},
      onChromeOverlayResult: (next: (result: unknown) => void) => {
        listener = next
        return () => { listener = undefined }
      },
    })
    let reply: ((response: Response) => void) | undefined
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== '/phone/devices') return Promise.resolve(new Response('{}', { status: 404 }))
      if (!(init?.signal instanceof AbortSignal)) throw new Error('selection fetch requires a signal')
      requestSignal = init.signal
      return new Promise<Response>((resolve) => { reply = resolve })
    }))
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    const { fiber } = await mount(sidebar, host)
    listener?.({ type: 'select', requestId: 'settings-1', id: 'phone-device:fbcd1d21' })
    await vi.waitFor(() => { expect(reply).toBeTypeOf('function') })
    await fiber.dispose()
    expect(listener).toBeUndefined()
    expect(requestSignal?.aborted).toBe(true)
    reply!(new Response(JSON.stringify({
      android: [{ id: 'fbcd1d21', name: 'MI 8', kind: 'real', state: 'online', online: true }],
      ios: { simulators: [], reals: [] },
    }), { status: 200 }))
    host.publish({ status: 'ready', value: { enabled: true } })
    await Promise.resolve()
    await Promise.resolve()
    expect(sidebar.opens).toEqual([])
  })

  it('falls back to probe-failed when the fleet listing is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true },
      base: { enabled: false },
      user: { enabled: true },
      revision: 1,
    })
    const { ctx } = await mount(sidebar, host)
    const entry = ctx.slots.entries('settings.section')[0]!
    const face = (entry.inject as () => {
      hooks: { phoneSettingsCard: { getSnapshot: () => { view: { kind: string } } } }
    })()
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('errors')
    })
  })

  it('wires the browser clipboard into the settings card when one exists', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const sidebar = new SidebarUnderTest()
    const { ctx } = await mount(sidebar)
    const entry = ctx.slots.entries('settings.section')[0]!
    const face = (entry.inject as () => { copyCommand: (command: string) => void })()
    face.copyCommand('sdkmanager "platform-tools"')
    expect(writeText).toHaveBeenCalledWith('sdkmanager "platform-tools"')
  })

  it('reads the durable enable flag once the Host scope is ready', async () => {
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true },
      base: { enabled: false },
      user: { enabled: true },
      revision: 1,
    })
    await mount(sidebar, host)
    expect(sidebar.getTab('phone')!.component({ tab: { id: 'phone', title: '手机' }, visible: false })).toBeTruthy()
  })

  it('uses composition enablement when the ready Host scope has no namespace value', async () => {
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    host.publish({
      status: 'ready',
      writable: true,
      value: undefined,
      base: undefined,
      user: undefined,
      revision: 1,
    })
    await mount(sidebar, host, Config({ enabled: true }))
    const picker = sidebar.getTab('phone')!.component({
      tab: { id: 'phone', title: '手机' }, visible: false,
    }) as { props: { gate: { snapshot(): boolean } } }
    expect(picker.props.gate.snapshot()).toBe(true)
  })

  it('uses composition enablement until the Host scope publishes its durable value', async () => {
    const sidebar = new SidebarUnderTest()
    const host = stubSettingsScope<PhoneSettings>()
    await mount(sidebar, host, Config({ enabled: true }))
    const picker = sidebar.getTab('phone')!.component({
      tab: { id: 'phone', title: '手机' }, visible: false,
    }) as { props: { gate: { snapshot(): boolean; subscribe(listener: () => void): () => void } } }
    expect(picker.props.gate.snapshot()).toBe(true)

    const invalidations: boolean[] = []
    const stop = picker.props.gate.subscribe(() => { invalidations.push(picker.props.gate.snapshot()) })
    host.publish({
      status: 'ready', writable: true, value: { enabled: false }, base: { enabled: false }, user: {}, revision: 1,
    })
    expect(invalidations.at(-1)).toBe(false)
    stop()
  })

  it('renders a restored device occupation with the wired switcher and controller factory', async () => {
    const sidebar = new SidebarUnderTest()
    await mount(sidebar, undefined, Config({ enabled: true }))
    const body = sidebar.getTab('phone')!.component({
      tab: {
        id: 'phone', title: '手机·SM-S9310',
        meta: { kind: 'device', serial: 'R3CN30', name: 'SM-S9310' },
      },
      visible: false,
    }) as {
      props: {
        serial: string
        name: string
        visible: boolean
        onOpenDevice(serial: string, name: string): void
        createController(serial: string): { snapshot(): { kind: string }; dispose(): void }
      }
    }
    expect(body.props).toMatchObject({ serial: 'R3CN30', name: 'SM-S9310', visible: false })
    body.props.onOpenDevice('emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.updates).toEqual([{
      tabId: 'phone',
      patch: {
        title: '手机·Pixel_6_API_35',
        meta: { kind: 'device', serial: 'emulator-5554', name: 'Pixel_6_API_35' },
      },
    }])
    const controller = body.props.createController('R3CN30')
    expect(controller.snapshot()).toEqual({ kind: 'idle' })
    controller.dispose()
  })

  it('drives both badge arms from the injected snapshot values', async () => {
    const badgeOf = (source: PhoneListingSource) =>
      buildPhoneTabDescriptor({
        source,
        view: stubView(),
        isEnabled: () => false,
        gate: { snapshot: () => false, subscribe: () => () => undefined },
        switchDevice: () => {},
        createController: () => {
          throw new Error('not expected in this spec')
        },
      }).badge!
    // Quiet arm: no online devices hides the strip pill.
    expect(badgeOf(sourceWith(0))(undefined, undefined, undefined)).toBeNull()
    // Live arm: the pill shows the online count.
    expect(badgeOf(sourceWith(2))(undefined, undefined, undefined)).toBe(2)

    // The shipped apply wires the default no-device source into its badge.
    const sidebar = new SidebarUnderTest()
    await mount(sidebar)
    expect(sidebar.getTab('phone')!.badge(undefined, undefined, undefined)).toBeNull()
  })

  it('removes the registration when the plugin fiber disposes', async () => {
    const sidebar = new SidebarUnderTest()
    const { fiber } = await mount(sidebar)
    expect(sidebar.getTab('phone')).toBeDefined()
    await fiber.dispose()
    expect(sidebar.getTab('phone')).toBeUndefined()
  })

  it('aborts the settings runtime pull when the plugin fiber disposes', async () => {
    let runtimeSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (path === '/phone/environment') {
        runtimeSignal = init?.signal ?? undefined
        return await new Promise<Response>(() => {})
      }
      return new Response(JSON.stringify({ android: [], ios: { simulators: [], reals: [] } }))
    }))
    const sidebar = new SidebarUnderTest()
    const { fiber } = await mount(sidebar)
    await vi.waitFor(() => { expect(runtimeSignal).toBeDefined() })

    await fiber.dispose()

    expect(runtimeSignal?.aborted).toBe(true)
  })

  describe('Config gate', () => {
    it('defaults enabled to false', () => {
      expect(Config({})).toEqual({ enabled: false })
    })

    it('accepts an explicit true', () => {
      expect(Config({ enabled: true })).toEqual({ enabled: true })
    })

    it('rejects non-boolean values loud', () => {
      expect(() => Config({ enabled: 'yes' as never })).toThrow()
    })
  })
})
