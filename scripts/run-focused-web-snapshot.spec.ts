import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveFocusedWebSnapshotFile,
  runFocusedWebSnapshot,
  type FocusedWebCommand,
} from './run-focused-web-snapshot.ts'

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'focused-web-'))
  mkdirSync(join(root, 'apps', 'web', 'tests'), { recursive: true })
  mkdirSync(join(root, 'apps', 'mobile', 'tests'), { recursive: true })
  mkdirSync(join(root, 'apps', 'platform', 'tests'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'tests', 'flow.e2e.ts'), '')
  writeFileSync(join(root, 'apps', 'web', 'tests', 'state.snapshot.ts'), '')
  writeFileSync(join(root, 'apps', 'mobile', 'tests', 'shell.snapshot.ts'), '')
  writeFileSync(join(root, 'apps', 'platform', 'tests', 'homepage.snapshot.ts'), '')
  return root
}

describe('resolveFocusedWebSnapshotFile', () => {
  it.each([
    'apps/web/tests/flow.e2e.ts',
    'apps/web/tests/state.snapshot.ts',
    'apps/mobile/tests/shell.snapshot.ts',
    'apps/platform/tests/homepage.snapshot.ts',
  ])('accepts one existing Web inventory file: %s', (file) => {
    expect(resolveFocusedWebSnapshotFile([file], fixtureRoot())).toBe(file)
  })

  it('accepts the package-manager argument separator', () => {
    expect(resolveFocusedWebSnapshotFile(['--', 'apps/web/tests/flow.e2e.ts'], fixtureRoot()))
      .toBe('apps/web/tests/flow.e2e.ts')
  })

  it('rejects input outside one explicit Web inventory file', () => {
    const invalid: readonly (readonly string[])[] = [
      [],
      ['apps/web/tests/flow.e2e.ts', 'apps/web/tests/state.snapshot.ts'],
      ['--update'],
      ['../outside.e2e.ts'],
      ['/tmp/outside.e2e.ts'],
      ['apps/web/tests/not-a-snapshot.spec.ts'],
      ['apps/web/tests/missing.e2e.ts'],
    ]
    for (const args of invalid) {
      expect(() => resolveFocusedWebSnapshotFile(args, fixtureRoot())).toThrow()
    }
  })
})

describe('runFocusedWebSnapshot', () => {
  it('builds once before running the focused file in replay mode', async () => {
    const commands: FocusedWebCommand[] = []
    const run = vi.fn(async (command: FocusedWebCommand) => {
      commands.push(command)
      return 0
    })

    await expect(runFocusedWebSnapshot('apps/web/tests/flow.e2e.ts', {
      root: '/repo with spaces',
      environment: { npm_execpath: '/tools/pnpm.cjs', KEEP: 'yes', DEEPSEEK_API_KEY: 'must-not-survive' },
      run,
    })).resolves.toBe(0)

    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({
      cwd: '/repo with spaces',
      command: process.execPath,
      args: ['/tools/pnpm.cjs', 'run', 'build'],
    })
    expect(commands[1]).toMatchObject({
      cwd: '/repo with spaces',
      command: process.execPath,
      args: [
        '/tools/pnpm.cjs', 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts',
        'apps/web/tests/flow.e2e.ts',
      ],
    })
    expect(commands[1]?.environment.KEEP).toBe('yes')
    expect(commands[1]?.environment.DSH_SNAPSHOT).toBe('replay')
    expect(commands[1]?.environment).not.toHaveProperty('DEEPSEEK_API_KEY')
  })

  it('does not launch Vitest when the build fails', async () => {
    const run = vi.fn(async () => 7)

    await expect(runFocusedWebSnapshot('apps/web/tests/flow.e2e.ts', {
      root: '/repo',
      environment: { npm_execpath: '/tools/pnpm.cjs' },
      run,
    })).resolves.toBe(7)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
