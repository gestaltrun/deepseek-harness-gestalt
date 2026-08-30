import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { spawnWebHost, type RunningWebHost } from '../src/spawn-web-host.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

describe('Desktop overlay composed boot', () => {
  it('boots the web-app roster with the Desktop overlay to the URL announcement and a 200 entry page', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-boot-'))
    const launch = resolveExampleLaunch({
      srcBin: join(repo, 'apps', 'cli', 'src', 'bin.ts'),
      configArgs: ['web', '--patch', join(here, '..', 'cordis.patch.yml')],
      tsconfigPath: join(repo, 'tsconfig.base.json'),
    })
    let running: RunningWebHost | undefined
    try {
      // The Loader instantiates every composed entry id exactly once during
      // this boot; a duplicate id kills the process before any announcement,
      // which `--dump-config` composition cannot observe.
      running = await spawnWebHost({
        node: launch.command,
        args: launch.args,
        cwd: repo,
        env: { ...launch.env, DSH_HOME: home },
      }, 120_000)
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const page = await fetch(running.url)
      expect(page.status).toBe(200)
    } finally {
      await running?.stop()
      rmSync(home, { recursive: true, force: true })
    }
  }, 150_000)
})
