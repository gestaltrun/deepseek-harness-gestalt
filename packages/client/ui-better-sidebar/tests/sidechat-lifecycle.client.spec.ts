import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import type { Context } from '../src/context-types.ts'

describe('sidechat route lifecycle', () => {
  it('creates the requested child only when the first prompt reaches the route', async () => {
    const inject = vi.fn()
    const followup = vi.fn()
    const child = {
      id: 'draft-child',
      ctx: { effect: vi.fn() },
      inject,
      followup,
      options: { provider: 'deepseek', model: 'chat' },
      session: { events: [], header: {} },
    } as unknown as Agent
    const parent = {
      id: 'parent',
      options: { provider: 'deepseek', model: 'chat' },
      session: { id: 'parent', events: [], header: {} },
    } as unknown as Agent
    const create = vi.fn(() => Promise.resolve({ agent: child, dispose: () => Promise.resolve() }))
    const ctx = {
      get: (name: string) => name === 'agents'
        ? { get: (id: string) => id === 'parent' ? parent : undefined, create }
        : undefined,
    } as unknown as Context

    const sidechat = buildSidechatApi(ctx)
    expect(create).not.toHaveBeenCalled()
    await expect(sidechat.routes['sidechat.start']({
      sessionId: 'parent',
      childId: 'draft-child',
      text: 'first question',
    })).resolves.toEqual({ childId: 'draft-child', accepted: true })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'draft-child',
      agentOptions: expect.objectContaining({ provider: 'deepseek', model: 'chat' }),
    }))
    expect(inject).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
    await sidechat.dispose()
  })

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

  it('mutates queued Side Chat messages through the owning live Agent', async () => {
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    const remove = vi.fn()
    const steer = vi.fn()
    const agent = {
      status: 'running',
      steer,
      inbox: { nextTurn: [queued], nextStep: [], remove, replace: vi.fn() },
    } as unknown as Agent
    const ctx = {
      get: (name: string) => name === 'agents' ? { get: () => agent } : undefined,
    } as unknown as Context

    const sidechat = buildSidechatApi(ctx)
    await expect(sidechat.routes['sidechat.updateQueue']({
      childId: 'child', itemId: queued.id, action: { kind: 'steer' },
    })).resolves.toEqual({ accepted: true })

    expect(remove).toHaveBeenCalledWith(queued.id)
    expect(steer).toHaveBeenCalledWith(queued)
    await sidechat.dispose()
  })

  it('synchronizes a Side Chat permission selection with its direct parent', async () => {
    const setAgent = vi.fn()
    const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
    const child = {
      id: 'child',
      session: { header: { parentSession: 'parent' } },
    } as unknown as Agent
    const ctx = {
      get: (name: string) => {
        if (name === 'agents') return { get: (id: string) => id === 'parent' ? parent : id === 'child' ? child : undefined }
        if (name === 'permissionPresets') return { names: ['workspace-write'], setAgent }
        return undefined
      },
    } as unknown as Context

    const sidechat = buildSidechatApi(ctx)
    await expect(sidechat.routes['sidechat.permission']({
      childId: 'child', parentSessionId: 'parent', preset: 'workspace-write',
    })).resolves.toEqual({ selected: 'workspace-write' })

    expect(setAgent).toHaveBeenNthCalledWith(1, parent, 'workspace-write')
    expect(setAgent).toHaveBeenNthCalledWith(2, child, 'workspace-write')
    await sidechat.dispose()
  })

  it('rejects a provisional permission request without an owned live child', async () => {
    const setAgent = vi.fn()
    const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
    const ctx = {
      get: (name: string) => {
        if (name === 'agents') return { get: (id: string) => id === 'parent' ? parent : undefined }
        if (name === 'permissionPresets') return { names: ['workspace-write'], setAgent }
        return undefined
      },
    } as unknown as Context

    const sidechat = buildSidechatApi(ctx)
    await expect(sidechat.routes['sidechat.permission']({
      childId: 'draft-child',
      parentSessionId: 'parent',
      preset: 'workspace-write',
      provisional: true,
    })).rejects.toThrow('Side Chat session "draft-child" is not running')

    expect(setAgent).not.toHaveBeenCalled()
    await sidechat.dispose()
  })

  it('retains a validated model choice until a cold child resumes', async () => {
    const llm = {
      resolveCallConfig: vi.fn(() => Promise.resolve({
        provider: 'deepseek',
        model: 'pro',
        reasoningEffort: 'high',
      })),
      listProviders: () => [{ id: 'deepseek' }],
    }
    const ctx = {
      get: (name: string) => {
        if (name === 'llm') return llm
        if (name === 'sessionPersistence') {
          return { inspect: vi.fn(() => Promise.resolve({ meta: {}, events: [] })) }
        }
        return undefined
      },
    } as unknown as Context

    const sidechat = buildSidechatApi(ctx)
    await expect(sidechat.routes['sidechat.selectModel']({
      childId: 'cold-child',
      selection: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
    })).resolves.toEqual({
      selected: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
    })
    await expect(sidechat.routes['sidechat.model']({ childId: 'cold-child' })).resolves.toEqual({
      current: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
      routable: true,
    })
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
