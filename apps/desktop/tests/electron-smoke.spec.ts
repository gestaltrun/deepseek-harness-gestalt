import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron')

describe.skipIf(process.env.DSH_DESKTOP_SMOKE !== '1')('Desktop Host smoke', () => {
  it('opens the Desktop composition with an inactive updater', async () => {
    if (process.platform === 'linux' && process.env.DISPLAY === undefined) return
    const dir = await mkdtemp(join(tmpdir(), 'gestalt-smoke-'))
    const log = join(dir, 'smoke.log')
    await writeFile(log, '')
    const child = spawn(electronBin, ['out/main.mjs'], {
      cwd: desktopRoot,
      env: {
        ...withoutRuntimePlatformEnvironment(process.env),
        DSH_DESKTOP_SMOKE: '1',
        DSH_DESKTOP_SMOKE_FILE: log,
        DSH_NODE: process.execPath,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const electronExited = new Promise<void>((resolve) => {
      child.once('exit', () => { resolve() })
    })
    let output = ''
    const onData = (chunk: Buffer): void => { output += chunk.toString() }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const text = await readFile(log, 'utf8')
      if (text.includes('\nok\n') || text.endsWith('\nok') || /(^|\n)ok\n/.test(text) || text.split('\n').includes('ok')) {
        const host = text.match(/host http:\/\/127\.0\.0\.1:\d+ pid (\d+)/)
        expect(host).not.toBeNull()
        expect(text).toMatch(/(^|\n)ok(\n|$)/)
        await electronExited
        const finalText = await readFile(log, 'utf8')
        expect(finalText).toContain('relay production-gate {"connected":false}')
        expect(finalText).toContain('relay sleep {"connected":false,"stopReason":"sleep"}')
        expect(finalText).toContain('relay mobile-access-disabled {"connected":false,"stopReason":"mobile-access-disabled"}')
        expect(finalText).toContain('relay window-close {"connected":false,"stopReason":"window-close"}')
        expect(finalText).toContain('relay quit {"connected":false,"stopReason":"quit"}')
        const pid = Number(host?.[1])
        await expect.poll(() => processExists(pid), { timeout: 5_000 }).toBe(false)
        return
      }
      if (
        text.includes('missing Desktop Session Surface evidence')
        || text.includes('missing window.__DSH_BOOT__')
        || text.includes('error ')
      ) {
        child.kill()
        throw new Error(text + '\n' + output.slice(-2000))
      }
      await new Promise((resolve) => { setTimeout(resolve, 250) })
    }
    child.kill()
    throw new Error('desktop smoke timed out\n' + (await readFile(log, 'utf8')) + '\n' + output.slice(-2000))
  }, 120_000)
})

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function withoutRuntimePlatformEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !name.startsWith('DSH_PLATFORM_')),
  )
}
