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
      configArgs: ['web', '--patch', join(here, '..', 'cordis.patch.yml'), '--port', '0'],
      mode: 'lib',
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

  it('still boots to the URL announcement and a diagnosable phone route when mobilecli is unresolvable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-boot-'))
    const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-boot-home-'))
    const launch = resolveExampleLaunch({
      srcBin: join(repo, 'apps', 'cli', 'src', 'bin.ts'),
      configArgs: ['web', '--patch', join(here, '..', 'cordis.patch.yml'), '--port', '0'],
      mode: 'lib',
      tsconfigPath: join(repo, 'tsconfig.base.json'),
    })
    let running: RunningWebHost | undefined
    try {
      // An Electron GUI process ships a minimal PATH and an empty HOME npx
      // cache; the optional phone provider must not kill the whole Host.
      // DSH_PHONE_MOBILECLI mounts the overlay phone rows; a missing path
      // is the unresolvable-binary case, not the opt-in-disabled case.
      running = await spawnWebHost({
        node: launch.command,
        args: launch.args,
        cwd: repo,
        env: {
          ...launch.env,
          DSH_HOME: home,
          HOME: emptyHome,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          DSH_PHONE_MOBILECLI: join(emptyHome, 'no-such-mobilecli'),
        },
      }, 120_000)
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const page = await fetch(running.url)
      expect(page.status).toBe(200)
      // The phone route stays up and answers with the structured, diagnosable
      // failure the tab's error arm renders.
      const devices = await fetch(`${running.url}/phone/devices`)
      expect(devices.status).toBe(502)
      const body = (await devices.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('PHONE_UNRESOLVED')
      expect(body.error?.message).toContain('waiting for its environment owner to select mobilecli')
    } finally {
      await running?.stop()
      rmSync(home, { recursive: true, force: true })
      rmSync(emptyHome, { recursive: true, force: true })
    }
  }, 150_000)
})
