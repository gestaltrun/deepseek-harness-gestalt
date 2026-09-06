import { once } from 'node:events'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import process from 'node:process'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPERATED_PLATFORM_BUILD_ENV } from './fixtures/operated-platform-environment.fixture.ts'

const MOBILE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const VITE_CONFIG = fileURLToPath(new URL('./real-entry-runtime-identity.vite.config.ts', import.meta.url))
const EXPECTED = join(process.cwd(), 'apps/mobile/tests/snapshots/real-entry-runtime-identity/entry.expected.md')
const REFRESHING_GOLDEN = process.env.DSH_UPDATE_SNAPSHOTS === '1'
let preview: ChildProcess | undefined
let previewClosed: Promise<unknown> | undefined
let browser: Browser | undefined
let origin = ''
let outputRoot: string | undefined

function drain(stream: Readable | null): void {
  stream?.resume()
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mobile real-entry snapshot could not reserve a port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function waitForPreview(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return
    } catch {
      // The preview process is still binding the loopback socket.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Mobile real-entry preview did not become ready at ${origin}`)
}

beforeAll(async () => {
  outputRoot = await mkdtemp(join(process.env.RUNNER_TEMP ?? '/tmp', 'dsh-mobile-real-entry-'))
  const build = spawnSync(process.execPath, [VITE_BIN, 'build', '--config', VITE_CONFIG, '--configLoader', 'runner', '--outDir', outputRoot, '--emptyOutDir'], {
    cwd: MOBILE_ROOT,
    env: { ...process.env, ...OPERATED_PLATFORM_BUILD_ENV },
    encoding: 'utf8',
  })
  if (build.status !== 0) throw new Error(`Mobile real-entry build failed:\n${build.stdout}\n${build.stderr}`)
  const port = await availablePort()
  origin = `http://127.0.0.1:${String(port)}`
  preview = spawn(process.execPath, [VITE_BIN, 'preview', '--config', VITE_CONFIG, '--configLoader', 'runner', '--outDir', outputRoot, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: MOBILE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  previewClosed = once(preview, 'close')
  drain(preview.stdout)
  drain(preview.stderr)
  await waitForPreview()
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  browser = await chromium.launch(executablePath === undefined ? { headless: true } : { headless: true, executablePath })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  if (preview?.pid !== undefined && preview.exitCode === null && preview.signalCode === null) {
    if (process.platform === 'win32') preview.kill('SIGTERM')
    else process.kill(-preview.pid, 'SIGTERM')
  }
  await previewClosed
  if (outputRoot !== undefined) await rm(outputRoot, { recursive: true, force: true })
})

describe('built Mobile real entry runtime identity', () => {
  it('fails before account acquisition when identity is absent or wrong, then uses the packaged origin', async () => {
    const activeBrowser = browser
    if (activeBrowser === undefined) throw new Error('Mobile real-entry snapshot browser unavailable')
    const lines: string[] = []

    for (const scenario of ['absent', 'wrong'] as const) {
      const page = await activeBrowser.newPage()
      await page.route('**/dsh-mobile-runtime-identity.json', async (route) => {
        if (scenario === 'absent') await route.fulfill({ status: 404, body: 'missing' })
        else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, origin: 'https://wrong.example' }) })
      })
      await page.goto(origin)
      const failure = page.locator('[data-mobile-startup="failed"]')
      await expect.poll(async () => await failure.count()).toBe(1)
      lines.push(`${scenario}: ${await failure.getAttribute('role')} | ${(await failure.locator('p').innerText()).trim()}`)
      await page.close()
    }

    const page = await activeBrowser.newPage()
    await page.goto(origin)
    await expect.poll(async () => await page.locator('html').getAttribute('data-mobile-runtime-origin')).toBe('https://platform.example.com')
    lines.push(`success: ${await page.locator('html').getAttribute('data-mobile-runtime-origin')}`)

    const shape = `${lines.join('\n')}\n`
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
    await page.close()
  })
})
