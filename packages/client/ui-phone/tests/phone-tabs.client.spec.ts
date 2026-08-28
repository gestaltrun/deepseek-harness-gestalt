/**
 * Per-device phone tab semantics on a fake better-sidebar that mirrors the
 * documented openTab contract (default seed mint, dedupeKey focus, id
 * safety net): the same serial focuses the existing tab instead of
 * rebuilding it, different serials coexist as separate tabs, the + menu
 * picker stays single-instance, and a disabled deployment refuses opens.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPhoneTabDescriptor, createPhoneTabOpener, installPhoneTab, PHONE_TAB_ID,
  phoneDeviceTabMetaOf,
  type PhoneTabDescriptor, type PhoneTabView,
} from '../src/client/registry.ts'
import { createHttpPhoneListingSource } from '../src/client/phone-listing.ts'

/** One tab instance the fake sidebar holds. */
interface FakeTab {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly meta?: unknown
}

/**
 * The documented BetterSidebarService.openTab contract in miniature for a
 * descriptor without createTab: mint `{id: seed.id ?? type, type, title,
 * meta}` from the seed, focus the existing same-type tab whose dedupeKey
 * matches (an undefined key falls to the id safety net), otherwise insert.
 */
class ContractSidebar {
  descriptor: PhoneTabDescriptor | undefined
  readonly tabs: FakeTab[] = []
  activeId: string | undefined
  readonly opened: string[] = []
  readonly activated: string[] = []

  registerTab(descriptor: PhoneTabDescriptor): () => void {
    this.descriptor = descriptor
    return () => { this.descriptor = undefined }
  }

  openTab(seed: { readonly type: string; readonly id?: string; readonly title?: string; readonly meta?: unknown }): void {
    const tab: FakeTab = {
      id: seed.id ?? seed.type,
      type: seed.type,
      title: seed.title ?? '手机',
      ...(seed.meta !== undefined ? { meta: seed.meta } : {}),
    }
    const dedupeKey = this.descriptor?.dedupeKey
    const key = dedupeKey?.(tab)
    const existing = (key !== undefined
      ? this.tabs.find(candidate => candidate.type === tab.type && dedupeKey!(candidate) === key)
      : this.tabs.find(candidate => candidate.id === tab.id))
    if (existing !== undefined) {
      this.activeId = existing.id
      this.activated.push(existing.id)
      return
    }
    this.tabs.push(tab)
    this.activeId = tab.id
    this.opened.push(tab.id)
  }
}

function stubView(): PhoneTabView {
  return { icon: () => null, component: () => null }
}

