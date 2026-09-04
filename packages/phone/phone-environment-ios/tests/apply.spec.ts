import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IosEnvironmentProvider, PhoneIosState } from '@deepseek-ai/dsh-phone-environment'
import { apply, inject, name, IosEnvironmentManager } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
})

describe('iOS environment plugin lifecycle', () => {
  it('tears down the manager before removing its HMR contribution', async () => {
    const context = new Context()
    contexts.push(context)
    const events: string[] = []
    let state: PhoneIosState = { kind: 'unsupported', reason: 'fixture before registration' }
    const registerIosEnvironment = (provider: IosEnvironmentProvider): (() => void) => {
      events.push('register')
      state = provider.snapshot()
      return () => { events.push('unregister'); state = { kind: 'deferred' } }
    }
    context.provide('phoneEnvironment', {
      registerIosEnvironment,
      snapshot: () => ({ platforms: { ios: state } }),
    } as never)
    vi.spyOn(IosEnvironmentManager.prototype, 'deactivate').mockImplementation(async () => {
      events.push('deactivate')
    })

    const fiber = context.plugin({ name, inject, apply })
    await fiber.await()
    expect(state.kind).not.toBe('deferred')
    await fiber.dispose()
    expect(state).toEqual({ kind: 'deferred' })
    expect(events).toEqual(['register', 'deactivate', 'unregister'])
  })
})
