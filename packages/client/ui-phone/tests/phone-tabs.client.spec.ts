/**
 * Single phone tab with in-place device switching (U1, reversing the
 #419 per-device model): 打开 and the device dropdown patch the one
 tab instance's meta via the sidebar's updateTab — the tab strip keeps
 a single 「手机」 tab, and a disabled deployment refuses switches.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPhoneTabDescriptor, createPhoneTabSwitcher, installPhoneTab, openPhoneTabOf, PHONE_TAB_ID, PHONE_TAB_TITLE,
  openPhoneDevicePanel, phoneDeviceTabMetaOf, phoneTabTitleOf, showPhonePicker,
  type PhoneListingSource, type PhoneSidebarState, type PhoneTabDescriptor, type PhoneTabView,
} from '../src/client/registry.ts'

/** One tab instance the fake sidebar holds. */
interface FakeTab {
  readonly id: string
  readonly type: string
  title: string
  meta?: unknown
}

/**
 * The documented sidebar contract in miniature: registerTab holds one
 * descriptor, openTab mints `{id: seed.id ?? type, …}` (single:true
 * focuses the existing instance), updateTab patches title/meta in place.
 */
class ContractSidebar {
  descriptor: PhoneTabDescriptor | undefined
  readonly tabs: FakeTab[] = []
  activeId: string | undefined
  readonly opened: string[] = []
  readonly activated: string[] = []
  readonly patches: { readonly tabId: string; readonly patch: { readonly title?: string; readonly meta?: unknown } }[] = []
  panelOpen = false

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
    const existing = this.tabs.find(candidate => candidate.id === tab.id)
    if (existing !== undefined) {
      this.activeId = existing.id
      this.activated.push(existing.id)
      return
    }
    this.tabs.push(tab)
    this.activeId = tab.id
    this.opened.push(tab.id)
  }

  updateTab(tabId: string, patch: { readonly title?: string; readonly meta?: unknown }): void {
    const tab = this.tabs.find(candidate => candidate.id === tabId)
    if (tab === undefined) return
    if (patch.title !== undefined) tab.title = patch.title
    if (patch.meta !== undefined) tab.meta = patch.meta
    this.patches.push({ tabId, patch })
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open
  }

  getSnapshot(): {
    readonly state: {
      readonly splits: { readonly kind: 'leaf'; readonly tabs: readonly FakeTab[]; readonly active: string | null }
      readonly bottomSplits: { readonly kind: 'leaf'; readonly tabs: readonly []; readonly active: null }
      readonly floats: readonly []
    }
  } {
    return {
      state: {
        splits: { kind: 'leaf', tabs: this.tabs, active: this.activeId ?? null },
        bottomSplits: { kind: 'leaf', tabs: [], active: null },
        floats: [],
      },
    }
  }
}

function stubView(): PhoneTabView {
  return { icon: () => null, component: () => null }
}

const NULL_SOURCE: PhoneListingSource = {
  getBadge: () => ({ onlineCount: 0 }),
  snapshot: () => ({ android: [], ios: [] }),
  refresh: async () => {},
  subscribe: () => () => {},
}

const zhTitle = (): string => PHONE_TAB_TITLE
const zhOccupiedTitle = (name: string): string => phoneTabTitleOf(name)
const enTitle = (): string => 'Phone'
const enOccupiedTitle = (name: string): string => `Phone · ${name}`

