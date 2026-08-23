import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'
import { bindBrowserWorkspace, type BrowserWorkspaceRemoteFace } from '../src/client/remote-bind.ts'

const SESSION = 'session-1' as SessionId
const TARGET = {
  profileId: 'p',
  workspaceId: 'w',
  browserId: 'b',
  tabId: 't',
} as BrowserTarget

function ok<T>(value: T) {
  return Promise.resolve({ ok: true as const, value })
}

describe('bindBrowserWorkspace', () => {
  it('unwraps Session-bound Remote verbs', async () => {
    const remote: BrowserWorkspaceRemoteFace = {
      create: vi.fn().mockReturnValue(ok({ status: 'open', target: TARGET, title: 'A' })),
      close: vi.fn().mockReturnValue(ok({ status: 'closed' })),
      navigate: vi.fn().mockReturnValue(ok({ status: 'open' })),
      observe: vi.fn().mockReturnValue(ok({ status: 'open' })),
      screenshot: vi.fn().mockReturnValue(ok({ data: 'x' })),
    }
    const bound = bindBrowserWorkspace(remote, SESSION)
    await expect(bound.create({ profile: 'temporary' })).resolves.toMatchObject({ title: 'A' })
    await bound.close(TARGET, 1)
    await bound.refresh(TARGET, 1, 'https://a.test/')
    await bound.observe(TARGET)
    await bound.screenshot(TARGET)
    expect(remote.create).toHaveBeenCalledWith(SESSION, { profile: 'temporary' })
    expect(remote.navigate).toHaveBeenCalledWith(SESSION, TARGET, 1, 'https://a.test/')
  })

  it('rejects create when the Remote verb is not mounted', async () => {
    const remote: BrowserWorkspaceRemoteFace = {
      close: vi.fn(),
      navigate: vi.fn(),
      observe: vi.fn(),
      screenshot: vi.fn(),
    }
    const bound = bindBrowserWorkspace(remote, SESSION)
    await expect(bound.create({ profile: 'shared' })).rejects.toThrow(/create is not mounted/)
  })

  it('throws the Remote failure when a verb is not ok', async () => {
    const remote: BrowserWorkspaceRemoteFace = {
      close: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'internal', message: 'gone' },
      }),
      navigate: vi.fn(),
      observe: vi.fn(),
      screenshot: vi.fn(),
    }
    const bound = bindBrowserWorkspace(remote, SESSION)
    await expect(bound.close(TARGET, 1)).rejects.toMatchObject({ message: 'gone', code: 'internal' })
  })
})
