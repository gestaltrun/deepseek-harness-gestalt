/** Browser registration and Remote transport adapter for preview and settings. */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'
import type { BrowserPreviewActions } from '../src/client/slots.ts'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { unwrapRemote } from '../src/client/slots.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply as nodeApply } from '../src/index.ts'
import { BROWSER_SETTINGS_NAMESPACE, DEFAULT_BROWSER_SETTINGS } from '../src/browser-settings.ts'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

const sessionId = 'session-1' as SessionId
const TARGET: BrowserTarget = {
  profileId: 'profile-1' as BrowserTarget['profileId'],
  workspaceId: 'ws-1' as BrowserTarget['workspaceId'],
  browserId: 'br-1' as BrowserTarget['browserId'],
  tabId: 'tab-1' as BrowserTarget['tabId'],
}

async function bench() {
  const ctx = new Context()
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = []
  const revealed: string[] = []
  class RemoteService extends Service {
    constructor() { super(ctx, 'remote') }
  }
  new RemoteService()
  const answer = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args })
    return { ok: true as const, value: { method, args } }
  }
  ctx.provide('remote.browserWorkspace', {
    focus: answer('focus'),
    observe: answer('observe'),
    screenshot: answer('screenshot'),
  })
  ctx.provide('workbenchBrowser', {
    reveal: (id: string) => { revealed.push(id) },
    renderTab: () => null,
  })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.browser.preview': { kind: 'single', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('sessions', {})
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const preview = () => {
    const registered = ctx.slots.entries('conversation.browser.preview')[0]
    if (registered === undefined) return undefined
    return {
      ...registered,
      inject: registered.inject as unknown as ((id: SessionId) => BrowserPreviewActions) | undefined,
    }
  }
  return { ctx, calls, revealed, preview, fiber }
}

describe('ui-browser browser plugin', () => {
  it('declares and registers the collapsed preview without a details occupant', async () => {
    const b = await bench()
    expect(inject).toEqual([
      'slots', 'sessions', 'remote', 'remote.browserWorkspace', 'locale', 'settingsScope',
    ])
    expect(b.ctx.slots.entries('details')).toEqual([])
    expect(b.preview()?.locale).toBe(NS)
    const section = b.ctx.slots.entries('settings.section')[0]
    expect(section?.options).toMatchObject({ id: 'browser', order: 35 })
    const label = section?.options.label
    expect(typeof label === 'function' ? label() : label).toBe(en['settings.nav'])
    await b.fiber.dispose()
    expect(b.preview()).toBeUndefined()
    expect(b.ctx.slots.entries('settings.section')).toHaveLength(0)
  })

  it('writes Profile roster changes through the bound settings scope', async () => {
    const ctx = new Context()
    const host = stubSettingsScope()
    class RemoteService extends Service {
      constructor() { super(ctx, 'remote') }
    }
    new RemoteService()
    ctx.provide('remote.browserWorkspace', {})
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.browser.preview': { kind: 'single', scope: 'session' },
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    ctx.provide('sessions', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('settingsScope', { bind: () => host.scope })
    await ctx.plugin({ inject: [...inject], apply }).await()
    host.publish({
      status: 'ready',
      value: {
        defaultKind: 'persistent',
        defaultPersistentName: 'work',
        namedProfiles: ['work'],
      },
    })
    const injected = ctx.slots.entries('settings.section')[0]!.inject as unknown as
      () => import('../src/client/BrowserSettingsSection.tsx').BrowserSettingsInjected
    const face = injected()
    face.addNamedProfile('tmp')
    face.addNamedProfile('work')
    face.addNamedProfile('lab')
    face.removeNamedProfile('work')
    face.removeNamedProfile('lab')
    face.setDefaultKind('shared')
    face.setDefaultPersistentName('lab')
    expect(host.set.mock.calls).toEqual([
      ['namedProfiles', ['work', 'lab']],
      ['namedProfiles', []],
      ['defaultPersistentName', ''],
      ['namedProfiles', ['work']],
      ['defaultKind', 'shared'],
      ['defaultPersistentName', 'lab'],
    ])
  })

  it('forwards collapsed preview verbs and reveals the workbench', async () => {
    const b = await bench()
    const actions = b.preview()?.inject?.(sessionId)
    if (actions === undefined) throw new Error('Browser preview entry has no injected actions')
    actions.reveal()
    await actions.focus(TARGET, 3)
    await actions.observe(TARGET)
    await actions.screenshot(TARGET)
    expect(b.calls).toEqual([
      { method: 'focus', args: [sessionId, TARGET, 3] },
      { method: 'observe', args: [sessionId, TARGET] },
      { method: 'screenshot', args: [sessionId, TARGET] },
    ])
    expect(b.revealed).toEqual([sessionId])
  })

  it('keeps preview reveal inert when the workbench adapter is absent', async () => {
    const ctx = new Context()
    class RemoteService extends Service {
      constructor() { super(ctx, 'remote') }
    }
    new RemoteService()
    ctx.provide('remote.browserWorkspace', {})
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.browser.preview': { kind: 'single', scope: 'session' },
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    ctx.provide('sessions', {})
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope })
    await ctx.plugin({ inject: [...inject], apply }).await()
    const actions = ctx.slots.entries('conversation.browser.preview')[0]!.inject as unknown as
      (id: SessionId) => BrowserPreviewActions
    expect(() => { actions(sessionId).reveal() }).not.toThrow()
  })

  it('registers complete bilingual dictionaries and releases them with the fiber', async () => {
    const b = await bench()
    b.ctx.locale.setLocale('zh')
    const translate = b.ctx.locale.bind(NS)
    expect(translate('dock.creating')).toBe(zh['dock.creating'])
    b.ctx.locale.setLocale('en')
    expect(translate('dock.invalidAddress')).toBe(en['dock.invalidAddress'])
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    await b.fiber.dispose()
    expect(translate('dock.creating')).not.toBe(en['dock.creating'])
  })
})

describe('unwrapRemote', () => {
  it('returns the success value and throws the reported failure', async () => {
    await expect(unwrapRemote(Promise.resolve({ ok: true as const, value: 7 }))).resolves.toBe(7)
    await expect(unwrapRemote(Promise.resolve({
      ok: false as const,
      error: { code: 'internal', message: 'stale revision', details: {} },
    }))).rejects.toMatchObject({ message: 'stale revision', code: 'internal' })
  })
})

describe('ui-browser node half', () => {
  it('registers the Browser Profile settings namespace when settings is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply: nodeApply })
    await fiber.await()
    const ns = settingsNamespace(BROWSER_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual(DEFAULT_BROWSER_SETTINGS)
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })
})
