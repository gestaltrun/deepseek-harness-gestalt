import { describe, expect, it, vi } from 'vitest'

import {
  finishFixture,
  fixtureScripts,
  fixtureWorkspaceSettings,
  removeFixtureRoot,
} from './verify-dependency-policy.ts'

describe('dependency policy fixture commands', () => {
  it('uses PATH-resolved Node with script files instead of shell-quoting an absolute executable', () => {
    expect(fixtureScripts()).toEqual({ check: 'node check.cjs', postinstall: 'node postinstall.cjs' })
  })

  it('copies package files while retaining pnpm default linker behavior', () => {
    expect(fixtureWorkspaceSettings).toBe('packages: []\npackageImportMethod: copy\n')
  })
})

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

  it('reports both a primary fixture failure and a cleanup failure', () => {
    const primary = new Error('prepare failed')
    const cleanup = Object.assign(new Error('cleanup failed'), { code: 'EPERM' })

    expect(() => {
      finishFixture(primary, () => {
        throw cleanup
      })
    }).toThrow(expect.objectContaining({ errors: [primary, cleanup] }))
  })
})
