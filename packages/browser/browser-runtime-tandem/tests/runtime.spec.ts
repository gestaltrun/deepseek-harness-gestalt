import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TandemBrowserRuntime from '@deepseek-ai/dsh-browser-runtime-tandem'
import { BrowserProfileName, BrowserRuntimeError, BrowserWorkspaceId } from '@deepseek-ai/dsh-browser-runtime'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tandem-http-fixture.mjs')
// Fixture children are real Node processes; coverage instrumentation slows their boot.
vi.setConfig({ testTimeout: 30_000 })
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const contexts: Context[] = []

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly tokenFile: string
  readonly pidFile: string
  readonly crashMarker: string
}

/** Private seams reachable only from this package's own behavioral tests. */
interface RuntimeInternals {
  profiles: Map<string, { tabs: Map<string, string> }>
  closing: boolean
  recoveryScheduled: boolean
  disposed: boolean
  states: Map<string, unknown>
  ctx: Context
  process: unknown
  page(state: never, signal: AbortSignal | undefined): Promise<unknown>
  processExited(handle: unknown, detail: string): void
  scheduleRecovery(reason: 'crashed' | 'unhealthy', projectNow: boolean): unknown
  reconnect(lastOpen: never, unavailable: never): Promise<void>
  readTab(tabId: string, signal: AbortSignal | undefined): Promise<unknown>
  createSession(sessionName: string, signal: AbortSignal | undefined, url?: string): Promise<unknown>
}

function runtimeOf(ctx: Context): RuntimeInternals {
  return ctx.browserRuntime as unknown as RuntimeInternals
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP test port')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return address.port
}

async function setup(faults: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tandem-provider-'))
  const port = await freePort()
  const tokenFile = join(root, 'api-token')
  const pidFile = join(root, 'fixture.pid')
  const crashMarker = join(root, 'crash-marker')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(TandemBrowserRuntime, {
    command: process.execPath,
    args: [FIXTURE],
    cwd: root,
    env: {
      TANDEM_FIXTURE_PORT: String(port),
      TANDEM_FIXTURE_TOKEN_FILE: tokenFile,
      TANDEM_FIXTURE_CRASH_MARKER: crashMarker,
      TANDEM_FIXTURE_PID_FILE: pidFile,
      TANDEM_FIXTURE_FAULTS: JSON.stringify(faults),
    },
    baseUrl: `http://127.0.0.1:${String(port)}`,
    tokenFile,
    idPrefix: 'tandem-test',
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    healthPollMs: 10,
    reconnectAttempts: 1,
    reconnectDelayMs: 10,
    processGraceMs: 100,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  })
  return { ctx, root, tokenFile, pidFile, crashMarker }
}

const RM_RETRY_LIMIT = 10
const RM_RETRY_DELAY_MS = 50

function retryableRmError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

/** Remove a temp tree after every handle has dropped; retry Windows linger codes. */
async function rmWhenIdle(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= RM_RETRY_LIMIT || !retryableRmError(error)) throw error
      await new Promise(resolve => setTimeout(resolve, RM_RETRY_DELAY_MS))
    }
  }
}

/** Kill a directly spawned fixture and await its exit before directory removal. */
async function joinSpawnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => { resolve() })
    child.once('error', reject)
    if (child.exitCode !== null || child.signalCode !== null) resolve()
  })
  child.kill('SIGTERM')
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 1_000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

