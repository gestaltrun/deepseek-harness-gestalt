import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertCleanCommittedHead,
  copyModelConfiguration,
  parseBootGraph,
  verifyServedRevision,
} from './web-acceptance.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'web-acceptance-spec-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('parseBootGraph', () => {
  it('reads the Server-injected module graph', () => {
    expect(parseBootGraph('<script>globalThis["__DSH_BOOT__"] = {"rev":"x","entries":[{"id":"sidebar","url":"/sidebar.js"}]}</script>'))
      .toEqual({ entries: [{ id: 'sidebar', url: '/sidebar.js' }] })
  })

  it('rejects a missing or malformed graph', () => {
    expect(() => parseBootGraph('<main></main>')).toThrow('omitted window.__DSH_BOOT__')
    expect(() => parseBootGraph('<script>globalThis["__DSH_BOOT__"] = {"entries":42}</script>'))
      .toThrow('invalid schema')
  })
})

describe('verifyServedRevision', () => {
  it('fetches the served Sidebar bundle and checks its embedded revision', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        '<script>globalThis["__DSH_BOOT__"] = {"entries":[{"id":"@deepseek-ai/dsh-client-ui-sidebar","url":"/sidebar.js"}]}</script>',
      ))
      .mockResolvedValueOnce(new Response('footer revision abc1234'))

    await expect(verifyServedRevision('http://127.0.0.1:3000', 'abc1234')).resolves.toBeUndefined()
    expect(fetchSpy.mock.calls[1]?.[0]).toEqual(new URL('http://127.0.0.1:3000/sidebar.js'))
  })

  it('rejects a served bundle from another revision', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        '<script>globalThis["__DSH_BOOT__"] = {"entries":[{"id":"@deepseek-ai/dsh-client-ui-sidebar","url":"/sidebar.js"}]}</script>',
      ))
      .mockResolvedValueOnce(new Response('footer revision old0000'))

    await expect(verifyServedRevision('http://127.0.0.1:3000', 'abc1234'))
      .rejects.toThrow('does not contain revision abc1234')
  })
})

describe('copyModelConfiguration', () => {
  it('copies only the approved regular files with owner-only permissions', () => {
    const source = join(directory, 'source')
    const target = join(directory, 'target')
    mkdirSync(source)
    mkdirSync(target)
    writeFileSync(join(source, 'settings.yaml'), 'settings')
    writeFileSync(join(source, '.credentials.yaml'), 'credentials')
    writeFileSync(join(source, '.env'), 'must-not-copy')
    mkdirSync(join(source, 'sessions'))

    expect(copyModelConfiguration(source, target)).toEqual(['settings.yaml', '.credentials.yaml'])
    expect(readFileSync(join(target, 'settings.yaml'), 'utf8')).toBe('settings')
    expect(readFileSync(join(target, '.credentials.yaml'), 'utf8')).toBe('credentials')
    expect(() => readFileSync(join(target, '.env'))).toThrow()
    if (process.platform !== 'win32') {
      expect(lstatSync(join(target, 'settings.yaml')).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects symlinked configuration', () => {
    const source = join(directory, 'source')
    const target = join(directory, 'target')
    mkdirSync(source)
    mkdirSync(target)
    writeFileSync(join(directory, 'settings'), 'settings')
    symlinkSync(join(directory, 'settings'), join(source, 'settings.yaml'))
    expect(() => copyModelConfiguration(source, target)).toThrow('refuses non-regular model configuration')
  })
})

describe('assertCleanCommittedHead', () => {
  it('returns HEAD for a clean repository and rejects untracked state', () => {
    execFileSync('git', ['init'], { cwd: directory })
    execFileSync('git', ['config', 'user.email', 'acceptance@example.test'], { cwd: directory })
    execFileSync('git', ['config', 'user.name', 'Acceptance Test'], { cwd: directory })
    writeFileSync(join(directory, 'tracked'), 'one')
    execFileSync('git', ['add', 'tracked'], { cwd: directory })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: directory })

    expect(assertCleanCommittedHead(directory)).toMatch(/^[0-9a-f]{40}$/u)
    writeFileSync(join(directory, 'untracked'), 'two')
    expect(() => assertCleanCommittedHead(directory)).toThrow('clean committed worktree')
  })
})