describe('per-device phone tabs', () => {
  it('focuses the existing tab when the same serial opens twice', () => {
    const sidebar = new ContractSidebar()
    sidebar.registerTab(buildPhoneTabDescriptor({
      source: createHttpPhoneListingSource(), view: stubView(), isEnabled: () => true,
      openDevice: createPhoneTabOpener(sidebar, () => true),
      createController: () => {
        throw new Error('not expected in this spec')
      },
    }))
    const openDevice = createPhoneTabOpener(sidebar, () => true)
    openDevice('emulator-5554', 'Pixel_6_API_35')
    openDevice('emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.tabs).toHaveLength(1)
    expect(sidebar.tabs[0]).toMatchObject({ id: 'phone:emulator-5554', title: '手机·Pixel_6_API_35' })
    expect(sidebar.opened).toEqual(['phone:emulator-5554'])
    expect(sidebar.activated).toEqual(['phone:emulator-5554'])
    expect(sidebar.activeId).toBe('phone:emulator-5554')
  })

  it('opens one tab per serial and keys dedupe on the serial only', () => {
    const sidebar = new ContractSidebar()
    sidebar.registerTab(buildPhoneTabDescriptor({
      source: createHttpPhoneListingSource(), view: stubView(), isEnabled: () => true,
      openDevice: createPhoneTabOpener(sidebar, () => true),
      createController: () => {
        throw new Error('not expected in this spec')
      },
    }))
    const openDevice = createPhoneTabOpener(sidebar, () => true)
    openDevice('emulator-5554', 'Pixel_6_API_35')
    openDevice('R3CN30', 'SM-S9310')
    openDevice('emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.tabs.map(tab => tab.id)).toEqual(['phone:emulator-5554', 'phone:R3CN30'])
    expect(sidebar.opened).toEqual(['phone:emulator-5554', 'phone:R3CN30'])
    expect(sidebar.activeId).toBe('phone:emulator-5554')
  })

  it('keeps the + menu picker single-instance through the id safety net', () => {
    const sidebar = new ContractSidebar()
    sidebar.registerTab(buildPhoneTabDescriptor({
      source: createHttpPhoneListingSource(), view: stubView(), isEnabled: () => true,
      openDevice: createPhoneTabOpener(sidebar, () => true),
      createController: () => {
        throw new Error('not expected in this spec')
      },
    }))
    sidebar.openTab({ type: PHONE_TAB_ID })
    sidebar.openTab({ type: PHONE_TAB_ID })
    expect(sidebar.tabs).toHaveLength(1)
    expect(sidebar.tabs[0]!.id).toBe(PHONE_TAB_ID)
    // The picker tab carries no serial, so the dedupeKey leaves it to the id net.
    expect(sidebar.descriptor!.dedupeKey?.(sidebar.tabs[0]!)).toBeUndefined()
    expect(sidebar.opened).toEqual([PHONE_TAB_ID])
    expect(sidebar.activated).toEqual([PHONE_TAB_ID])
  })

  it('mints the device meta the connected view reads back', () => {
    expect(phoneDeviceTabMetaOf({ kind: 'device', serial: 'R3CN30', name: 'SM-S9310' }))
      .toEqual({ kind: 'device', serial: 'R3CN30', name: 'SM-S9310' })
    expect(phoneDeviceTabMetaOf({ kind: 'picker' })).toBeUndefined()
    expect(phoneDeviceTabMetaOf('junk')).toBeUndefined()
    expect(phoneDeviceTabMetaOf(undefined)).toBeUndefined()
  })

  it('drops device-tab opens while the deployment disables connections', () => {
    const sidebar = new ContractSidebar()
    sidebar.registerTab(buildPhoneTabDescriptor({
      source: createHttpPhoneListingSource(), view: stubView(), isEnabled: () => false,
      openDevice: createPhoneTabOpener(sidebar, () => false),
      createController: () => {
        throw new Error('not expected in this spec')
      },
    }))
    const openDevice = createPhoneTabOpener(sidebar, () => false)
    openDevice('emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.tabs).toHaveLength(0)
    expect(sidebar.opened).toHaveLength(0)
  })

  it('installs the fiber-owned opener and hands it to the body environment', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const sidebar = new ContractSidebar()
    const seen: { readonly props: unknown; readonly env: unknown }[] = []
    const ctx = new Context()
    let gate = true
    ctx.provide('betterSidebar', sidebar)
    installPhoneTab(ctx, {
      source: createHttpPhoneListingSource(),
      view: {
        icon: () => null,
        component: (props, env) => {
          seen.push({ props, env })
          return null
        },
      },
      isEnabled: () => gate,
      createController: () => {
        throw new Error('not expected in this spec')
      },
    })
    // The descriptor supplies its own environment; the opener wired against
    // the resolved fake sidebar rides inside it.
    const descriptor = sidebar.descriptor!
    const deviceTab = {
      tab: { id: 'phone:emulator-5554', title: '手机·Pixel_6_API_35', meta: { kind: 'device', serial: 'emulator-5554', name: 'Pixel_6_API_35' } },
      visible: true,
    }
    descriptor.component(deviceTab)
    expect(seen).toHaveLength(1)
    const env = seen[0]!.env as { isEnabled(): boolean; openDevice(serial: string, name: string): void }
    expect(env.isEnabled()).toBe(true)
    env.openDevice('emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.tabs.map(tab => tab.id)).toEqual(['phone:emulator-5554'])
    gate = false
    env.openDevice('R3CN30', 'SM-S9310')
    expect(sidebar.tabs).toHaveLength(1)
  })
})