/** Poll until the recorded fixture child pid is no longer schedulable. */
async function assertJoined(pidFile: string): Promise<void> {
  let pid = 0
  const appear = Date.now() + 3_000
  while (Date.now() < appear) {
    try {
      pid = Number((await readFile(pidFile, 'utf8')).trim())
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  if (pid === 0) throw new Error('fixture child never recorded its pid')
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`fixture child ${String(pid)} did not exit`)
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('Tandem Browser Runtime configuration', () => {
  it('rejects invalid Config values at load', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['empty command', { command: '' }, /command must be non-empty/],
      ['blank cwd', { cwd: ' ' }, /cwd must be non-empty/],
      ['command without cwd', { command: process.execPath, cwd: undefined }, /command and cwd must both be set/],
      ['empty tokenFile', { tokenFile: '' }, /tokenFile must be non-empty/],
      ['blank idPrefix', { idPrefix: ' \t' }, /idPrefix must be non-empty/],
      ['zero startupTimeoutMs', { startupTimeoutMs: 0 }, /startupTimeoutMs/],
      ['fractional requestTimeoutMs', { requestTimeoutMs: 1.5 }, /requestTimeoutMs/],
      ['oversized healthPollMs', { healthPollMs: 2_147_483_648 }, /healthPollMs/],
      ['zero reconnectDelayMs', { reconnectDelayMs: 0 }, /reconnectDelayMs/],
      ['fractional pageSettleMs', { pageSettleMs: 1.5 }, /pageSettleMs/],
      ['fractional processGraceMs', { processGraceMs: 1.5 }, /processGraceMs/],
      ['zero maxResponseBytes', { maxResponseBytes: 0 }, /maxResponseBytes must be a positive safe integer/],
      ['negative reconnectAttempts', { reconnectAttempts: -1 }, /reconnectAttempts/],
      ['fractional reconnectAttempts', { reconnectAttempts: 1.5 }, /reconnectAttempts/],
      ['unparseable baseUrl', { baseUrl: 'not-a-url' }, /loopback HTTP origin/],
      ['non-http baseUrl', { baseUrl: 'https://127.0.0.1:8765/' }, /loopback HTTP origin/],
      ['remote baseUrl', { baseUrl: 'http://example.com/' }, /loopback HTTP origin/],
      ['private-address baseUrl', { baseUrl: 'http://10.0.0.5:8765/' }, /loopback HTTP origin/],
      ['credentialed baseUrl', { baseUrl: 'http://user:pass@127.0.0.1:8765/' }, /loopback HTTP origin/],
      ['baseUrl pathname', { baseUrl: 'http://127.0.0.1:8765/base' }, /loopback HTTP origin/],
      ['baseUrl search', { baseUrl: 'http://127.0.0.1:8765/?q=1' }, /loopback HTTP origin/],
      ['baseUrl hash', { baseUrl: 'http://127.0.0.1:8765/#f' }, /loopback HTTP origin/],
    ]
    for (const [label, overrides, failure] of cases) {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SubprocessLocal)
      await expect(ctx.plugin(TandemBrowserRuntime, {
        command: process.execPath,
        args: [],
        cwd: process.cwd(),
        baseUrl: 'http://127.0.0.1:8765',
        tokenFile: '/tmp/token',
        ...overrides,
      }), label).rejects.toThrow(failure)
    }
  })

  it('loads as a protocol-only HTTP client without a fixture child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tandem-protocol-'))
    const port = await freePort()
    const tokenFile = join(root, 'api-token')
    const child = spawn(process.execPath, [FIXTURE], {
      cwd: root,
      env: {
        ...process.env,
        TANDEM_FIXTURE_PORT: String(port),
        TANDEM_FIXTURE_TOKEN_FILE: tokenFile,
      },
      stdio: 'ignore',
    })
    const ctx = new Context()
    contexts.push(ctx)
    try {
      await ctx.plugin(TandemBrowserRuntime, {
        baseUrl: `http://127.0.0.1:${String(port)}`,
        tokenFile,
        idPrefix: 'protocol-only',
        sidecar: false,
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 2_000,
        healthPollMs: 10,
        reconnectAttempts: 0,
        processGraceMs: 100,
      })
      const created = await ctx.browserRuntime.create({ profile: 'temporary' })
      expect(created.chrome.partition).toBe('session-protocol-only-tmp-1')
      await ctx.browserRuntime.close({ target: created.target, expectedRevision: 0 })
    } finally {
      const index = contexts.indexOf(ctx)
      if (index !== -1) contexts.splice(index, 1)
      await ctx.fiber.dispose()
      await joinSpawnedChild(child)
      await rmWhenIdle(root)
    }
  })

  it('rejects a fixture command when subprocess is not composed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(TandemBrowserRuntime, {
      command: process.execPath,
      cwd: process.cwd(),
      baseUrl: `http://127.0.0.1:${String(await freePort())}`,
      tokenFile: '/tmp/token',
      startupTimeoutMs: 200,
      requestTimeoutMs: 200,
      healthPollMs: 10,
      reconnectAttempts: 0,
    })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /requires ctx.subprocess/ })
  })

  it('rejects command and cwd at load when sidecar is disabled', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(TandemBrowserRuntime, {
      command: process.execPath,
      cwd: process.cwd(),
      sidecar: false,
      baseUrl: `http://127.0.0.1:${String(await freePort())}`,
      tokenFile: '/tmp/token',
      startupTimeoutMs: 200,
      requestTimeoutMs: 200,
      healthPollMs: 10,
      reconnectAttempts: 0,
    })).rejects.toThrow(/command and cwd must be omitted when sidecar is disabled/)
  })

  it('accepts every loopback hostname form and the default identity prefix', async () => {
    for (const baseUrl of [`http://localhost:${String(await freePort())}`, `http://[::1]:${String(await freePort())}`]) {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SubprocessLocal)
      await ctx.plugin(TandemBrowserRuntime, {
        command: process.execPath,
        cwd: process.cwd(),
        baseUrl,
        tokenFile: '/tmp/token',
      })
    }
  })
})

