import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PhoneStreamInvariant from '../src/invariant.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('phone stream invariant companion', () => {
  it('registers an empty installer because Host WebServer owns route disposal', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(InvariantRegistry).await()
    await context.plugin(PhoneStreamInvariant).await()
    expect(PhoneStreamInvariant.name).toBe('phone-stream-invariant')
    expect(PhoneStreamInvariant.inject).toEqual(['invariants'])
  })
})
