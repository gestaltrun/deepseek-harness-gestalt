import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  finishFixture,
  fixtureScripts,
  fixtureWorkspaceSettings,
  removeFixtureRoot,
  unlinkFixtureLinks,
} from './verify-dependency-policy.ts'

function withTemporaryDirectory(run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-policy-test-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function directoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

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
      maxRetries: 20,
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

  it('removes dangling directory links', () => {
    withTemporaryDirectory((root) => {
      const target = join(root, 'removed-target')
      const link = join(root, 'dangling-link')
      mkdirSync(target)
      directoryLink(target, link)
      rmSync(target, { recursive: true })

      unlinkFixtureLinks(link)

      expect(() => lstatSync(link)).toThrow()
    })
  })

  it('unlinks directory links without removing their external targets', () => {
    withTemporaryDirectory((root) => {
      const fixture = join(root, 'fixture')
      const external = join(root, 'external')
      const marker = join(external, 'marker')
      const link = join(fixture, 'external-link')
      mkdirSync(fixture)
      mkdirSync(external)
      writeFileSync(marker, 'preserved')
      directoryLink(external, link)

      unlinkFixtureLinks(fixture)

      expect(() => lstatSync(link)).toThrow()
      expect(lstatSync(marker).isFile()).toBe(true)
    })
  })
})
