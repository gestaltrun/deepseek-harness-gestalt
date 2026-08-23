import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

describe('Desktop overlay isolation', () => {
  it('keeps Desktop-only plugins out of the default web graph', () => {
    const web = readFileSync(join(repo, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'), 'utf8')
    const desktop = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
    expect(web).not.toMatch(/ui-desktop|dsh-client-ui-desktop|dsh-time-context|dsh-schedule/)
    expect(web).not.toMatch(/browser-runtime-electron-http|DSH_ELECTRON_BROWSER/)
    expect(desktop).not.toMatch(/id: time-context|dsh-time-context/)
    expect(desktop).toMatch(/id: schedule/)
    expect(desktop).toMatch(/@deepseek-ai\/dsh-schedule/)
    expect(desktop).toMatch(/id: ui-desktop/)
    expect(desktop).toMatch(/@deepseek-ai\/dsh-client-ui-desktop/)
    expect(desktop).toMatch(/id: browser-runtime-electron-http/)
    expect(desktop).toMatch(/@deepseek-ai\/dsh-browser-runtime-tandem/)
    expect(desktop).toMatch(/DSH_ELECTRON_BROWSER_ORIGIN/)
    expect(desktop).toMatch(/sidecar: false/)
    expect(desktop).toMatch(/id: browser-runtime-deterministic[\s\S]*disabled: !!js process\.env\.DSH_ELECTRON_BROWSER_ORIGIN/)
    expect(desktop).toMatch(/id: browser-runtime-electron-http[\s\S]*disabled: !!js process\.env\.DSH_ELECTRON_BROWSER_ORIGIN == null/)
    expect(desktop).not.toMatch(/directory-picker/)
    expect(desktop).not.toMatch(/Tandem\.app/)
    expect(desktop).not.toMatch(/^\s+command:/m)
    expect(desktop).not.toMatch(/^\s+cwd:/m)
    expect(desktop).not.toMatch(/DSH_TANDEM_BIN/)
    expect(desktop).toMatch(/id: web-runtime[\s\S]*openBrowser: false/)
  })

  it('composes Schedule through the Desktop profile path after its required services', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-overlay-'))
    const bin = join(repo, 'apps', 'cli', 'src', 'bin.ts')
    const patch = join(here, '..', 'cordis.patch.yml')
    const run = (args: readonly string[]): string => {
      const launch = resolveExampleLaunch({
        srcBin: bin,
        configArgs: args,
        tsconfigPath: join(repo, 'tsconfig.base.json'),
      })
      return execFileSync(launch.command, launch.args, {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, ...launch.env, DSH_HOME: home },
      })
    }
    try {
      const web = run(['web', '--dump-default-config'])
      expect(web).not.toMatch(/ui-desktop|dsh-client-ui-desktop|dsh-time-context|dsh-schedule|browser-runtime-electron-http/)
      expect(web).toMatch(/@deepseek-ai\/dsh-host-directory-picker-auto/)

      const desktop = run(['web', '--patch', patch, '--dump-config'])
      const persistence = desktop.indexOf("name: '@deepseek-ai/dsh-session-persistence-jsonl'")
      const agents = desktop.indexOf("name: '@deepseek-ai/dsh-agent-loop'")
      const schedule = desktop.indexOf("name: '@deepseek-ai/dsh-schedule'")
      expect(persistence).toBeGreaterThanOrEqual(0)
      expect(agents).toBeGreaterThanOrEqual(0)
      expect(desktop).not.toMatch(/@deepseek-ai\/dsh-time-context/)
      expect(schedule).toBeGreaterThan(agents)
      expect(schedule).toBeGreaterThan(persistence)
      expect(desktop).toMatch(/@deepseek-ai\/dsh-client-ui-desktop/)
      expect(desktop).toMatch(/@deepseek-ai\/dsh-browser-runtime-deterministic/)
      expect(desktop).toMatch(/@deepseek-ai\/dsh-browser-runtime-tandem/)
      expect(desktop).toMatch(/sidecar: false/)
      expect(desktop).toMatch(/disabled: true/)
      expect(desktop).toMatch(/openBrowser: false/)
      expect(web).toMatch(/openBrowser: !!js ctx\.webStartup\.openBrowser/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)

  it('keeps dsh-scope and dsh-timeout in the deploy graph', () => {
    const cli = readFileSync(join(repo, 'apps', 'cli', 'package.json'), 'utf8')
    expect(cli).toMatch(/"@deepseek-ai\/dsh-scope"/)
    expect(cli).toMatch(/"@deepseek-ai\/dsh-timeout"/)
  })
})
