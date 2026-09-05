// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../src/client/registry.ts'
import type { ScopedStandardSourceBinding, SlotScopeAdapter } from '../src/client/index.ts'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-renderer'
import * as UiRenderer from '../src/client/index.ts'

const mounted: (() => void)[] = []

afterEach(() => {
  act(() => { for (const unmount of mounted.splice(0)) unmount() })
  vi.restoreAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

const stabilize = async (fn: () => void | Promise<void>): Promise<void> => {
  await act(async () => { await fn() })
}

async function bench() {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply })
  await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  const binding = (key: string): ScopedStandardSourceBinding => ({
    key,
    ctx,
    hooks: {},
    keyedHooks: {},
    props: { sessionId: key },
  })
  let selectedBinding: ScopedStandardSourceBinding | undefined = binding('selected-session')
  const explicitBinding = binding('explicit-session')
  const currentListeners = new Set<() => void>()
  const current = {
    getSnapshot: () => selectedBinding ?? {
      key: undefined,
      hooks: {},
      keyedHooks: {},
      props: { sessionId: undefined },
    },
    subscribe: (listener: () => void) => {
      currentListeners.add(listener)
      return () => { currentListeners.delete(listener) }
    },
  }
  const releaseRender = vi.fn()
  const acquireForRender = vi.fn((key: string) =>
    key === explicitBinding.key ? releaseRender : undefined)
  const adapter: SlotScopeAdapter = {
    current,
    resolve: key => key === explicitBinding.key ? explicitBinding : undefined,
    acquireForRender,
    renderArea: (value, props) => value.key === undefined ? props.empty?.() : props.children,
  }
  slots.installScope('session', adapter)
  return {
    ctx,
    slots,
    fiber,
    currentListeners,
    acquireForRender,
    releaseRender,
    select: (key: string | undefined) => {
      selectedBinding = key === undefined ? undefined : binding(key)
      for (const listener of currentListeners) listener()
    },
  }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.session': { kind: 'single'; scope: 'session'; owner: { label: string } }
    'test.maybe': { kind: 'single'; scope: 'session-maybe'; owner: { label: string } }
    'test.root': { kind: 'single'; scope: 'root' }
  }
}

describe('UI renderer plugin', () => {
  it('provides no host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('installs the renderer and mounts the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const renderer = ctx.get('uiRenderer')
    expect(renderer).toBeDefined()
    const el = container()
    act(() => { mounted.push(renderer!.mount(el)) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
  })

  it('hydrates the boot page before switching to the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    el.innerHTML = '<div class="boot" data-dsh-boot=""><div><div class="spinner" data-dsh-boot-spinner="" style="--dsh-boot-arc: 180deg"></div><div>Loading plugins…</div></div></div>'
    const boot = el.firstElementChild
    const observer = new MutationObserver(() => {})
    observer.observe(el, { childList: true, subtree: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    const records = observer.takeRecords()
    observer.disconnect()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
    expect(records.some(record => record.target === boot)).toBe(false)
  })

  it('returns an idempotent unmount disposer', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount(); unmount() })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
  })

  it('mounts an explicit Session independently from selected Session changes and removal', async () => {
    const { ctx, slots, currentListeners, acquireForRender, releaseRender, select } = await bench()
    slots.register({
      name: 'root',
      children: { 'test.session': { kind: 'single', scope: 'session' } },
    }, () => null)
    slots.register({ name: 'test.session' }, ({ sessionId, label }) => (
      <div data-testid="session-probe">{sessionId}:{label}</div>
    ))
    const el = container()

    act(() => {
      mounted.push(ctx.get('uiRenderer')!.mountSession(
        el,
        'test.session',
        'explicit-session' as never,
        { label: 'owner' },
      ))
    })

    expect(el.querySelector('[data-testid="session-probe"]')?.textContent).toBe('explicit-session:owner')
    expect(acquireForRender).toHaveBeenCalledOnce()
    expect(acquireForRender).toHaveBeenCalledWith('explicit-session')
    expect(releaseRender).not.toHaveBeenCalled()
    expect(currentListeners).toHaveLength(0)
    act(() => { select('other-selected-session') })
    expect(el.querySelector('[data-testid="session-probe"]')?.textContent).toBe('explicit-session:owner')
    act(() => { select(undefined) })
    expect(el.querySelector('[data-testid="session-probe"]')?.textContent).toBe('explicit-session:owner')
  })

  it('fails loud before acquiring a React root and allows same-container retry', async () => {
    const { ctx, slots } = await bench()
    slots.register({
      name: 'root',
      children: {
        'test.session': { kind: 'single', scope: 'session' },
        'test.root': { kind: 'single', scope: 'root' },
      },
    }, () => null)
    slots.register({ name: 'test.session' }, ({ sessionId, label }) => (
      <div data-testid="session-probe">{sessionId}:{label}</div>
    ))
    const renderer = ctx.get('uiRenderer')!
    const el = container()
    expect(() => renderer.mountSession(el, 'root', 'explicit-session' as never, {})).toThrow("cannot target 'root'")
    expect(() => renderer.mountSession(el, 'unknown', 'explicit-session' as never, {})).toThrow('is not declared')
    expect(() => renderer.mountSession(el, 'test.root', 'explicit-session' as never, {})).toThrow("non-Session scope 'root'")
    const core = (slots as unknown as {
      _core: { specDynamic: (key: string) => unknown }
    })._core
    const specDynamic = vi.spyOn(core, 'specDynamic').mockReturnValue({ kind: 'single', scope: 'workspace' })
    expect(() => renderer.mountSession(el, 'test.foreign', 'explicit-session' as never, {})).toThrow("non-Session scope 'workspace'")
    specDynamic.mockRestore()
    expect(() => renderer.mountSession(el, 'test.session', 'missing' as never, { label: 'owner' })).toThrow('could not resolve')
    act(() => {
      mounted.push(renderer.mountSession(el, 'test.session', 'explicit-session' as never, { label: 'retry' }))
    })
    expect(el.querySelector('[data-testid="session-probe"]')?.textContent).toBe('explicit-session:retry')
  })

  it('fiber disposal unmounts live roots and releases subscriptions without caller disposers', async () => {
    const { ctx, slots, fiber, releaseRender } = await bench()
    slots.register({
      name: 'root',
      children: { 'test.session': { kind: 'single', scope: 'session' } },
    }, () => <div data-testid="root-probe" />)
    slots.register({ name: 'test.session' }, ({ sessionId }) => (
      <div data-testid="session-probe">{sessionId}</div>
    ))
    const rootEl = container()
    const sessionEl = container()
    act(() => {
      ctx.get('uiRenderer')!.mount(rootEl)
      ctx.get('uiRenderer')!.mountSession(sessionEl, 'test.session', 'explicit-session' as never, { label: 'owner' })
    })
    const core = (slots as unknown as {
      _core: { records: Map<string, { listeners: Set<() => void> }> }
    })._core
    expect(core.records.get('root')?.listeners.size).toBeGreaterThan(0)
    expect(core.records.get('test.session')?.listeners.size).toBeGreaterThan(0)

    await stabilize(() => fiber.dispose())

    expect(rootEl.childElementCount).toBe(0)
    expect(sessionEl.childElementCount).toBe(0)
    expect(core.records.get('root')?.listeners.size).toBe(0)
    expect(core.records.get('test.session')?.listeners.size).toBe(0)
    expect(releaseRender).toHaveBeenCalledOnce()
    expect(ctx.get('uiRenderer')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
