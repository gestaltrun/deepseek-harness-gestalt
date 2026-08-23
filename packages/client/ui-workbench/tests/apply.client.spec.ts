/** Host apply writes the snapshot prefs patch; the client half binds official pages. */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, inject, name } from '../src/index.ts'
import { apply as applyClient, inject as clientInject } from '../src/client/index.ts'
import * as WorkbenchInvariant from '../src/invariant.ts'
import { SNAPSHOT_PREFS_NS } from '../src/snapshot-browser.ts'

const NS = settingsNamespace(SNAPSHOT_PREFS_NS)

class SettingsService extends Service {
  readonly values = new Map<string, Record<string, unknown>>()
  readonly updates: object[] = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  get(ns: string): unknown {
    return this.values.get(ns)
  }

  async update(ns: string, patch: object): Promise<void> {
    this.updates.push(patch)
    const current = this.values.get(ns) ?? {}
    this.values.set(ns, { ...current, ...patch })
  }
}

describe('ui-workbench host apply', () => {
  it('declares settings and the workbench plugin name', () => {
    expect(name).toBe('ui-workbench')
    expect(inject).toEqual(['settings'])
  })

  it('writes the official-browser enable patch onto the snapshot namespace', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    settings.values.set(NS, { tabsEnabled: { editor: true, browser: false }, browserInterceptLinks: true })
    await apply(ctx)
    expect(settings.updates).toEqual([{
      tabsEnabled: { editor: true, browser: true },
      browserInterceptLinks: false,
    }])
  })

  it('does not write when the snapshot already has the product state', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    settings.values.set(NS, { tabsEnabled: { git: true }, browserInterceptLinks: false })
    await apply(ctx)
    expect(settings.updates).toEqual([])
  })

  it('fails loud when the snapshot namespace is missing', async () => {
    const ctx = new Context()
    new SettingsService(ctx)
    await expect(apply(ctx)).rejects.toThrow(/dsh-better-sidebar settings namespace is not registered/)
  })

  it('fails loud when the loader has no snapshot row', async () => {
    const ctx = new Context()
    new SettingsService(ctx)
    ctx.provide('loader', { entries: () => [{ options: { id: 'ui-browser' } }] })
    await expect(apply(ctx)).rejects.toThrow(/dsh-better-sidebar settings namespace is not registered/)
  })

  it('fails loud when the snapshot row disappears before it registers', async () => {
    const ctx = new Context()
    new SettingsService(ctx)
    const entries: { options: { id: string } }[] = [{ options: { id: 'better-sidebar' } }]
    ctx.provide('loader', { entries: () => entries })
    setImmediate(() => {
      entries.splice(0, entries.length)
    })
    await expect(apply(ctx)).rejects.toThrow(/dsh-better-sidebar settings namespace is not registered/)
  })

  it('joins the snapshot fiber before writing the disable patch', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    ctx.provide('loader', {
      entries: () => [{
        options: { id: 'better-sidebar', name: '@deepseek-ai/dsh-client-better-sidebar' },
        fiber: {
          async await() {
            settings.values.set(NS, { tabsEnabled: { editor: true } })
          },
        },
      }],
    })
    await apply(ctx)
    expect(settings.updates).toEqual([{
      tabsEnabled: { editor: true, browser: true },
      browserInterceptLinks: false,
    }])
  })

  it('recognizes the snapshot by package name when the entry id differs', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    ctx.provide('loader', {
      entries: () => [{
        options: { id: 'web-ui-better-sidebar', name: '@deepseek-ai/dsh-client-better-sidebar' },
        fiber: {
          async await() {
            settings.values.set(NS, {})
          },
        },
      }],
    })
    await apply(ctx)
    expect(settings.updates).toEqual([{
      tabsEnabled: { browser: true },
      browserInterceptLinks: false,
    }])
  })

  it('waits one turn when the snapshot fiber has not been created yet', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    const entry: { options: { id: string }; fiber?: { await(): Promise<void> } } = {
      options: { id: 'better-sidebar' },
    }
    ctx.provide('loader', { entries: () => [entry] })
    setImmediate(() => {
      settings.values.set(NS, { tabsEnabled: { git: true } })
    })
    await apply(ctx)
    expect(settings.updates).toEqual([{
      tabsEnabled: { git: true, browser: true },
      browserInterceptLinks: false,
    }])
  })
})

