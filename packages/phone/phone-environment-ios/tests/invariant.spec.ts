import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/invariant.ts'

describe('iOS environment invariant', () => {
  it.each([
    ['deferred', 1],
    ['unsupported', 0],
  ] as const)('reports a %s platform contribution', async (kind, failures) => {
    const context = new Context()
    let install: ((ctx: Context, fail: (message: string) => void) => void) | undefined
    context.provide('phoneEnvironment', {
      snapshot: () => ({ platforms: { ios: kind === 'deferred'
        ? { kind: 'deferred' }
        : { kind: 'unsupported', reason: 'fixture' } } }),
    } as never)
    context.provide('invariants', {
      register: (_packageName: string, value: typeof install) => { install = value; return () => {} },
    } as never)
    await apply(context)
    const fail = vi.fn()
    install?.(context, fail)
    expect(fail).toHaveBeenCalledTimes(failures)
    await context.fiber.dispose()
  })
})
