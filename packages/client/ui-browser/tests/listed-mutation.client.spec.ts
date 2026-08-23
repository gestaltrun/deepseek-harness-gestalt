import { describe, expect, it, vi } from 'vitest'
import type { BrowserTarget } from '@deepseek-ai/dsh-browser-workspace/client'
import { isBrowserRevisionConflict, recoverListedMutation } from '../src/client/listed-mutation.ts'

const TARGET: BrowserTarget = {
  profileId: 'profile-1' as BrowserTarget['profileId'],
  workspaceId: 'ws-1' as BrowserTarget['workspaceId'],
  browserId: 'br-1' as BrowserTarget['browserId'],
  tabId: 'tab-1' as BrowserTarget['tabId'],
}

function conflict(message = 'browser revision conflict: expected 2, current 4'): Error {
  return Object.assign(new Error(message), { code: 'BROWSER_REVISION_CONFLICT' })
}

describe('listed-tab mutation recovery', () => {
  it('recognizes a revision conflict from the stable code or the Gateway message', () => {
    expect(isBrowserRevisionConflict(conflict())).toBe(true)
    expect(isBrowserRevisionConflict(new Error('BROWSER_REVISION_CONFLICT'))).toBe(true)
    expect(isBrowserRevisionConflict(new Error('browser revision conflict: expected 1, current 2'))).toBe(true)
    expect(isBrowserRevisionConflict(new Error('tab closed'))).toBe(false)
    expect(isBrowserRevisionConflict('BROWSER_REVISION_CONFLICT')).toBe(false)
  })

  it('returns the first success without observing', async () => {
    const mutate = vi.fn().mockResolvedValue('ok')
    const observe = vi.fn()
    await expect(recoverListedMutation(mutate, observe, TARGET, 2)).resolves.toBe('ok')
    expect(mutate).toHaveBeenCalledWith(TARGET, 2)
    expect(observe).not.toHaveBeenCalled()
  })

  it('observes once and retries after a revision conflict', async () => {
    const mutate = vi.fn()
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce('healed')
    const observe = vi.fn().mockResolvedValue({
      status: 'open', target: TARGET, revision: 4,
    })
    await expect(recoverListedMutation(mutate, observe, TARGET, 2)).resolves.toBe('healed')
    expect(observe).toHaveBeenCalledWith(TARGET)
    expect(mutate).toHaveBeenNthCalledWith(1, TARGET, 2)
    expect(mutate).toHaveBeenNthCalledWith(2, TARGET, 4)
  })

  it('retries an unavailable observe with that revision', async () => {
    const mutate = vi.fn()
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce('retried')
    const observe = vi.fn().mockResolvedValue({
      status: 'unavailable',
      target: TARGET,
      revision: 5,
      reason: 'crashed',
      reconnecting: true,
    })
    await expect(recoverListedMutation(mutate, observe, TARGET, 2)).resolves.toBe('retried')
    expect(mutate).toHaveBeenLastCalledWith(TARGET, 5)
  })

  it('does not retry after observe reports closed', async () => {
    const mutate = vi.fn().mockRejectedValue(conflict())
    const observe = vi.fn().mockResolvedValue({
      status: 'closed', target: TARGET, revision: 3,
    })
    await expect(recoverListedMutation(mutate, observe, TARGET, 2)).resolves.toBeUndefined()
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('rethrows a non-conflict failure without observing', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('tab closed'))
    const observe = vi.fn()
    await expect(recoverListedMutation(mutate, observe, TARGET, 2)).rejects.toThrow('tab closed')
    expect(observe).not.toHaveBeenCalled()
  })

  it('rethrows observe and retry failures', async () => {
    const observeFails = vi.fn().mockRejectedValue(new Error('no session'))
    await expect(recoverListedMutation(
      vi.fn().mockRejectedValue(conflict()),
      observeFails,
      TARGET,
      2,
    )).rejects.toThrow('no session')

    const retryFails = vi.fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(new Error('still stale'))
    await expect(recoverListedMutation(
      retryFails,
      vi.fn().mockResolvedValue({ status: 'open', target: TARGET, revision: 4 }),
      TARGET,
      2,
    )).rejects.toThrow('still stale')
  })
})