describe('single phone tab with in-place switching', () => {
  it('opens a Settings device in the singleton visible panel', () => {
    const sidebar = new ContractSidebar()
    openPhoneDevicePanel(sidebar, () => true, 'fbcd1d21', 'MI 8', zhOccupiedTitle)
    expect(sidebar.tabs).toEqual([{
      id: PHONE_TAB_ID,
      type: PHONE_TAB_ID,
      title: '手机·MI 8',
      meta: { kind: 'device', serial: 'fbcd1d21', name: 'MI 8' },
    }])
    expect(sidebar.panelOpen).toBe(true)
    openPhoneDevicePanel(sidebar, () => false, 'other', 'Blocked', zhOccupiedTitle)
    expect(sidebar.tabs).toHaveLength(1)
  })

  it('keeps a single tab and switches it in place when a device opens', () => {
    const sidebar = new ContractSidebar()
    sidebar.registerTab(buildPhoneTabDescriptor({
      source: NULL_SOURCE, view: stubView(), isEnabled: () => true,
      gate: { snapshot: () => false, subscribe: () => () => undefined },
      title: zhTitle,
      occupiedTitle: zhOccupiedTitle,
      switchDevice: (tabId, serial, name) => {
        sidebar.updateTab(tabId, {
          title: zhOccupiedTitle(name),
          meta: { kind: 'device', serial, name },
        })
      },
      showPicker: (tabId) => { showPhonePicker(sidebar, tabId, zhTitle) },
      createController: () => {
        throw new Error('not expected in this spec')
      },
    }))
    sidebar.openTab({ type: PHONE_TAB_ID })
    // U1 reverses the per-device model: one tab, switching happens in place.
    expect(sidebar.descriptor!.single).toBe(true)
  })

  it('patches the one tab in place when a device opens and re-opens', () => {
    const sidebar = new ContractSidebar()
    sidebar.registerTab(buildPhoneTabDescriptor({
      source: NULL_SOURCE, view: stubView(), isEnabled: () => true,
      gate: { snapshot: () => false, subscribe: () => () => undefined },
      title: zhTitle,
      occupiedTitle: zhOccupiedTitle,
      switchDevice: (tabId, serial, name) => {
        sidebar.updateTab(tabId, {
          title: zhOccupiedTitle(name),
          meta: { kind: 'device', serial, name },
        })
      },
      showPicker: (tabId) => { showPhonePicker(sidebar, tabId, zhTitle) },
      createController: () => {
        throw new Error('not expected in this spec')
      },
    }))
    sidebar.openTab({ type: PHONE_TAB_ID })
    const switchDevice = (serial: string, name: string): void => {
      sidebar.updateTab(PHONE_TAB_ID, {
        title: `手机·${name}`,
        meta: { kind: 'device', serial, name },
      })
    }
    switchDevice('emulator-5554', 'Pixel_6_API_35')
    switchDevice('R3CN30', 'SM-S9310')
    expect(sidebar.tabs).toHaveLength(1)
    expect(sidebar.opened).toEqual([PHONE_TAB_ID])
    expect(sidebar.tabs[0]).toMatchObject({
      id: PHONE_TAB_ID,
      title: '手机·SM-S9310',
      meta: { kind: 'device', serial: 'R3CN30', name: 'SM-S9310' },
    })
  })

  it('keeps the + menu picker single-instance', () => {
    const sidebar = new ContractSidebar()
    sidebar.registerTab(buildPhoneTabDescriptor({
      source: NULL_SOURCE, view: stubView(), isEnabled: () => true,
      gate: { snapshot: () => false, subscribe: () => () => undefined },
      title: zhTitle,
      occupiedTitle: zhOccupiedTitle,
      switchDevice: () => {},
      showPicker: () => {},
      createController: () => {
        throw new Error('not expected in this spec')
      },
    }))
    sidebar.openTab({ type: PHONE_TAB_ID })
    sidebar.openTab({ type: PHONE_TAB_ID })
    expect(sidebar.tabs).toHaveLength(1)
    expect(sidebar.tabs[0]!.id).toBe(PHONE_TAB_ID)
    expect(sidebar.opened).toEqual([PHONE_TAB_ID])
    expect(sidebar.activated).toEqual([PHONE_TAB_ID])
  })

  it('mints the device meta the connected view reads back', () => {
    expect(phoneDeviceTabMetaOf({ kind: 'device', serial: 'R3CN30', name: 'SM-S9310' }))
      .toEqual({ kind: 'device', serial: 'R3CN30', name: 'SM-S9310' })
    expect(phoneDeviceTabMetaOf({ kind: 'picker' })).toBeUndefined()
    expect(phoneDeviceTabMetaOf({ kind: 'device', serial: 42, name: 'SM-S9310' })).toBeUndefined()
    expect(phoneDeviceTabMetaOf({ kind: 'device', serial: '', name: 'SM-S9310' })).toBeUndefined()
    expect(phoneDeviceTabMetaOf({ kind: 'device', serial: 'R3CN30', name: 42 })).toBeUndefined()
    expect(phoneDeviceTabMetaOf({ kind: 'device', serial: 'R3CN30', name: '' })).toBeUndefined()
    expect(phoneDeviceTabMetaOf('junk')).toBeUndefined()
    expect(phoneDeviceTabMetaOf(undefined)).toBeUndefined()
  })

  it('clears occupation meta so the picker body with 重新检测环境 can render', () => {
    const sidebar = new ContractSidebar()
    sidebar.openTab({ type: PHONE_TAB_ID })
    const switchDevice = createPhoneTabSwitcher(sidebar, () => true, zhOccupiedTitle)
    switchDevice(PHONE_TAB_ID, 'emulator-5554', 'Pixel_6_API_35')
    expect(phoneDeviceTabMetaOf(sidebar.tabs[0]!.meta)).toEqual({
      kind: 'device', serial: 'emulator-5554', name: 'Pixel_6_API_35',
    })
    showPhonePicker(sidebar, PHONE_TAB_ID, zhTitle)
    expect(sidebar.tabs[0]).toMatchObject({ title: PHONE_TAB_TITLE, meta: {} })
    expect(phoneDeviceTabMetaOf(sidebar.tabs[0]!.meta)).toBeUndefined()
  })

  it('drops device switches while the deployment disables connections', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const sidebar = new ContractSidebar()
    const seen: { readonly env: unknown }[] = []
    const ctx = new Context()
    ctx.provide('betterSidebar', sidebar)
    installPhoneTab(ctx, {
      source: NULL_SOURCE,
      view: {
        icon: () => null,
        component: (_props, env) => {
          seen.push({ env })
          return null
        },
      },
      isEnabled: () => false,
      gate: { snapshot: () => false, subscribe: () => () => undefined },
      title: zhTitle,
      occupiedTitle: zhOccupiedTitle,
      createController: () => {
        throw new Error('not expected in this spec')
      },
    })
    sidebar.openTab({ type: PHONE_TAB_ID })
    sidebar.descriptor!.component({ tab: { id: PHONE_TAB_ID, title: '手机' }, visible: false })
    const env = seen[0]!.env as { switchDevice(tabId: string, serial: string, name: string): void }
    env.switchDevice(PHONE_TAB_ID, 'emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.patches).toHaveLength(0)
    expect(sidebar.tabs[0]!.meta).toBeUndefined()
  })

  it('installs the fiber-owned switcher and hands it to the body environment', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const sidebar = new ContractSidebar()
    const seen: { readonly props: unknown; readonly env: unknown }[] = []
    const ctx = new Context()
    let gate = true
    ctx.provide('betterSidebar', sidebar)
    installPhoneTab(ctx, {
      source: NULL_SOURCE,
      view: {
        icon: () => null,
        component: (_props, env) => {
          seen.push({ props: _props, env })
          return null
        },
      },
      isEnabled: () => gate,
      gate: { snapshot: () => gate, subscribe: () => () => undefined },
      title: zhTitle,
      occupiedTitle: zhOccupiedTitle,
      createController: () => {
        throw new Error('not expected in this spec')
      },
    })
    // The descriptor supplies its own environment; the switcher wired
    // against the resolved fake sidebar rides inside it.
    const descriptor = sidebar.descriptor!
    sidebar.openTab({ type: PHONE_TAB_ID })
    descriptor.component({ tab: { id: PHONE_TAB_ID, title: '手机', meta: undefined }, visible: true })
    expect(seen).toHaveLength(1)
    const env = seen[0]!.env as {
      isEnabled(): boolean
      switchDevice(tabId: string, serial: string, name: string): void
      showPicker(tabId: string): void
    }
    expect(env.isEnabled()).toBe(true)
    env.switchDevice(PHONE_TAB_ID, 'emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.tabs[0]).toMatchObject({
      title: '手机·Pixel_6_API_35',
      meta: { kind: 'device', serial: 'emulator-5554' },
    })
    gate = false
    env.switchDevice(PHONE_TAB_ID, 'R3CN30', 'SM-S9310')
    expect(sidebar.tabs[0]!.meta).toMatchObject({ serial: 'emulator-5554' })
    env.showPicker(PHONE_TAB_ID)
    expect(phoneDeviceTabMetaOf(sidebar.tabs[0]!.meta)).toBeUndefined()
    expect(sidebar.tabs[0]!.title).toBe(PHONE_TAB_TITLE)
  })

  it('uses English occupied titles when the title functions resolve English copy', () => {
    const sidebar = new ContractSidebar()
    const switchDevice = createPhoneTabSwitcher(sidebar, () => true, enOccupiedTitle)
    sidebar.openTab({ type: PHONE_TAB_ID })
    switchDevice(PHONE_TAB_ID, 'emulator-5554', 'Pixel_6_API_35')
    expect(sidebar.tabs[0]!.title).toBe('Phone · Pixel_6_API_35')
    showPhonePicker(sidebar, PHONE_TAB_ID, enTitle)
    expect(sidebar.tabs[0]!.title).toBe('Phone')
    openPhoneDevicePanel(sidebar, () => true, 'emulator-5554', 'Pixel_6_API_35', enOccupiedTitle)
    expect(sidebar.tabs[0]!.title).toBe('Phone · Pixel_6_API_35')
  })

  it('finds the Phone tab across split trees, nested children, and floats', () => {
    expect(openPhoneTabOf(undefined)).toBeUndefined()
    const phone = { id: PHONE_TAB_ID, type: PHONE_TAB_ID, title: '手机' }
    const nested: PhoneSidebarState = {
      splits: {
        kind: 'split',
        children: [
          { kind: 'leaf', tabs: [{ id: 'editor', type: 'editor' }], active: 'editor' },
          { kind: 'leaf', tabs: [phone], active: PHONE_TAB_ID },
        ],
      },
      bottomSplits: { kind: 'leaf', tabs: [], active: null },
      floats: [],
    }
    expect(openPhoneTabOf(nested)?.id).toBe(PHONE_TAB_ID)
    const emptyNested: PhoneSidebarState = {
      splits: {
        kind: 'split',
        children: [
          { kind: 'leaf', tabs: [{ id: 'editor', type: 'editor' }], active: 'editor' },
        ],
      },
      bottomSplits: { kind: 'leaf', tabs: [], active: null },
      floats: [],
    }
    expect(openPhoneTabOf(emptyNested)).toBeUndefined()
    const bottom: PhoneSidebarState = {
      splits: { kind: 'leaf', tabs: [{ id: 'editor', type: 'editor' }], active: 'editor' },
      bottomSplits: { kind: 'leaf', tabs: [phone], active: PHONE_TAB_ID },
      floats: [],
    }
    expect(openPhoneTabOf(bottom)?.id).toBe(PHONE_TAB_ID)
    const floating: PhoneSidebarState = {
      splits: { kind: 'leaf', tabs: [{ id: 'editor', type: 'editor' }], active: 'editor' },
      bottomSplits: { kind: 'leaf', tabs: [], active: null },
      floats: [{ tab: phone }],
    }
    expect(openPhoneTabOf(floating)?.id).toBe(PHONE_TAB_ID)
  })
})
