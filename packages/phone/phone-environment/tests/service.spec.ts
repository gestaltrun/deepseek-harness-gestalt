import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneEnvironment from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('PhoneEnvironment', () => {
  it('updates the durable enable gate without remounting the Service', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(PhoneEnvironment).await()
    const service = context.get('phoneEnvironment')
    if (service === undefined) throw new Error('phoneEnvironment did not activate')
    const seen = vi.fn()
    const unsubscribe = service.onChanged(seen)
    service.setEnabled(true)
    service.setEnabled(true)
    expect(service.snapshot().enabled).toBe(true)
    expect(service.snapshot().revision).toBe(1)
    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
    service.setEnabled(false)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('removes subscribers when its owning fiber disposes', async () => {
    const context = new Context()
    contexts.push(context)
    const fiber = context.plugin(PhoneEnvironment)
    await fiber.await()
    const service = context.phoneEnvironment
    const listener = vi.fn()
    service.onChanged(listener)
    await fiber.dispose()
    service.setEnabled(true)
    expect(listener).not.toHaveBeenCalled()
  })
})