describe('Tandem Browser Runtime public lifecycle', () => {
  it('runs one temporary Profile through the pinned Tandem HTTP protocol', async () => {
    const { ctx, pidFile } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(created).toEqual({
      status: 'open',
      target: {
        profileId: 'tandem-test-tmp-1',
        workspaceId: 'tandem-test-tmp-1-workspace',
        browserId: 'tandem-test-tmp-1-browser-1',
        tabId: 'tandem-test-tmp-1-tab-1',
      },
      revision: 0,
      url: 'about:blank',
      title: 'New Tab',
      text: '',
      focused: false,
      chrome: {
        kind: 'temporary',
        partition: 'session-tandem-test-tmp-1',
      },
      storage: {
        cookies: '',
        localStorage: '',
        indexedDb: '',
        cache: '',
        serviceWorker: '',
      },
    })

    const navigated = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://example.test/',
    })
    expect(navigated).toMatchObject({
      revision: 1,
      url: 'https://example.test/',
      title: 'Example Domain',
      text: 'A real Tandem protocol page.',
    })
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(navigated)
    await expect(ctx.browserRuntime.screenshot({ target: created.target })).resolves.toMatchObject({
      target: created.target,
      revision: 1,
      url: 'https://example.test/',
      title: 'Example Domain',
      mediaType: 'image/png',
      data: PNG_1X1,
    })
    const focused = await ctx.browserRuntime.focus({ target: created.target, expectedRevision: 1 })
    expect(focused).toMatchObject({ revision: 2, focused: true })
    const closed = await ctx.browserRuntime.close({ target: created.target, expectedRevision: 2 })
    expect(closed).toEqual({ status: 'closed', target: created.target, revision: 3 })
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(closed)
    await assertJoined(pidFile)
  })

  it('serializes synthetic input with navigation in both arrival orders', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const identities = created.target

    const inputFirst = await Promise.allSettled([
      ctx.browserRuntime.input({
        target: created.target,
        expectedRevision: 0,
        url: 'https://example.test/',
        text: 'synthetic input',
      }),
      ctx.browserRuntime.navigate({
        target: created.target,
        expectedRevision: 0,
        url: 'https://login.test/',
      }),
    ])
    expect(inputFirst.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const inputFirstFulfilled = inputFirst.find(result => result.status === 'fulfilled')
    expect(inputFirstFulfilled?.status === 'fulfilled' ? inputFirstFulfilled.value : undefined).toMatchObject({
      status: 'open',
      revision: 1,
      url: 'https://example.test/',
      text: 'synthetic input',
      target: identities,
    })
    const inputFirstRejected = inputFirst.find(result => result.status === 'rejected')
    if (inputFirstRejected?.status !== 'rejected') throw new Error('expected a revision conflict')
    if (!(inputFirstRejected.reason instanceof BrowserRuntimeError)) throw new Error('expected BrowserRuntimeError')
    expect(inputFirstRejected.reason.code).toBe('BROWSER_REVISION_CONFLICT')
    expect(inputFirstRejected.reason.message).toMatch(/current 1; observe again before mutating/)
    const afterInput = await ctx.browserRuntime.observe({ target: created.target })
    expect(afterInput).toMatchObject({
      status: 'open',
      revision: 1,
      url: 'https://example.test/',
      target: identities,
    })
    await expect(ctx.browserRuntime.focus({ target: created.target, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'BROWSER_REVISION_CONFLICT' })

    const navigateFirst = await Promise.allSettled([
      ctx.browserRuntime.navigate({
        target: created.target,
        expectedRevision: afterInput.revision,
        url: 'https://login.test/',
      }),
      ctx.browserRuntime.input({
        target: created.target,
        expectedRevision: afterInput.revision,
        text: 'later input',
      }),
    ])
    expect(navigateFirst.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const navigateFirstRejected = navigateFirst.find(result => result.status === 'rejected')
    expect(navigateFirstRejected?.status === 'rejected' ? navigateFirstRejected.reason : undefined).toMatchObject({
      code: 'BROWSER_REVISION_CONFLICT',
    })
    const afterNavigate = await ctx.browserRuntime.observe({ target: created.target })
    expect(afterNavigate).toMatchObject({
      status: 'open',
      revision: 2,
      url: 'https://login.test/',
      target: identities,
    })
  })

  it('restores a named Tandem Profile through a stable persist partition and isolates two identities', async () => {
    const { ctx } = await setup()
    const work = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    expect(work.chrome).toEqual({
      kind: 'persistent',
      name: 'work',
      partition: 'persist:session-tandem-test-work',
    })
    const signedIn = await ctx.browserRuntime.navigate({
      target: work.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    expect(signedIn.storage).toEqual({
      cookies: 'profile=work',
      localStorage: 'work',
      indexedDb: 'work',
      cache: 'work',
      serviceWorker: 'work',
    })
    expect(signedIn.text).toContain('identity=work')
    await ctx.browserRuntime.close({ target: work.target, expectedRevision: signedIn.revision })

    const personal = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('personal') })
    expect(personal.chrome.partition).toBe('persist:session-tandem-test-personal')
    const personalPage = await ctx.browserRuntime.navigate({
      target: personal.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    expect(personalPage.storage.localStorage).toBe('personal')
    expect(personalPage.text).toContain('identity=personal')
    expect(personalPage.storage).not.toEqual(signedIn.storage)
    await ctx.browserRuntime.close({ target: personal.target, expectedRevision: personalPage.revision })

    const restored = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    expect(restored.chrome.partition).toBe(work.chrome.partition)
    expect(restored.target.profileId).toBe(work.target.profileId)
    expect(restored.storage).toEqual({
      cookies: '',
      localStorage: '',
      indexedDb: '',
      cache: '',
      serviceWorker: '',
    })
    expect(restored.text).toContain('identity=work')
  })

  it('attaches a second Tandem tab to an open temporary Profile', async () => {
    const { ctx } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'temporary' })
    const second = await ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })
    expect(second.target.profileId).toBe(first.target.profileId)
    expect(second.target.tabId).not.toBe(first.target.tabId)
    const third = await ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: first.target.workspaceId },
    })
    expect(third.target.browserId).not.toBe(first.target.browserId)
    await expect(ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: BrowserWorkspaceId('missing') },
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' })
    await ctx.browserRuntime.close({ target: third.target, expectedRevision: 0 })
    const runtime = runtimeOf(ctx)
    runtime.profiles.get(first.target.profileId)?.tabs.delete(first.target.tabId)
    await expect(ctx.browserRuntime.navigate({
      target: first.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
    runtime.profiles.get(first.target.profileId)?.tabs.set(first.target.tabId, 'restored-tab')
    await ctx.browserRuntime.close({ target: second.target, expectedRevision: 0 })
    await ctx.browserRuntime.close({ target: first.target, expectedRevision: 0 })
  })

  it('discards a temporary Tandem Profile identity and never labels it', async () => {
    const { ctx } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(first.chrome).not.toHaveProperty('name')
    await ctx.browserRuntime.navigate({
      target: first.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    await ctx.browserRuntime.close({ target: first.target, expectedRevision: 1 })
    const second = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(second.chrome.partition).not.toBe(first.chrome.partition)
    expect(second.storage).toEqual({
      cookies: '',
      localStorage: '',
      indexedDb: '',
      cache: '',
      serviceWorker: '',
    })
    expect(second.text).not.toContain('identity=')
    expect(second.chrome).not.toHaveProperty('name')
  })

  it('rejects a second writer of the same named Tandem Profile', async () => {
    const { ctx } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    await expect(ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') }))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_BUSY' })
    await expect(ctx.browserRuntime.observe({ target: first.target })).resolves.toMatchObject({
      status: 'open',
      revision: 0,
      chrome: { name: 'work' },
    })
  })

  it('reuses one shared Tandem Profile without a second-writer rejection', async () => {
    const { ctx } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'shared' })
    const second = await ctx.browserRuntime.create({ profile: 'shared' })
    expect(first.chrome).toMatchObject({
      kind: 'shared',
      partition: 'persist:session-tandem-test-shared',
    })
    expect(second.target.profileId).toBe(first.target.profileId)
    expect(second.target.workspaceId).not.toBe(first.target.workspaceId)
    expect(second.chrome.partition).toBe(first.chrome.partition)
  })

  it('keeps the shared Tandem child alive when a later create fails', async () => {
    const { ctx, pidFile } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    const firstPid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(Number.isInteger(firstPid)).toBe(true)
    const runtime = runtimeOf(ctx)
    const originalCreateSession = runtime.createSession?.bind(runtime)
    runtime.createSession = async () => {
      throw new BrowserRuntimeError('Tandem session create tab field id must be a string', 'BROWSER_PROTOCOL')
    }
    await expect(ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('home') }))
      .rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })
    await expect(ctx.browserRuntime.create({
      profile: 'persistent',
      name: BrowserProfileName('work'),
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })
    runtime.createSession = originalCreateSession
    const stillPid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(stillPid).toBe(firstPid)
    await expect(ctx.browserRuntime.observe({ target: first.target })).resolves.toMatchObject({
      status: 'open',
      chrome: { name: 'work' },
    })
  })

  it('rejects operations on absent, foreign, closed, and revision-mismatched state', async () => {
    const { ctx } = await setup()
    await expect(ctx.browserRuntime.observe({
      target: { profileId: 'p' as never, workspaceId: 'w' as never, browserId: 'b' as never, tabId: 't' as never },
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const foreign = { ...created.target, tabId: 'other-tab' as never }
    await expect(ctx.browserRuntime.navigate({
      target: foreign,
      expectedRevision: 0,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 7,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_REVISION_CONFLICT' })
    await expect(ctx.browserRuntime.focus({ target: created.target, expectedRevision: 3 }))
      .rejects.toMatchObject({ code: 'BROWSER_REVISION_CONFLICT' })
    await expect(ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') }))
      .resolves.toMatchObject({ chrome: { name: 'work' } })
    await ctx.browserRuntime.close({ target: created.target, expectedRevision: 0 })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 1,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_OPEN' })
    await expect(ctx.browserRuntime.close({ target: created.target, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'BROWSER_NOT_OPEN' })
    await expect(ctx.browserRuntime.screenshot({ target: created.target }))
      .rejects.toMatchObject({ code: 'BROWSER_NOT_OPEN' })
  })

  it('rejects already-aborted work before touching process or HTTP state', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before entry'))
    const target = { profileId: 'p' as never, workspaceId: 'w' as never, browserId: 'b' as never, tabId: 't' as never }
    await expect(ctx.browserRuntime.create({ profile: 'temporary', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    await expect(ctx.browserRuntime.navigate({
      target,
      expectedRevision: 0,
      url: 'https://example.test/',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    await expect(ctx.browserRuntime.observe({ target, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    await expect(ctx.browserRuntime.screenshot({ target, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    await expect(ctx.browserRuntime.focus({ target, expectedRevision: 0, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    await expect(ctx.browserRuntime.input({ target, expectedRevision: 0, text: 'x', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    await expect(ctx.browserRuntime.close({ target, expectedRevision: 0, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
  })

  it('rejects operations once disposal begins', async () => {
    const { ctx } = await setup()
    const runtime = ctx.browserRuntime
    await runtime.create({ profile: 'temporary' })
    await ctx.fiber.dispose()
    await expect(runtime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_DISPOSED' })
  })

  it('contains post-commit observer failures without starving later observers', async () => {
    const { ctx } = await setup()
    const observed: number[] = []
    ctx.on('browser/runtime-state', () => { throw new Error('ordinary observer failed') })
    ctx.on('browser/runtime-state', (): unknown => Promise.reject(new Error('async observer failed')))
    ctx.on('browser/runtime-state', (state: { revision: number }) => { observed.push(state.revision) })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const navigated = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://example.test/',
    })
    expect(observed).toEqual([created.revision, navigated.revision])
  })
})

describe('Tandem Browser Runtime startup bounds', () => {
  it('aborts a pending health probe and joins the child', async () => {
    const { ctx, pidFile } = await setup({ slow: 'health' }, { requestTimeoutMs: 5_000 })
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('cancelled mid-health')) }, 1_500)
    await expect(ctx.browserRuntime.create({ profile: 'temporary', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    await assertJoined(pidFile)
  })

  it('aborts a pending health-poll delay', async () => {
    const { ctx } = await setup({ status: 'never-ready' }, { startupTimeoutMs: 10_000, healthPollMs: 250 })
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('cancelled mid-poll')) }, 350)
    await expect(ctx.browserRuntime.create({ profile: 'temporary', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
  })

  it('rejects a child that exits before startup health completes', async () => {
    const { ctx } = await setup({ exitAtBoot: true }, { startupTimeoutMs: 1_000 })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /child exited before startup health/ })
  })

  it('treats omitted page-content storage as empty identity', async () => {
    const { ctx } = await setup({ pageContent: 'omit-storage' })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(created.storage).toEqual({
      cookies: '',
      localStorage: '',
      indexedDb: '',
      cache: '',
      serviceWorker: '',
    })
  })

  it('still creates a Profile when page-content is malformed at open', async () => {
    const { ctx } = await setup({ pageContent: 'non-object' })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' })).resolves.toMatchObject({
      status: 'open',
      url: 'about:blank',
      chrome: { kind: 'temporary' },
    })
    const named = await setup({ pageContent: 'non-object' })
    await expect(named.ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') }))
      .resolves.toMatchObject({
        status: 'open',
        chrome: { kind: 'persistent', name: 'work' },
        storage: {
          cookies: '',
          localStorage: '',
          indexedDb: '',
          cache: '',
          serviceWorker: '',
        },
        text: 'identity=work',
      })
    const seeded = await setup({ pageContent: 'seed-storage' })
    await expect(seeded.ctx.browserRuntime.create({ profile: 'temporary' }))
      .resolves.toMatchObject({ storage: { localStorage: 'seeded' } })
  })

  it('bounds startup health verification in time', async () => {
    const { ctx, pidFile } = await setup({ status: 'never-ready' }, { startupTimeoutMs: 1_000, healthPollMs: 20 })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /startup health timed out/ })
    await assertJoined(pidFile)
  })

  it('verifies the pinned product and version before admitting the session', async () => {
    for (const [faults, failure] of [
      [{ version: 'wrong-name' }, /must report tandem-browser 1\.11\.4/],
      [{ version: 'wrong-version' }, /must report tandem-browser 1\.11\.4/],
      [{ version: 'missing-name' }, /version response field name/],
      [{ version: 'non-object' }, /version response must be an object/],
      [{ status: 'bad-ready' }, /status response field ready must be boolean/],
    ] as const) {
      const { ctx } = await setup({ ...faults }, { startupTimeoutMs: 3_000 })
      await expect(ctx.browserRuntime.create({ profile: 'temporary' }), JSON.stringify(faults))
        .rejects.toMatchObject({ code: 'BROWSER_PROTOCOL', message: failure })
    }
  })

  it('rejects a spawn failure before any state exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tandem-spawn-'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(TandemBrowserRuntime, {
      command: process.execPath,
      args: [join(root, 'not-executable.js')],
      cwd: root,
      env: {},
      baseUrl: `http://127.0.0.1:${String(await freePort())}`,
      tokenFile: join(root, 'api-token'),
      idPrefix: 'tandem-test',
      startupTimeoutMs: 500,
      requestTimeoutMs: 300,
      healthPollMs: 10,
      reconnectAttempts: 0,
      reconnectDelayMs: 10,
      processGraceMs: 100,
      maxResponseBytes: 1024 * 1024,
    })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' })).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })
})

describe('Tandem Browser Runtime protocol fidelity', () => {
  it('rejects malformed session-create receipts', async () => {
    for (const [faults, failure] of [
      [{ create: 'no-tab' }, /session create tab response must be an object/],
      [{ create: 'bad-tab-id' }, /session create tab response field id/],
      [{ create: 'bad-title-type' }, /session create tab response field title must be a string/],
      [{ token: 'short' }, /at least 32 characters/],
    ] as const) {
      const { ctx, pidFile } = await setup({ ...faults })
      await expect(ctx.browserRuntime.create({ profile: 'temporary' }), JSON.stringify(faults))
        .rejects.toMatchObject({ code: 'BROWSER_PROTOCOL', message: failure })
      await assertJoined(pidFile)
    }
  })

  it('rejects an unreadable API token at the first authenticated request', async () => {
    const { ctx, tokenFile } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await rm(tokenFile)
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /API token is unavailable/ })
  })

  it('rejects malformed navigation and inventory responses', async () => {
    const cases: Array<[Record<string, string>, (ctx: Context, target: unknown) => Promise<unknown>, RegExp]> = [
      [{ navigate: 'non-json' }, (ctx, t) => ctx.browserRuntime.navigate({
        target: t as never, expectedRevision: 0, url: 'https://example.test/',
      }), /must be valid JSON/],
      [{ navigate: 'status-500' }, (ctx, t) => ctx.browserRuntime.navigate({
        target: t as never, expectedRevision: 0, url: 'https://example.test/',
      }), /HTTP 500 .*internal fixture failure/],
      [{ navigate: 'no-revision' }, (ctx, t) => ctx.browserRuntime.navigate({
        target: t as never, expectedRevision: 0, url: 'https://example.test/',
      }), /navigate response field revision must be a safe integer/],
      [{ input: 'ok-false' }, (ctx, t) => ctx.browserRuntime.input({
        target: t as never, expectedRevision: 0, text: 'x',
      }), /did not apply input/],
      [{ input: 'revision-conflict-non-json' }, (ctx, t) => ctx.browserRuntime.input({
        target: t as never, expectedRevision: 0, text: 'x',
      }), /HTTP 409 .*not-json/],
      [{ tabsList: 'not-array' }, (ctx, t) => ctx.browserRuntime.observe({ target: t as never }), /tabs must be an array/],
      [{ tabsList: 'bad-tab-shape' }, (ctx, t) => ctx.browserRuntime.observe({ target: t as never }), /tabs list tab response must be an object/],
      [{ pageContent: 'non-object' }, (ctx, t) => ctx.browserRuntime.observe({ target: t as never }), /page content response must be an object/],
      [{ pageContent: 'bad-title' }, (ctx, t) => ctx.browserRuntime.observe({ target: t as never }), /page content response field title/],
      [{ pageContent: 'bad-text' }, (ctx, t) => ctx.browserRuntime.observe({ target: t as never }), /page content response field text must be a string/],
      [{ screenshot: 'bad-type' }, (ctx, t) => ctx.browserRuntime.screenshot({ target: t as never }), /must be image\/png/],
      [{ screenshot: 'oversize-declared' }, (ctx, t) => ctx.browserRuntime.screenshot({ target: t as never }), /exceeds maxResponseBytes/],
      [{ screenshot: 'oversize-actual' }, (ctx, t) => ctx.browserRuntime.screenshot({ target: t as never }), /exceeds maxResponseBytes/],
      [{ focus: 'ok-false' }, (ctx, t) => ctx.browserRuntime.focus({ target: t as never, expectedRevision: 0 }), /did not focus the addressed tab/],
      [{ destroy: 'unknown' }, (ctx, t) => ctx.browserRuntime.close({ target: t as never, expectedRevision: 0 }), /HTTP 404 .*does not exist/],
      [{ destroy: 'ok-false' }, (ctx, t) => ctx.browserRuntime.close({ target: t as never, expectedRevision: 0 }), /did not destroy the session/],
      [{ destroy: '500' }, (ctx, t) => ctx.browserRuntime.close({ target: t as never, expectedRevision: 0 }), /HTTP 500/],
    ]
    for (const [faults, operate, failure] of cases) {
      const { ctx } = await setup(faults, faults.screenshot === 'oversize-actual' ? { maxResponseBytes: 1024 } : {})
      const created = await ctx.browserRuntime.create({ profile: 'temporary' })
      await expect(operate(ctx, created.target), JSON.stringify(faults))
        .rejects.toMatchObject({ code: 'BROWSER_PROTOCOL', message: failure })
    }
  })

  it('keeps a mutation when the follow-up page read dies and projects a crashed observe', async () => {
    const { ctx } = await setup({ pageContent: 'fail-after-first' })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const navigated = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })
    expect(navigated).toMatchObject({ status: 'open', revision: 1, url: 'https://example.test/' })
    await expect(ctx.browserRuntime.observe({ target: created.target }))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'crashed' })
  })

  it('surfaces an HTTP revision conflict and adopts the server revision on observe', async () => {
    const conflict = await setup({ input: 'revision-conflict' })
    const conflictCreated = await conflict.ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(conflict.ctx.browserRuntime.input({
      target: conflictCreated.target,
      expectedRevision: 0,
      text: 'x',
    })).rejects.toMatchObject({
      code: 'BROWSER_REVISION_CONFLICT',
      message: /observe again before mutating/,
    })

    const noMessage = await setup({ input: 'revision-conflict-no-message' })
    const noMessageCreated = await noMessage.ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(noMessage.ctx.browserRuntime.input({
      target: noMessageCreated.target,
      expectedRevision: 0,
      text: 'x',
    })).rejects.toMatchObject({
      code: 'BROWSER_REVISION_CONFLICT',
      message: /BROWSER_REVISION_CONFLICT/,
    })

    const omitted = await setup({ pageContent: 'omit-revision' })
    const omittedCreated = await omitted.ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(omitted.ctx.browserRuntime.observe({ target: omittedCreated.target }))
      .resolves.toMatchObject({ status: 'open', revision: 0 })

    const ahead = await setup({ pageContent: 'ahead-revision' })
    const created = await ahead.ctx.browserRuntime.create({ profile: 'temporary' })
    expect(created.revision).toBe(0)
    const observed = await ahead.ctx.browserRuntime.observe({ target: created.target })
    expect(observed).toMatchObject({ status: 'open', revision: 4 })
    const typed = await ahead.ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: 4,
      text: 'after-observe',
    })
    expect(typed).toMatchObject({ revision: 5, text: 'after-observe' })
  })

  it('bounds every HTTP request in time and reports caller aborts promptly', async () => {
    const timeoutHarness = await setup({ slow: 'navigate' }, { requestTimeoutMs: 200 })
    const timeoutCreated = await timeoutHarness.ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(timeoutHarness.ctx.browserRuntime.navigate({
      target: timeoutCreated.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /HTTP request failed/ })

    const abortHarness = await setup({ slow: 'navigate' }, { requestTimeoutMs: 5_000 })
    const abortCreated = await abortHarness.ctx.browserRuntime.create({ profile: 'temporary' })
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('cancelled mid-navigate')) }, 100)
    await expect(abortHarness.ctx.browserRuntime.navigate({
      target: abortCreated.target,
      expectedRevision: 0,
      url: 'https://example.test/',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
  })
})

describe('Tandem Browser Runtime failure projection', () => {
  it('recovers a mid-navigation crash onto the same DSH target without an orphan', async () => {
    const { ctx, pidFile } = await setup()
    const states: string[] = []
    ctx.on('browser/runtime-state', (state: { status: string; revision: number; reconnecting?: boolean }) => {
      states.push(`${state.status}:${String(state.revision)}:${'reconnecting' in state ? String(state.reconnecting) : '-'}`)
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://crash.test/',
    })

    const deadline = Date.now() + 5_000
    let recovered = await ctx.browserRuntime.observe({ target: created.target })
    while ((recovered.status !== 'open' || recovered.revision === 1) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      recovered = await ctx.browserRuntime.observe({ target: created.target })
    }

    expect(states).toContain('unavailable:2:true')
    expect(recovered).toMatchObject({
      status: 'open',
      target: created.target,
      revision: 0,
      url: 'https://crash.test/',
      title: 'Loaded page',
      text: 'Recovered crash page.',
    })
    await expect(ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: 1,
      text: 'stale',
    })).rejects.toMatchObject({ code: 'BROWSER_REVISION_CONFLICT' })
    const afterObserve = await ctx.browserRuntime.observe({ target: created.target })
    expect(afterObserve).toMatchObject({ status: 'open', revision: 0 })
    const resumed = await ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: afterObserve.revision,
      text: 'after-observe',
    })
    expect(resumed).toMatchObject({ revision: 1, text: 'after-observe' })
    const closed = await ctx.browserRuntime.close({ target: created.target, expectedRevision: resumed.revision })
    expect(closed).toEqual({ status: 'closed', target: created.target, revision: 2 })
    await assertJoined(pidFile)
  })

  it('projects a terminal crash when no reconnect attempts are configured', async () => {
    const { ctx } = await setup({}, { reconnectAttempts: 0 })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://crash.test/',
    })
    const deadline = Date.now() + 5_000
    let state = await ctx.browserRuntime.observe({ target: created.target })
    while (state.status === 'open' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await ctx.browserRuntime.observe({ target: created.target })
    }
    expect(state).toMatchObject({
      status: 'unavailable',
      reason: 'crashed',
      reconnecting: false,
      revision: 2,
    })
    const runtime = runtimeOf(ctx)
    runtime.recoveryScheduled = false
    expect(runtime.scheduleRecovery('crashed', false)).toMatchObject({ status: 'unavailable' })
  })

  it('projects an unhealthy page as unavailable and recovers the same target', async () => {
    const { ctx } = await setup()
    interface UnavailableProjection {
      status: string
      reason?: string | undefined
      revision?: number | undefined
      reconnecting?: boolean | undefined
    }
    const projections: UnavailableProjection[] = []
    ctx.on('browser/runtime-state', (state: { status: string; reason?: string; revision?: number; reconnecting?: boolean }) => {
      if (state.status === 'unavailable') {
        projections.push({ status: state.status, reason: state.reason, revision: state.revision, reconnecting: state.reconnecting })
      }
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://forget.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })

    const deadline = Date.now() + 5_000
    let state = await ctx.browserRuntime.observe({ target: created.target })
    while (state.status !== 'open' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await ctx.browserRuntime.observe({ target: created.target })
    }
    expect(state).toMatchObject({
      status: 'open',
      target: created.target,
      revision: 0,
      url: 'about:blank',
    })
    expect(projections).toContainEqual({ status: 'unavailable', reason: 'unhealthy', revision: 1, reconnecting: true })
  })

  it('stops a still-live child when an unhealthy page will not reconnect', async () => {
    const { ctx, pidFile } = await setup({}, { reconnectAttempts: 0 })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://forget.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })

    const deadline = Date.now() + 5_000
    let state = await ctx.browserRuntime.observe({ target: created.target })
    while (state.status === 'open' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await ctx.browserRuntime.observe({ target: created.target })
    }
    expect(state).toMatchObject({
      status: 'unavailable',
      reason: 'unhealthy',
      reconnecting: false,
      revision: 1,
    })
    await assertJoined(pidFile)
    expect(await ctx.browserRuntime.observe({ target: created.target })).toMatchObject({
      status: 'unavailable',
      reconnecting: false,
    })
  })

  it('reports exhausted reconnect attempts truthfully and still closes cleanly', async () => {
    const { ctx, pidFile } = await setup()
    const states: Array<{ status: string; reason?: string; reconnecting?: boolean }> = []
    ctx.on('browser/runtime-state', (state: { status: string; reason?: string; reconnecting?: boolean }) => {
      states.push({ status: state.status, ...'reason' in state ? { reason: state.reason } : {}, ...'reconnecting' in state ? { reconnecting: state.reconnecting } : {} })
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://die.test/',
    })

    const deadline = Date.now() + 5_000
    let state = await ctx.browserRuntime.observe({ target: created.target })
    while (!(state.status === 'unavailable' && !state.reconnecting) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await ctx.browserRuntime.observe({ target: created.target })
    }
    expect(state).toMatchObject({
      status: 'unavailable',
      reason: 'reconnect-failed',
      reconnecting: false,
      revision: 3,
    })
    expect(states).toContainEqual({ status: 'unavailable', reason: 'crashed', reconnecting: true })
    await expect(ctx.browserRuntime.focus({ target: created.target, expectedRevision: 3 }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
    const closed = await ctx.browserRuntime.close({ target: created.target, expectedRevision: 3 })
    expect(closed).toEqual({ status: 'closed', target: created.target, revision: 4 })
    await assertJoined(pidFile)
  })

})

describe('Tandem Browser Runtime teardown ownership', () => {
  it('drains, closes the temporary session, and joins the tree on disposal', async () => {
    const { ctx, pidFile } = await setup()
    await ctx.browserRuntime.create({ profile: 'temporary' })
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    await ctx.fiber.dispose()
    await assertJoined(pidFile)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('contains a failing session cleanup and still terminates the child', async () => {
    const { ctx, pidFile } = await setup({ destroy: '500' })
    await ctx.browserRuntime.create({ profile: 'temporary' })
    const warnings: unknown[][] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
    await ctx.fiber.dispose()
    expect(warnings.some(args => String(args[0]).includes('session cleanup failed'))).toBe(true)
    warn.mockRestore()
    await assertJoined(pidFile)
  })

  it('ignores stale, intentional, and terminal child-exit notifications', async () => {
    const { ctx } = await setup({}, { reconnectAttempts: 0 })
    const runtime = runtimeOf(ctx)
    const stale = { done: Promise.resolve({ exitCode: 0, signal: null }) }
    runtime.processExited(stale, 'stale handle')
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const live = runtime.process
    runtime.closing = true
    runtime.processExited({ done: Promise.resolve({ exitCode: 0, signal: null }) }, 'exit while closing')
    runtime.closing = false
    await ctx.browserRuntime.close({ target: created.target, expectedRevision: 0 })
    runtime.processExited({ done: Promise.resolve({ exitCode: 0, signal: null }) }, 'exit after close')
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toMatchObject({ status: 'closed' })
    expect(live).toBeDefined()
  })

  it('schedules unexpected-exit recovery on the live handle and logs a rejected reconnect', async () => {
    // Call the recovery methods on the test thread so Windows v8 attributes
    // them. Child `done` callbacks already reach the same methods on Linux
    // and are not measured on win32.
    async function waitForReconnectFailure(warnings: string[]): Promise<void> {
      const deadline = Date.now() + 3_000
      while (!warnings.some(message => message.includes('reconnect transaction failed')) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(warnings.some(message => message.includes('reconnect transaction failed'))).toBe(true)
    }

    const unexpected = await setup({}, { reconnectAttempts: 1, reconnectDelayMs: 10 })
    const unexpectedRuntime = runtimeOf(unexpected.ctx)
    await unexpected.ctx.browserRuntime.create({ profile: 'temporary' })
    const unexpectedWarnings: string[] = []
    const unexpectedWarn = vi.spyOn(unexpected.ctx.logger, 'warn').mockImplementation((message: unknown) => {
      unexpectedWarnings.push(String(message))
    })
    unexpectedRuntime.reconnect = async () => {
      throw new Error('forced reconnect failure')
    }
    const live = unexpectedRuntime.process
    expect(live).toBeDefined()
    unexpectedRuntime.processExited(live, 'forced unexpected exit')
    expect(unexpectedWarnings.some(message => message.includes('managed child exited unexpectedly (forced unexpected exit)'))).toBe(true)
    await waitForReconnectFailure(unexpectedWarnings)
    unexpectedWarn.mockRestore()

    const projected = await setup({}, { reconnectAttempts: 1, reconnectDelayMs: 10 })
    const projectedRuntime = runtimeOf(projected.ctx)
    await projected.ctx.browserRuntime.create({ profile: 'temporary' })
    const projectedWarnings: string[] = []
    const projectedWarn = vi.spyOn(projected.ctx.logger, 'warn').mockImplementation((message: unknown) => {
      projectedWarnings.push(String(message))
    })
    projectedRuntime.reconnect = async () => {
      throw new Error('forced reconnect failure')
    }
    expect(projectedRuntime.scheduleRecovery('unhealthy', true)).toMatchObject({
      status: 'unavailable',
      reason: 'unhealthy',
      reconnecting: true,
    })
    await waitForReconnectFailure(projectedWarnings)
    projectedWarn.mockRestore()
  })

  it('rethrows a non-protocol page-content failure during create', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const original = runtime.readTab.bind(runtime)
    runtime.readTab = async () => { throw new Error('raw create inventory failure') }
    // Force create to read content through page-content after session create by
    // replacing readContent via observe of the same private method.
    runtime.readTab = original
    const internals = runtime as RuntimeInternals & { readContent(tabId: string, signal: AbortSignal | undefined): Promise<unknown> }
    internals.readContent = async () => { throw new Error('raw create content failure') }
    await expect(ctx.browserRuntime.create({ profile: 'temporary' })).rejects.toThrow('raw create content failure')
  })

  it('rejects navigation when the upstream tab identity is already gone', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    runtime.profiles.clear()
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /no longer reports the addressed tab/ })
  })

  it('stops recovery work once disposal begins and ignores closed or already-scheduled recovery', async () => {
    const { ctx } = await setup({}, { reconnectAttempts: 1 })
    const runtime = runtimeOf(ctx)
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    runtime.closing = true
    await expect(runtime.reconnect(created as never, undefined as never)).resolves.toBeUndefined()
    const unavailable = {
      status: 'unavailable',
      target: created.target,
      revision: 1,
      reason: 'crashed' as const,
      reconnecting: false,
    }
    await expect(runtime.reconnect(created as never, unavailable as never)).resolves.toBeUndefined()
    const projected = runtime.scheduleRecovery('crashed', true)
    expect(projected).toMatchObject({ status: 'unavailable', revision: 1 })
    await new Promise(resolve => setTimeout(resolve, 50))
    runtime.closing = false

    const fresh = await setup()
    const freshRuntime = runtimeOf(fresh.ctx)
    const freshCreated = await fresh.ctx.browserRuntime.create({ profile: 'temporary' })
    freshRuntime.recoveryScheduled = true
    expect(freshRuntime.scheduleRecovery('crashed', false)).toMatchObject({ status: 'open' })
    freshRuntime.recoveryScheduled = false
    await fresh.ctx.browserRuntime.close({ target: freshCreated.target, expectedRevision: 0 })
    expect(freshRuntime.scheduleRecovery('crashed', false)).toMatchObject({ status: 'closed' })
    freshRuntime.closing = true
    expect(freshRuntime.scheduleRecovery('crashed', false)).toMatchObject({ status: 'closed' })
  })

  it('falls back to the addressed state when recovery cannot project', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    runtime.page = async () => {
      runtime.states.clear()
      throw new BrowserRuntimeError('unreachable', 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    runtime.scheduleRecovery = () => undefined
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(created)
  })

  it('rethrows non-runtime failures from observe without projecting recovery', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const original = runtime.readTab.bind(runtime)
    runtime.readTab = async () => { throw new Error('raw inventory failure') }
    await expect(ctx.browserRuntime.observe({ target: created.target })).rejects.toThrow('raw inventory failure')
    runtime.readTab = original
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toMatchObject({ status: 'open' })
  })

  it('reports a child spawn failure before any state exists', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const service = (runtime.ctx as Context & { subprocess: Record<string, unknown> }).subprocess as {
      spawn: (spec: unknown) => unknown
      resolveExecutable: (command: string, env: unknown, signal: unknown) => Promise<string>
    }
    const rejected = Promise.reject(new Error('spawn EACCES'))
    const failing = {
      done: rejected,
      terminate: () => {},
    }
    const realResolve = service.resolveExecutable.bind(service)
    const realSpawn = service.spawn.bind(service)
    service.resolveExecutable = async () => '/resolved/tandem'
    service.spawn = () => failing
    await expect(ctx.browserRuntime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /child exited before startup health/ })
    service.resolveExecutable = realResolve
    service.spawn = realSpawn
    rejected.catch(() => {})
    // The spawn-level rejection is contained at the join, so teardown still
    // reaches its terminal flag instead of dying on a secondary throw.
    await ctx.fiber.dispose()
    expect(runtime.disposed).toBe(true)
  })

  it('rejects a child the platform cannot execute', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tandem-spawn-denied-'))
    const denied = join(root, 'denounced.bin')
    await writeFile(denied, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(TandemBrowserRuntime, {
      command: denied,
      args: [],
      cwd: root,
      env: {},
      baseUrl: `http://127.0.0.1:${String(await freePort())}`,
      tokenFile: join(root, 'api-token'),
      idPrefix: 'tandem-test',
      startupTimeoutMs: 500,
      requestTimeoutMs: 300,
      healthPollMs: 10,
      reconnectAttempts: 0,
      reconnectDelayMs: 10,
      processGraceMs: 100,
      maxResponseBytes: 1024 * 1024,
    })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' })).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })
})