describe('ui-workbench client apply', () => {
  it('fails loud when the snapshot client has not published betterSidebar', () => {
    expect([...clientInject]).toEqual([
      'betterSidebar', 'sessions', 'remote', 'remote.browserWorkspace', 'settingsScope',
    ])
    const ctx = new Context()
    expect(() => { applyClient(ctx) }).toThrow(/betterSidebar is not published/)
  })

  it('publishes workbenchBrowser and ticks the official-page bridge', async () => {
    const ctx = new Context()
    class RemoteService extends Service {
      constructor() { super(ctx, 'remote') }
    }
    new RemoteService()
    const sidebar = {
      openTab: vi.fn(),
      updateTab: vi.fn(),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      setPanelOpen: vi.fn(),
      getSnapshot: () => ({
        sessionId: 's1',
        state: {
          panelOpen: false,
          splits: { kind: 'leaf' as const, tabs: [{ id: 'browser:1', type: 'browser' }] },
        },
      }),
      subscribeState: (listener: () => void) => {
        listener()
        return () => {}
      },
    }
    ctx.provide('betterSidebar', sidebar)
    ctx.provide('remote.browserWorkspace', {
      create: async () => ({
        ok: true as const,
        value: {
          status: 'open',
          target: { profileId: 'p', workspaceId: 'w', browserId: 'b', tabId: 't' },
          title: 'Created',
        },
      }),
    })
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ byId: { s1: { projectionValues: {} } } }),
        subscribe: (listener: () => void) => {
          listener()
          return () => {}
        },
      },
    })
    ctx.provide('settingsScope', {
      bind: () => ({
        getSnapshot: () => ({ value: { defaultKind: 'shared', defaultPersistentName: '', namedProfiles: [] } }),
      }),
    })
    await ctx.plugin({ inject: [...clientInject], apply: applyClient }).await()
    await Promise.resolve()
    expect(sidebar.updateTab).toHaveBeenCalled()
    const face = ctx.get('workbenchBrowser') as {
      reveal: (id: string) => void
      renderTab: (props: { ctx: Context; tab: { id: string }; scope: { sessionId: string } }) => unknown
      createRequest: () => { profile: string }
      ensureOfficial: (tabId: string) => void
    }
    expect(typeof face.reveal).toBe('function')
    expect(typeof face.renderTab).toBe('function')
    expect(typeof face.createRequest).toBe('function')
    expect(typeof face.ensureOfficial).toBe('function')
    face.reveal('s1')
    expect(sidebar.setPanelOpen).toHaveBeenCalledWith(true)
    expect(face.renderTab({ ctx, tab: { id: 'browser:1' }, scope: { sessionId: 's1' } })).toBeTruthy()
    expect(face.createRequest()).toEqual({ profile: 'shared' })
    face.ensureOfficial('browser:1')
  })

  it('subscribes only to the session list when subscribeState is absent', async () => {
    const ctx = new Context()
    class RemoteService extends Service {
      constructor() { super(ctx, 'remote') }
    }
    new RemoteService()
    ctx.provide('betterSidebar', {
      openTab: vi.fn(),
      updateTab: vi.fn(),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      setPanelOpen: vi.fn(),
      getSnapshot: () => ({}),
    })
    ctx.provide('remote.browserWorkspace', {})
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ byId: {} }),
        subscribe: () => () => {},
      },
    })
    ctx.provide('settingsScope', {
      bind: () => ({ getSnapshot: () => ({ value: undefined }) }),
    })
    await expect(ctx.plugin({ inject: [...clientInject], apply: applyClient }).await()).resolves.toBeDefined()
  })
})

describe('ui-workbench invariant', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(WorkbenchInvariant)
    await fiber.await()
    expect(WorkbenchInvariant.name).toBe('client-ui-workbench-invariant')
    expect(WorkbenchInvariant.inject).toEqual(['invariants'])
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
