import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import type { Context } from '../src/context-types.ts'

describe('sidechat route lifecycle', () => {
  it('preserves the canonical composer queue posture', async () => {
    const followup = vi.fn()
    const steer = vi.fn()
    const agent = {
      followup,
      steer,
      session: {
        events: [{
          type: 'user/message',
          data: { content: [{ type: 'text', text: 'Side conversation boundary' }] },
        }],
      },
    } as unknown as Agent
    const ctx = {
      get: (name: string) => name === 'agents' ? { get: () => agent } : undefined,
    } as unknown as Context

    const sidechat = buildSidechatApi(ctx)
    await sidechat.routes['sidechat.prompt']({ childId: 'child', text: 'redirect', mode: 'steer' })

    expect(steer).toHaveBeenCalledOnce()
    expect(followup).not.toHaveBeenCalled()
    await sidechat.dispose()
  })

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
    const prompting = sidechat.routes['sidechat.prompt']({ childId: 'child', text: 'hello', mode: 'queue' })
    await vi.waitFor(() => { expect(resume).toHaveBeenCalledOnce() })

    const teardown = sidechat.dispose()
    await expect(sidechat.routes['sidechat.cancel']({ childId: 'child' }))
      .rejects.toThrow('side chat is stopping')

    completeResume?.({ agent, dispose: disposeHandle })
    await prompting
    await teardown

    expect(inject).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
    expect(disposeHandle).toHaveBeenCalledOnce()
  })
})
