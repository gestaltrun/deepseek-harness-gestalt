import { describe, expect, it, vi } from 'vitest'

import { removeFixtureRoot } from './verify-dependency-policy.ts'

describe('dependency policy fixture cleanup', () => {
  it('uses bounded recursive retries for transient Windows removal failures', () => {
    const remove = vi.fn()

    removeFixtureRoot('owned-fixture', remove)

    expect(remove).toHaveBeenCalledWith('owned-fixture', {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  })

  it('does not swallow a final cleanup failure', () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EPERM' })
    const remove = vi.fn(() => {
      throw failure
    })

    expect(() => {
      removeFixtureRoot('owned-fixture', remove)
    }).toThrow(failure)
  })
})
