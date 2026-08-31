/** A non-Error resolver failure still becomes an actionable unavailable Service. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/resolve-binary.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/resolve-binary.ts')>()
  return {
    ...actual,
    resolveMobilecliExecutable: (): never => {
      const failure: unknown = 'resolver exploded'
      throw failure
    },
  }
})

import PhoneDevices, { PhoneDevicesError } from '../src/index.ts'

describe('phone runtime binary resolution boundary', () => {
  it('normalizes a non-Error resolver failure into PHONE_UNRESOLVED', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(PhoneDevices, {})
    await fiber.await()
    const failure: unknown = await ctx.phoneDevices.listDevices().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PhoneDevicesError)
    if (!(failure instanceof PhoneDevicesError)) throw new Error('expected a PhoneDevicesError')
    expect(failure.code).toBe('PHONE_UNRESOLVED')
    expect(failure.message).toBe('resolver exploded')
    await fiber.dispose()
  })
})
