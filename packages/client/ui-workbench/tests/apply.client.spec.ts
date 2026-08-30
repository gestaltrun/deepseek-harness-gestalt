/** Host apply writes the snapshot prefs patch; the client half binds official pages. */
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, inject, name } from '../src/index.ts'
import { apply as applyClient, inject as clientInject } from '../src/client/index.ts'
import * as WorkbenchInvariant from '../src/invariant.ts'
import { SNAPSHOT_PREFS_NS } from '../src/snapshot-browser.ts'

const NS = settingsNamespace(SNAPSHOT_PREFS_NS)
const TARGET = { profileId: 'p', workspaceId: 'w', browserId: 'b', tabId: 't' }

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

class SnapshotDependency extends Service {
  constructor(ctx: Context) {
    super(ctx, 'snapshotDependency')
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
    const entries: { options: { id: string } }[] = [{ options: { id: 'ui-better-sidebar' } }]
    ctx.provide('loader', { entries: () => entries })
    queueMicrotask(() => {
      entries.splice(0, entries.length)
      ctx.emit('loader/partial-dispose', {} as never, {} as never, false)
    })
    await expect(apply(ctx)).rejects.toThrow(/dsh-better-sidebar settings namespace is not registered/)
  })

  it('joins the snapshot fiber before writing the disable patch', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    ctx.provide('loader', {
      entries: () => [{
        options: { id: 'ui-better-sidebar', name: '@deepseek-ai/dsh-client-ui-better-sidebar' },
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
        options: { id: 'web-ui-better-sidebar', name: '@deepseek-ai/dsh-client-ui-better-sidebar' },
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

  it('waits for a pending snapshot fiber to register its namespace', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    const entry: {
      options: { id: string }
      fiber?: { await(): Promise<unknown> }
    } = {
      options: { id: 'ui-better-sidebar' },
    }
    ctx.provide('loader', { entries: () => [entry] })
    entry.fiber = ctx.plugin({
      inject: ['snapshotDependency'],
      apply() {
        settings.values.set(NS, { tabsEnabled: { git: true } })
      },
    })
    const workbench = ctx.plugin({ inject, apply })
    setImmediate(() => {
      new SnapshotDependency(ctx)
    })
    await workbench.await()
    expect(settings.updates).toEqual([{
      tabsEnabled: { git: true, browser: true },
      browserInterceptLinks: false,
    }])
  })

  it('does not patch after disposal while the snapshot is pending', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    const inspected = Promise.withResolvers<undefined>()
    const entry: {
      options: { id: string }
      fiber?: { await(): Promise<unknown> }
    } = {
      options: { id: 'ui-better-sidebar' },
    }
    ctx.provide('loader', {
      entries: () => {
        inspected.resolve(undefined)
        return [entry]
      },
    })
    entry.fiber = ctx.plugin({
      inject: ['snapshotDependency'],
      apply() {
        settings.values.set(NS, { tabsEnabled: { git: true } })
      },
    })
    const workbench = ctx.plugin({ inject, apply })
    await inspected.promise
    await workbench.dispose()
    new SnapshotDependency(ctx)
    await entry.fiber.await()
    expect(settings.updates).toEqual([])
  })

  it('does not patch or reject when a lifecycle event races disposal', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    const entry = { options: { id: 'ui-better-sidebar' } }
    let reads = 0
    let disposal!: Promise<void>
    ctx.provide('loader', {
      entries: () => {
        reads += 1
        if (reads === 3) {
          ctx.emit('internal/status', ctx.fiber, FiberState.ACTIVE)
          disposal = workbench.dispose()
        }
        return [entry]
      },
    })
    const workbench = ctx.plugin({ inject, apply })
    await expect(workbench.await()).resolves.toBeDefined()
    await expect(disposal).resolves.toBeUndefined()
    expect(settings.updates).toEqual([])
  })

  it('propagates a failed snapshot row', async () => {
    const ctx = new Context()
    new SettingsService(ctx)
    const entries: Array<{
      options: { id: string }
      fiber?: { state?: FiberState; await(): Promise<unknown> }
    }> = [{
      options: { id: 'ui-better-sidebar' },
      fiber: {
        state: FiberState.FAILED,
        async await() {
          throw new Error('snapshot row failed')
        },
      },
    }]
    ctx.provide('loader', { entries: () => entries })
    await expect(ctx.plugin({ inject, apply }).await()).rejects.toThrow(/snapshot row failed/)
  })

  it('ignores an unrelated failed loader row while the snapshot registers', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    const unrelated = {
      state: FiberState.FAILED,
      async await() {
        throw new Error('unrelated loader row failed')
      },
    }
    const entries = [
      { options: { id: 'ui-better-sidebar' } },
      { options: { id: 'unrelated-plugin' }, fiber: unrelated },
    ]
    ctx.provide('loader', { entries: () => entries })
    const workbench = ctx.plugin({ inject, apply })
    setImmediate(() => {
      settings.values.set(NS, { tabsEnabled: { git: true } })
      ctx.emit('internal/status', unrelated as never, FiberState.LOADING)
    })
    await workbench.await()
    expect(settings.updates).toEqual([{
      tabsEnabled: { git: true, browser: true },
      browserInterceptLinks: false,
    }])
  })

  it('waits for the snapshot fiber to be created without polling', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    const entry: {
      options: { id: string }
      fiber?: { await(): Promise<unknown> }
    } = {
      options: { id: 'ui-better-sidebar' },
    }
    ctx.provide('loader', { entries: () => [entry] })
    const workbench = ctx.plugin({ inject, apply })
    queueMicrotask(() => {
      settings.values.set(NS, { tabsEnabled: { git: true } })
      entry.fiber = ctx.plugin({ apply() {} })
    })
    await workbench.await()
    expect(settings.updates).toEqual([{
      tabsEnabled: { git: true, browser: true },
      browserInterceptLinks: false,
    }])
  })

  it('patches a namespace that registers before the lifecycle observer settles', async () => {
    const ctx = new Context()
    const settings = new SettingsService(ctx)
    const entry = { options: { id: 'ui-better-sidebar' } }
    let reads = 0
    ctx.provide('loader', {
      entries: () => {
        reads += 1
        if (reads === 3) settings.values.set(NS, { tabsEnabled: { git: true } })
        return [entry]
      },
    })
    await ctx.plugin({ inject, apply }).await()
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
      recoverOfficial: (tabId: string, target: typeof TARGET) => Promise<unknown>
    }
    expect(typeof face.reveal).toBe('function')
    expect(typeof face.renderTab).toBe('function')
    expect(typeof face.createRequest).toBe('function')
    expect(typeof face.ensureOfficial).toBe('function')
    expect(typeof face.recoverOfficial).toBe('function')
    face.reveal('s1')
    expect(sidebar.setPanelOpen).toHaveBeenCalledWith(true)
    expect(face.renderTab({ ctx, tab: { id: 'browser:1' }, scope: { sessionId: 's1' } })).toBeTruthy()
    expect(face.createRequest()).toEqual({ profile: 'shared' })
    face.ensureOfficial('browser:1')
    await expect(face.recoverOfficial('browser:1', TARGET)).resolves.toBeUndefined()
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
