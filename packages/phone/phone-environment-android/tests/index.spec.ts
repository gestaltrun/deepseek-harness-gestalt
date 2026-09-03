import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const managerState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: { phoneRoot: string; reportError(error: unknown): void }
    deactivate: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('../src/environment.ts', () => ({
  AndroidEnvironmentError: class AndroidEnvironmentError extends Error {},
  AndroidEnvironmentManager: class AndroidEnvironmentManager {
    readonly deactivate = vi.fn(async () => {})
    constructor(readonly options: { phoneRoot: string; reportError(error: unknown): void }) {
      managerState.instances.push(this)
    }
  },
}))

import * as AndroidEnvironmentPlugin from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  managerState.instances.splice(0)
  vi.restoreAllMocks()
})

describe('Android environment Provider plugin', () => {
  it.each([
    [{ root: '/private/phone' }, '/private/phone'],
    [{}, 'phone'],
  ] as const)('registers and tears down the manager for config %#', async (config, expectedRoot) => {
    const context = new Context()
    contexts.push(context)
    const registered: unknown[] = []
    const disposeRegistration = vi.fn()
    context.provide('phoneEnvironment', {
      snapshot: () => ({ platforms: { android: { kind: 'checking' } } }),
      registerAndroidEnvironment: (provider: unknown) => {
        registered.push(provider)
        return disposeRegistration
      },
    } as never)
    const report = vi.spyOn(context.logger, 'error').mockImplementation(() => {})

    const fiber = context.plugin(AndroidEnvironmentPlugin, config)
    await fiber.await()
    const manager = managerState.instances[0]
    expect(manager).toBeDefined()
    expect(manager?.options.phoneRoot.replaceAll('\\', '/').endsWith(expectedRoot)).toBe(true)
    expect(registered).toEqual([manager])
    const failure = new Error('manager failed')
    manager?.options.reportError(failure)
    expect(report).toHaveBeenCalledWith(failure)

    await fiber.dispose()
    expect(disposeRegistration).toHaveBeenCalledOnce()
    expect(manager?.deactivate).toHaveBeenCalledOnce()
  })
})
