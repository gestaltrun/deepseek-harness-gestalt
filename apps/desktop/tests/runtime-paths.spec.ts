import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isElectronExecutable, resolveDesktopRuntime } from '../src/runtime-paths.ts'

describe('resolveDesktopRuntime', () => {
  it('points packaged runs at extraResources Node and dsh', () => {
    const paths = resolveDesktopRuntime({
      packaged: true,
      resourcesPath: '/App/Resources',
      moduleUrl: 'file:///unused/main.ts',
    })
    // Windows extraResources carry a bare node.exe; POSIX carries bin/node.
    const nodeExecutable = process.platform === 'win32'
      ? join('/App/Resources', 'node', 'node.exe')
      : join('/App/Resources', 'node', 'bin', 'node')
    expect(paths.node).toBe(nodeExecutable)
    expect(paths.args[0]).toBe(join('/App/Resources', 'dsh', 'lib', 'bin.js'))
    expect(paths.args).toContain('--host')
    expect(paths.args).toContain('127.0.0.1')
    expect(paths.args).toContain('--port')
    expect(paths.args).toContain('0')
    expect(paths.args).toContain('--no-open')
    expect(paths.args.indexOf('--patch')).toBeLessThan(paths.args.indexOf('--host'))
    expect(paths.args.indexOf('--patch')).toBeLessThan(paths.args.indexOf('--no-open'))
    expect(paths.args).not.toContain('--profile')
    expect(paths.args).not.toContain('gestalt')
  })

  it('keeps unpackaged source launch on the repo root and puts --patch before app flags', () => {
    const paths = resolveDesktopRuntime({
      packaged: false,
      resourcesPath: '/unused',
      moduleUrl: new URL('../src/main.ts', import.meta.url).href,
    })
    expect(paths.workspaceRoot).toBeDefined()
    expect(paths.args[paths.args.indexOf('web') + 1]).toBe('--patch')
    expect(paths.args.indexOf('--patch')).toBeLessThan(paths.args.indexOf('--host'))
    expect(paths.args.indexOf('--patch')).toBeLessThan(paths.args.indexOf('--no-open'))
    expect(paths.args).toEqual(expect.arrayContaining(['--no-open', '--host', '127.0.0.1', '--port', '0']))
  })

  it('detects Electron executables so dev spawn can refuse them', () => {
    expect(isElectronExecutable('/x/electron')).toBe(true)
    expect(isElectronExecutable('/opt/homebrew/bin/node')).toBe(false)
  })
})
