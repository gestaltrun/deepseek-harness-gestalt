import { once } from 'node:events'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const MOBILE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXPECTED = fileURLToPath(new URL('../snapshots/product-entry.expected.txt', import.meta.url))
const VITE_BIN = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
let preview: ChildProcess | undefined
let browser: Browser | undefined
let origin = ''
let previewClosed: Promise<unknown> | undefined
let previewStdout: Promise<void> | undefined
let previewStderr: Promise<void> | undefined
let previewRoot: string | undefined

const BUILD_ENV = {
  VITE_PLATFORM_ENV: '',
  VITE_PLATFORM_ORIGIN: 'https://platform.example.com',
  VITE_PLATFORM_CALLBACK_URL: 'https://platform.example.com/v1/account/oauth/github/callback',
  VITE_PLATFORM_GITHUB_CLIENT_ID: 'mobile-operated',
  VITE_PLATFORM_CREDENTIAL_REFERENCE: 'credentials://operated',
  VITE_PLATFORM_DATABASE_IDENTITY: 'database-operated',
  VITE_PLATFORM_IDENTITY_NAMESPACE: 'namespace-operated',
  VITE_REMOTE_RELAY_WSS_URL: 'wss://relay.example.com/v1/remote-access/relay',
  VITE_REMOTE_RELAY_INBOUND_MAX_BYTES: '9999999',
  VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES: '8',
  VITE_REMOTE_RELAY_ATTACH_TIMEOUT_MS: '1000',
  VITE_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS: '5000',
  VITE_REMOTE_RELAY_RECONNECT_DELAY_MS: '100',
}

function drain(stream: Readable | null): Promise<void> {
  if (stream === null) return Promise.resolve()
  stream.resume()
  return new Promise((resolve, reject) => {
    stream.once('end', resolve)
    stream.once('error', reject)
  })
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, milliseconds) })
  const settled = await Promise.race([promise.then(() => true), timeout])
  if (timer !== undefined) clearTimeout(timer)
  return settled
}

function signalPreview(signal: NodeJS.Signals): void {
  if (preview?.pid === undefined || preview.exitCode !== null || preview.signalCode !== null) return
  if (process.platform === 'win32') {
    preview.kill(signal)
    return
  }
  try {
    process.kill(-preview.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function processGroupExited(pid: number): Promise<boolean> {
  if (process.platform === 'win32') return true
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

async function stopPreview(): Promise<void> {
  if (preview === undefined || previewClosed === undefined) return
  const pid = preview.pid
  if (preview.exitCode === null && preview.signalCode === null) signalPreview('SIGTERM')
  if (!await settlesWithin(previewClosed, 3_000)) signalPreview('SIGKILL')
  if (!await settlesWithin(previewClosed, 5_000)) throw new Error('Mobile preview did not close after SIGKILL')
  if (pid !== undefined && !await processGroupExited(pid)) {
    throw new Error('Mobile preview process tree remained alive after close')
  }
  await Promise.all([previewStdout, previewStderr])
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mobile snapshot could not reserve a loopback port')
  await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  return address.port
}

async function waitForPreview(url: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The preview process is still binding the loopback socket.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Mobile preview did not become ready at ${url}`)
}

beforeAll(async () => {
  previewRoot = await mkdtemp(join(tmpdir(), 'dsh-mobile-product-entry-'))
  const build = spawnSync(process.execPath, [
    VITE_BIN, 'build',
    '--outDir', previewRoot, '--emptyOutDir',
  ], {
    cwd: MOBILE_ROOT,
    env: { ...process.env, ...BUILD_ENV },
    encoding: 'utf8',
  })
  if (build.status !== 0) throw new Error(`Mobile product build failed:\n${build.stdout}\n${build.stderr}`)
  const port = await availablePort()
  if (port === 5173 || port === 5174) throw new Error('Mobile product snapshot reserved a prohibited prototype port')
  origin = `http://127.0.0.1:${String(port)}`
  preview = spawn(process.execPath, [
    VITE_BIN, 'preview',
    '--outDir', previewRoot,
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], {
    cwd: MOBILE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  previewClosed = once(preview, 'close')
  previewStdout = drain(preview.stdout)
  previewStderr = drain(preview.stderr)
  await waitForPreview(origin)
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  browser = await chromium.launch(executablePath === undefined ? { headless: true } : { headless: true, executablePath })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await stopPreview()
  if (previewRoot !== undefined) await rm(previewRoot, { recursive: true, force: true })
})

describe('bundled Mobile product entry', () => {
  it('boots the operated production entry without a development projection or prototype origin', async () => {
    if (browser === undefined) throw new Error('Mobile snapshot browser unavailable')
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      colorScheme: 'light',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    })
    const page = await context.newPage()
    await page.goto(origin)
    const main = page.locator('[data-mobile-platform-account]')
    await expect.poll(async () => await main.getAttribute('data-mobile-platform-account')).toBe('idle')
    expect(await page.getByRole('checkbox').count()).toBe(1)
    expect(await page.getByRole('button', { name: '使用 GitHub 继续' }).isDisabled()).toBe(true)
    expect(await page.locator('[data-mobile-conversation]').count()).toBe(0)
    expect(page.url()).not.toMatch(/:517[34](?:\/|$)/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    const text = (await main.innerText()).replace(/[ \t]+$/gm, '').trimEnd() + '\n'
    await expect(text).toMatchFileSnapshot(EXPECTED)
    await context.close()
  })
})
