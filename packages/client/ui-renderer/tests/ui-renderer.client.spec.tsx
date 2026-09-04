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
  const selectedBinding = binding('selected-session')
  const explicitBinding = binding('explicit-session')
  const current = {
    getSnapshot: () => selectedBinding,
    subscribe: () => () => {},
  }
  const adapter: SlotScopeAdapter = {
    current,
    resolve: key => key === explicitBinding.key ? explicitBinding : undefined,
  }
  slots.installScope('session', adapter)
  return { ctx, slots, fiber }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.session': { kind: 'single'; scope: 'session'; owner: { label: string } }
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

  it('mounts an explicit Session independently from the selected Session', async () => {
    const { ctx, slots } = await bench()
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
  })

  it('fails loud for invalid explicit Session mounts', async () => {
    const { ctx, slots } = await bench()
    slots.register({
      name: 'root',
      children: {
        'test.session': { kind: 'single', scope: 'session' },
        'test.root': { kind: 'single', scope: 'root' },
      },
    }, () => null)
    const renderer = ctx.get('uiRenderer')!
    expect(() => renderer.mountSession(container(), 'root', 'explicit-session' as never, {})).toThrow("cannot target 'root'")
    expect(() => renderer.mountSession(container(), 'unknown', 'explicit-session' as never, {})).toThrow('is not declared')
    expect(() => renderer.mountSession(container(), 'test.root', 'explicit-session' as never, {})).toThrow('has root scope')
    expect(() => renderer.mountSession(container(), 'test.session', 'missing' as never, { label: 'owner' })).toThrow('could not resolve')
  })

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench()
    await stabilize(() => fiber.dispose())
    expect(ctx.get('uiRenderer')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
