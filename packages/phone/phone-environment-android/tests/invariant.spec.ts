import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AndroidEnvironmentInvariant from '../src/invariant.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

async function mount(kind: 'deferred' | 'checking'): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  context.provide('phoneEnvironment', {
    snapshot: () => ({ platforms: { android: { kind } } }),
  } as never)
  await context.plugin(InvariantRegistry).await()
  return context
}

describe('Android environment invariant companion', () => {
  it('accepts a Provider-owned Android state', async () => {
    const context = await mount('checking')
    await context.plugin(AndroidEnvironmentInvariant).await()
  })

  it('rejects a deferred Android state after Provider registration', async () => {
    const context = await mount('deferred')
    await expect(context.plugin(AndroidEnvironmentInvariant).await())
      .rejects.toThrow(/did not replace the deferred platform state/)
  })
})
