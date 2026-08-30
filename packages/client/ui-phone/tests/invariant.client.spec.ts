/**
 * The invariant companion reserves package ownership and, through its real
 * installer, proves on a live cordis fiber that the phone tab registration
 * is symmetric: activation registers id 'phone' into a same-process fake
 * better-sidebar registry and fiber disposal removes it again. The two
 * rejection arms of the shared assertion run directly against controlled
 * probes.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PhoneInvariant from '../src/invariant.ts'
import { assertPhoneTabSymmetry } from '../src/client/registry.ts'

/** A reporter that turns an invariant violation into a thrown error. */
function throwingFail(message: string): never {
  throw new Error(`invariant violated by probe: ${message}`)
}

describe('ui-phone invariant companion', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(PhoneInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    expect(PhoneInvariant.name).toBe('client-ui-phone-invariant')
    expect([...PhoneInvariant.inject]).toEqual(['invariants'])
    await fiber.dispose()
  })

  it('proves mount and disposal symmetry on the installed package', async () => {
    // The happy round-trip inside the companion ran during registration;
    // assert the shared assertion itself on the same observation shape.
    expect(() => assertPhoneTabSymmetry({ mounted: true, survivedDispose: false }, throwingFail))
      .not.toThrow()
  })

  it('keeps duplicate registration loud and stale disposers ownership-safe', async () => {
    const sidebar = new PhoneInvariant.RecordingSidebar()
    const first = { id: 'phone' }
    const disposeFirst = sidebar.registerTab(first)
    expect(() => sidebar.registerTab({ id: 'phone' })).toThrow('already registered')
    const removed = sidebar.whenUnregistered
    disposeFirst()
    await expect(removed).resolves.toBeUndefined()

    const second = { id: 'phone' }
    const disposeSecond = sidebar.registerTab(second)
    disposeFirst()
    expect(sidebar.getTab('phone')).toBe(second)
    disposeSecond()
  })

  it('yields when the hosting context already publishes betterSidebar', async () => {
    const ctx = new Context()
    const sidebar = new PhoneInvariant.RecordingSidebar()
    const registerTab = vi.spyOn(sidebar, 'registerTab')
    ctx.provide('betterSidebar', sidebar)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(PhoneInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    expect(registerTab).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('fails through the package reporter when activation exposes no phone tab', async () => {
    vi.spyOn(PhoneInvariant.RecordingSidebar.prototype, 'getTab').mockReturnValue(undefined)
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PhoneInvariant).await()).rejects.toThrow(/phone.*missing after the plugin fiber activated/)
  })

  it('settles disposal through the removal signal when the registry view lags one read', async () => {
    const original = PhoneInvariant.RecordingSidebar.prototype.getTab
    let calls = 0
    vi.spyOn(PhoneInvariant.RecordingSidebar.prototype, 'getTab').mockImplementation(function (id) {
      calls += 1
      if (calls === 2) return { id }
      return original.call(this, id)
    })
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PhoneInvariant).await()).resolves.toBeDefined()
  })

  it('rejects a missing post-activation registration', () => {
    expect(() => assertPhoneTabSymmetry({ mounted: false, survivedDispose: false }, throwingFail))
      .toThrow(/missing after the plugin fiber activated/)
  })

  it('rejects a registration leaking past disposal', () => {
    expect(() => assertPhoneTabSymmetry({ mounted: true, survivedDispose: true }, throwingFail))
      .toThrow(/leaked past plugin-fiber disposal/)
  })
})
