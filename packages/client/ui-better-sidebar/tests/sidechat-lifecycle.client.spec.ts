import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import type { Context } from '../src/context-types.ts'

describe('sidechat route lifecycle', () => {
  it('waits for admitted resume work and disposes its handle before teardown completes', async () => {
    let completeResume: ((handle: { agent: Agent; dispose(): Promise<void> }) => void) | undefined
    const resumed = new Promise<{ agent: Agent; dispose(): Promise<void> }>((resolve) => {
      completeResume = resolve
    })
    const inject = vi.fn()
    const followup = vi.fn()
    const disposeHandle = vi.fn(() => Promise.resolve())
    const agent = {
      inject,
      followup,
      options: {},
      session: { events: [], header: {} },
    } as unknown as Agent
    const resume = vi.fn(() => resumed)
    const ctx = {
      get: (name: string) => name === 'agents'
        ? { get: () => undefined, resume }
        : undefined,
    } as unknown as Context

    const sidechat = buildSidechatApi(ctx)
    const prompting = sidechat.routes['sidechat.prompt']({ childId: 'child', text: 'hello' })
    await vi.waitFor(() => { expect(resume).toHaveBeenCalledOnce() })

    const teardown = sidechat.dispose()
    await expect(sidechat.routes['sidechat.info']({ childId: 'child' }))
      .rejects.toThrow('side chat is stopping')

    completeResume?.({ agent, dispose: disposeHandle })
    await prompting
    await teardown

    expect(inject).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
    expect(disposeHandle).toHaveBeenCalledOnce()
  })
})
