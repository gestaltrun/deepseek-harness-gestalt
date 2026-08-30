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
  override getTab(id: string): RegisteredTab | undefined {
    return super.getTab(id) as RegisteredTab | undefined
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

async function mount(sidebar: SidebarUnderTest, settings?: ReturnType<typeof stubSettingsScope<PhoneSettings>>) {
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
    apply: (pluginCtx: Context) => { apply(pluginCtx as never, Config({})) },
  })
  await fiber.await()
  return { ctx, fiber, host }
}

describe('ui-phone client apply', () => {
  afterEach(() => { vi.unstubAllGlobals() })

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
    expect(() => installPhoneTab(ctx, {
      source: createHttpPhoneListingSource(),
      view: stubView(),
      isEnabled: () => false,
      gate: { snapshot: () => false, subscribe: () => () => undefined },
      createController: () => {
        throw new Error('not expected in this spec')
      },
    })).toThrow(/betterSidebar is not published/)
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
    })()
    await vi.waitFor(() => {
      expect(face.hooks.phoneSettingsCard.getSnapshot().view.kind).toBe('ready')
    })
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
