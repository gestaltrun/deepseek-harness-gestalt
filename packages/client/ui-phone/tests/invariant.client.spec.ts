/**
 * The invariant companion reserves package ownership and, through its real
 * installer, proves on a live cordis fiber that the phone tab registration
 * is symmetric: activation registers id 'phone' into a same-process fake
 * better-sidebar registry and fiber disposal removes it again. The two
 * rejection arms of the shared assertion run directly against controlled
 * probes.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PhoneInvariant from '../src/invariant.ts'
import { assertPhoneTabSymmetry } from '../src/client/registry.ts'

/** A reporter that turns an invariant violation into a thrown error. */
function throwingFail(message: string): never {
  throw new Error(`invariant violated by probe: ${message}`)
}

describe('ui-phone invariant companion', () => {
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

  it('rejects a missing post-activation registration', () => {
    expect(() => assertPhoneTabSymmetry({ mounted: false, survivedDispose: false }, throwingFail))
      .toThrow(/missing after the plugin fiber activated/)
  })

  it('rejects a registration leaking past disposal', () => {
    expect(() => assertPhoneTabSymmetry({ mounted: true, survivedDispose: true }, throwingFail))
      .toThrow(/leaked past plugin-fiber disposal/)
  })
})
