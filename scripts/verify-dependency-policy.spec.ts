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
    const cleanup = Object.assign(new Error('permission denied'), { code: 'EPERM' })
    const remove = vi.fn(() => {
      throw cleanup
    })

    expect(() => {
      removeFixtureRoot('owned-fixture', remove)
    }).toThrow(cleanup)
    expect(() => {
      finishFixture(undefined, () => {
        throw cleanup
      })
    }).toThrow(cleanup)
  })

  it('preserves the primary failure when cleanup succeeds', () => {
    const primary = new Error('prepare failed')

    expect(() => {
      finishFixture(primary, () => {})
    }).toThrow(primary)
  })

  it('reports both original errors when the fixture and cleanup fail', () => {
    const primary = new Error('prepare failed')
    const cleanup = Object.assign(new Error('cleanup failed'), { code: 'EPERM' })

    try {
      finishFixture(primary, () => {
        throw cleanup
      })
      expect.unreachable('finishFixture must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([primary, cleanup])
      expect((error as AggregateError).errors[0]).toBe(primary)
      expect((error as AggregateError).errors[1]).toBe(cleanup)
    }
  })
})
