/**
 * Registration contract of the phone tab on a fake better-sidebar registry:
 * descriptor shape, badge value arms, gate config, and fiber-disposal
 * symmetry (apply registers id 'phone'; disposing the plugin fiber removes
 * it — mirrors what the invariant companion proves at runtime).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, Config, inject } from '../src/client/index.tsx'
import { RecordingSidebar } from '../src/invariant.ts'
import {
  buildPhoneTabDescriptor, installPhoneTab, NULL_PHONE_BADGE_SOURCE,
  type PhoneBadgeSource, type PhoneTabView,
} from '../src/client/registry.ts'

/** A registered tab descriptor as this suite observes it. */
interface RegisteredTab {
  available: (ctx: unknown, scope: unknown, state: unknown) => boolean
  badge: (ctx: unknown, scope: unknown, state: unknown) => number | null
  component: () => unknown
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

function sourceWith(onlineCount: number): PhoneBadgeSource {
  return { getBadge: () => ({ onlineCount }), listDevices: () => [] }
}

async function mount(sidebar: SidebarUnderTest) {
  const ctx = new Context()
  ctx.provide('betterSidebar', sidebar)
  // The loader hands apply the schema-validated config; mimic its default here.
  const fiber = ctx.plugin({
    inject: [...inject],
    apply: (pluginCtx: Context) => { apply(pluginCtx, Config({})) },
  })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-phone client apply', () => {
  it('declares only the Side card service edge', () => {
    expect([...inject]).toEqual(['betterSidebar'])
  })

  it('fails loud when betterSidebar has not been published', () => {
    const ctx = new Context()
    expect(() => installPhoneTab(ctx, {
      source: NULL_PHONE_BADGE_SOURCE, view: stubView(),
    })).toThrow(/betterSidebar is not published/)
  })

  it('registers the locked 「手机」descriptor shape', async () => {
    const sidebar = new SidebarUnderTest()
    await mount(sidebar)
    const descriptor = sidebar.getTab('phone')
    expect(descriptor).toBeDefined()
    expect(descriptor!.title).toBe('手机')
    expect(descriptor!.order).toBe(55)
    expect(descriptor!.single).toBe(true)
    // 恒可达 decision: zero devices never disables the + menu row.
    expect(descriptor!.available(undefined, undefined, undefined)).toBe(true)
    // The monochrome inline SVG resolves the icon(size) contract.
    expect(descriptor!.icon(14)).toBeTruthy()
  })

  it('drives both badge arms from the injected snapshot values', async () => {
    const badgeOf = (source: PhoneBadgeSource) =>
      buildPhoneTabDescriptor({ source, view: stubView() }).badge!
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
