import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import StaticSubagentRoutePreauthorization from '../src/index.ts'

describe('static subagent route preauthorization', () => {
  it('validates, sorts, deduplicates, and returns detached frozen snapshots', async () => {
    const ctx = new Context()
    const source = [
      { provider: 'zeta', model: 'two' },
      { provider: 'alpha', model: 'one' },
      { provider: 'alpha', model: 'one' },
    ]
    await ctx.plugin(StaticSubagentRoutePreauthorization, { allowedModels: source })
    source[0]!.model = 'changed'

    const first = ctx.subagentRoutePreauthorization.snapshot()
    const second = ctx.subagentRoutePreauthorization.snapshot()
    expect(first).toEqual([
      { provider: 'alpha', model: 'one' },
      { provider: 'zeta', model: 'two' },
    ])
    expect(first).not.toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(() => { (first as Array<unknown>).push({}) }).toThrow()
    expect(second).toEqual(first)
  })

  it('rejects empty provider or model ids in direct plugin construction', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(StaticSubagentRoutePreauthorization, {
      allowedModels: [{ provider: '', model: 'm' }],
    })).rejects.toThrow()
    await expect(ctx.plugin(StaticSubagentRoutePreauthorization, {
      allowedModels: [{ provider: 'p', model: '' }],
    })).rejects.toThrow()
  })

  it('removes the service on disposal and allows a replacement Provider', async () => {
    const ctx = new Context()
    const first = ctx.plugin(StaticSubagentRoutePreauthorization, {
      allowedModels: [{ provider: 'alpha', model: 'one' }],
    })
    await first
    expect(ctx.subagentRoutePreauthorization.snapshot()).toEqual([{ provider: 'alpha', model: 'one' }])
    await first.dispose()
    expect(ctx.get('subagentRoutePreauthorization')).toBeUndefined()

    await ctx.plugin(StaticSubagentRoutePreauthorization, {
      allowedModels: [{ provider: 'beta', model: 'two' }],
    })
    expect(ctx.subagentRoutePreauthorization.snapshot()).toEqual([{ provider: 'beta', model: 'two' }])
  })
})
