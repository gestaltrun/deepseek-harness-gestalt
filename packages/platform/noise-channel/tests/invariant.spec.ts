import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import * as companion from '../src/invariant.ts'

describe('Snow channel invariant companion', () => {
  it('registers package ownership with its boundary-checked installer', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_name: string, install: InvariantInstaller) => {
      const fail: InvariantFailure = (message) => { throw new Error(message) }
      void install({} as Context, fail)
      return dispose
    })
    const registered = await companion.apply({ invariants: { register } } as never)
    expect(companion.name).toBe('noise-channel-invariant')
    expect(companion.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-noise-channel', expect.any(Function))
    registered()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
