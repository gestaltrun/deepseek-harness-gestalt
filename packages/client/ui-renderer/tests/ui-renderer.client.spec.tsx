// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { TestSessions, TestWorkspaces } from '@deepseek-ai/dsh-client-test-runtime'
import type { Stabilizer } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-renderer'
import * as UiRenderer from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'renderer.explicit-session': { kind: 'single'; scope: 'session'; owner: object }
  }
}

const mounted: (() => void)[] = []

afterEach(() => {
  act(() => { for (const unmount of mounted.splice(0)) unmount() })
  vi.restoreAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

const stabilize: Stabilizer = async (fn) => { await act(async () => { await fn() }) }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('sessions', new TestSessions(stabilize, ctx))
  ctx.provide('workspaces', new TestWorkspaces(stabilize))
  const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
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

  it('returns an unmount disposer', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount() })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
  })

  it('mounts a declared slot against an explicit Session without changing current selection', async () => {
    const { ctx, slots } = await bench()
    slots.register({
      name: 'root',
      children: { 'renderer.explicit-session': { kind: 'single', scope: 'session' } },
    }, (_props: PropsRenderSlots<'renderer.explicit-session'>) => null)
    slots.register(
      { name: 'renderer.explicit-session' },
      (props: { sessionId: string }) => <b>{props.sessionId}</b>,
    )
    const sessions = ctx.get('sessions') as TestSessions
    await sessions.add({ id: 'main' })
    await sessions.add({ id: 'side-thread' }, { current: false })
    const el = container()
    act(() => {
      mounted.push(ctx.get('uiRenderer')!.mountSession(el, 'renderer.explicit-session', 'side-thread'))
    })
    expect(el.textContent).toBe('side-thread')
    expect(sessions.list.getSnapshot().current).toBe('main')
  })

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench()
    await stabilize(() => fiber.dispose())
    expect(ctx.get('uiRenderer')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
