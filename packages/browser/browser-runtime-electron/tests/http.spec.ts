import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ElectronBrowserRuntime, { listenElectronBrowserHttp } from '@deepseek-ai/dsh-browser-runtime-electron'
import { installElectronTestHost } from '@deepseek-ai/dsh-browser-runtime-electron/testing'
import { BrowserProfileName, type BrowserTarget } from '@deepseek-ai/dsh-browser-runtime'
import { FakeElectronHost, PNG_1X1_BASE64 } from './fake-electron.ts'

const contexts: Context[] = []
const servers: Array<{ close(): Promise<void> }> = []
const temps: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  installElectronTestHost(undefined)
})

async function json(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`, init)
  return { status: response.status, body: await response.json() as unknown }
}

describe('Electron Browser HTTP protocol', () => {
  it('serves Tandem-shaped session, tab, content, screenshot, focus, and destroy operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-electron-http-'))
    temps.push(root)
    const tokenFile = join(root, 'api-token')
    const ctx = new Context()
    contexts.push(ctx)
    installElectronTestHost(new FakeElectronHost())
    await ctx.plugin(ElectronBrowserRuntime, {
      idPrefix: 'electron-http',
    })
    const server = await listenElectronBrowserHttp({
      runtime: ctx.browserRuntime,
      tokenFile,
      idPrefix: 'electron-http',
    })
    servers.push(server)
    const token = (await readFile(tokenFile, 'utf8')).trim()
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const version = await json(server.origin, '/agent/version')
    expect(version).toEqual({
      status: 200,
      body: {
        name: 'tandem-browser',
        version: '1.11.4',
        capabilityFamilies: ['tabs', 'sessions'],
        transports: ['http'],
      },
    })
    const unauthorized = await json(server.origin, '/sessions/create', { method: 'POST' })
    expect(unauthorized.status).toBe(401)

    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const created = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-tmp-1', url: 'about:blank' }),
    })
    expect(created.status).toBe(200)
    const createdBody = created.body as { tab: { id: string; url: string; title: string; partition: string } }
    expect(createdBody.tab).toMatchObject({
      url: 'about:blank',
      title: 'New Tab',
      partition: 'session-electron-http-tmp-1',
    })
    const tabId = createdBody.tab.id

    const status = await json(server.origin, '/status')
    expect(status).toMatchObject({ status: 200, body: { ready: true, version: '1.11.4' } })

    const navigated = await json(server.origin, '/navigate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.test/', tabId }),
    })
    expect(navigated).toMatchObject({ status: 200, body: { ok: true, url: 'https://example.test/' } })

    const listed = await json(server.origin, '/tabs/list', { headers: { authorization: `Bearer ${token}` } })
    expect(listed).toMatchObject({
      status: 200,
      body: { tabs: [{ id: tabId, url: 'https://example.test/', title: 'Example Domain' }] },
    })

    const content = await json(server.origin, '/page-content', {
      headers: { authorization: `Bearer ${token}`, 'x-tab-id': tabId },
    })
    expect(content).toMatchObject({
      status: 200,
      body: { url: 'https://example.test/', title: 'Example Domain', text: 'An Electron protocol page.' },
    })

    const shot = await fetch(`${server.origin}/screenshot`, {
      headers: { authorization: `Bearer ${token}`, 'x-tab-id': tabId },
    })
    expect(shot.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await shot.arrayBuffer()).toString('base64')).toBe(PNG_1X1_BASE64)

    const focused = await json(server.origin, '/tabs/focus', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId }),
    })
    expect(focused).toEqual({ status: 200, body: { ok: true, revision: 2 } })

    const missingName = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(missingName.status).toBe(400)
    const missingTab = await json(server.origin, '/navigate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.test/', tabId: 'missing' }),
    })
    expect(missingTab.status).toBe(404)
    const unknownRoute = await json(server.origin, '/nope', { headers: { authorization: `Bearer ${token}` } })
    expect(unknownRoute.status).toBe(404)
    const badJson = await fetch(`${server.origin}/sessions/create`, {
      method: 'POST',
      headers,
      body: '[]',
    })
    expect(badJson.status).toBe(400)

    const tracked = await ctx.browserRuntime.observe({
      target: {
        profileId: 'electron-http-tmp-1' as never,
        workspaceId: 'electron-http-tmp-1-workspace' as never,
        browserId: 'electron-http-tmp-1-browser-1' as never,
        tabId: 'electron-http-tmp-1-tab-1' as never,
      },
    })
    if (tracked.status === 'open') {
      await ctx.browserRuntime.close({ target: tracked.target, expectedRevision: tracked.revision })
    }
    const listedClosed = await json(server.origin, '/tabs/list', { headers: { authorization: `Bearer ${token}` } })
    expect(listedClosed.status).toBe(200)
    const closedContent = await json(server.origin, '/page-content', {
      headers: { authorization: `Bearer ${token}`, 'x-tab-id': tabId },
    })
    expect(closedContent.status).toBe(404)
    const named = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-work' }),
    })
    expect(named.status).toBe(200)
    const namedBody = named.body as { tab: { id: string; partition: string } }
    expect(namedBody.tab.partition).toBe('persist:session-electron-http-work')

    const destroyed = await json(server.origin, '/sessions/destroy', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-tmp-1' }),
    })
    expect(destroyed).toEqual({ status: 200, body: { ok: true, name: 'electron-http-tmp-1' } })
    const missingSession = await json(server.origin, '/sessions/destroy', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-tmp-1' }),
    })
    expect(missingSession.status).toBe(404)
    const missingContent = await json(server.origin, '/page-content', {
      headers: { authorization: `Bearer ${token}`, 'x-tab-id': 'missing' },
    })
    expect(missingContent.status).toBe(404)
    const missingShot = await fetch(`${server.origin}/screenshot`, {
      headers: { authorization: `Bearer ${token}`, 'x-tab-id': 'missing' },
    })
    expect(missingShot.status).toBe(404)
    const missingFocus = await json(server.origin, '/tabs/focus', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: 'missing' }),
    })
    expect(missingFocus.status).toBe(404)
    const emptyCreate = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: '',
    })
    expect(emptyCreate.status).toBe(400)
    const missingNavigateFields = await json(server.origin, '/navigate', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(missingNavigateFields.status).toBe(404)
    const missingHeaderContent = await json(server.origin, '/page-content', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(missingHeaderContent.status).toBe(404)
    const missingHeaderShot = await fetch(`${server.origin}/screenshot`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(missingHeaderShot.status).toBe(404)
    const missingFocusId = await json(server.origin, '/tabs/focus', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(missingFocusId.status).toBe(404)
    const missingDestroyName = await json(server.origin, '/sessions/destroy', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(missingDestroyName.status).toBe(404)
    const closedThenDestroy = await json(server.origin, '/sessions/destroy', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-work' }),
    })
    expect(closedThenDestroy.status).toBe(200)
    const statusEmpty = await json(server.origin, '/status')
    expect(statusEmpty).toMatchObject({ status: 200, body: { ready: true, url: 'about:blank', title: 'New Tab' } })
  })

  it('attaches a second tab by full session name and honors create url plus input revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-electron-http-attach-'))
    temps.push(root)
    const tokenFile = join(root, 'api-token')
    const ctx = new Context()
    contexts.push(ctx)
    installElectronTestHost(new FakeElectronHost())
    await ctx.plugin(ElectronBrowserRuntime, { idPrefix: 'electron-http' })
    const server = await listenElectronBrowserHttp({
      runtime: ctx.browserRuntime,
      tokenFile,
      idPrefix: 'electron-http',
    })
    servers.push(server)
    const token = (await readFile(tokenFile, 'utf8')).trim()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const first = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-gestalt-work-email', url: 'https://example.test/' }),
    })
    expect(first.status).toBe(200)
    const firstBody = first.body as { tab: { id: string; url: string; partition: string }; revision: number }
    expect(firstBody.tab).toMatchObject({
      url: 'https://example.test/',
      partition: 'persist:session-electron-http-gestalt-work-email',
    })
    const second = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-gestalt-work-email' }),
    })
    expect(second.status).toBe(200)
    const secondBody = second.body as { tab: { id: string } }
    expect(secondBody.tab.id).not.toBe(firstBody.tab.id)
    const listed = await json(server.origin, '/tabs/list', { headers: { authorization: `Bearer ${token}` } })
    expect(listed).toMatchObject({ status: 200, body: { tabs: [{ id: firstBody.tab.id }, { id: secondBody.tab.id }] } })
    const typed = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tabId: firstBody.tab.id,
        expectedRevision: firstBody.revision,
        text: 'typed-over-http',
      }),
    })
    expect(typed).toMatchObject({
      status: 200,
      body: { ok: true, text: 'An Electron protocol page.\nidentity=emailtyped-over-http', revision: firstBody.revision + 1 },
    })
    const typedBody = typed.body as { revision: number }
    const again = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tabId: firstBody.tab.id,
        expectedRevision: typedBody.revision,
        text: 'again',
      }),
    })
    expect(again).toMatchObject({
      status: 200,
      body: { ok: true, revision: typedBody.revision + 1 },
    })
    const urlOnly = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tabId: firstBody.tab.id,
        expectedRevision: typedBody.revision,
        url: 'https://example.test/',
      }),
    })
    expect(urlOnly.status).toBe(409)
    const missingRevision = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: firstBody.tab.id, text: 'x' }),
    })
    expect(missingRevision.status).toBe(400)
    const emptyInput = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tabId: firstBody.tab.id,
        expectedRevision: typedBody.revision + 1,
        url: '',
        text: '',
      }),
    })
    expect(emptyInput.status).toBe(400)
    const missingInputTab = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: 'missing', expectedRevision: 0, text: 'x' }),
    })
    expect(missingInputTab.status).toBe(404)
    const invalidName = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-tmp' }),
    })
    expect(invalidName.status).toBe(400)
  })

  it('covers default prefix, temporary attach, revision protocol, and mapped failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-electron-http-cover-'))
    temps.push(root)
    const tokenFile = join(root, 'api-token')
    const ctx = new Context()
    contexts.push(ctx)
    installElectronTestHost(new FakeElectronHost())
    await ctx.plugin(ElectronBrowserRuntime, { idPrefix: 'electron' })
    const server = await listenElectronBrowserHttp({
      runtime: ctx.browserRuntime,
      tokenFile,
    })
    servers.push(server)
    const token = (await readFile(tokenFile, 'utf8')).trim()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const opened = new Map<string, BrowserTarget>()
    ctx.on('browser/runtime-state', (state) => {
      if (state.status === 'open' && state.chrome.name !== undefined) opened.set(state.chrome.name, state.target)
    })
    const named = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'solo' }),
    })
    expect(named.status).toBe(200)
    expect((named.body as { tab: { partition: string } }).tab.partition).toBe('persist:session-electron-solo')
    const temp = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-tmp-1' }),
    })
    expect(temp.status).toBe(200)
    const tempAgain = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-tmp-1' }),
    })
    expect(tempAgain.status).toBe(200)
    expect((tempAgain.body as { tab: { id: string } }).tab.id)
      .not.toBe((temp.body as { tab: { id: string } }).tab.id)
    const shared = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-shared' }),
    })
    expect(shared.status).toBe(200)
    expect((shared.body as { partition: string }).partition).toBe('persist:session-electron-shared')
    const sharedAgain = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-shared' }),
    })
    expect(sharedAgain.status).toBe(200)
    expect((sharedAgain.body as { tab: { id: string } }).tab.id)
      .not.toBe((shared.body as { tab: { id: string } }).tab.id)
    expect((sharedAgain.body as { partition: string }).partition).toBe('persist:session-electron-shared')
    const tabId = (named.body as { tab: { id: string } }).tab.id
    const badRevision = await json(server.origin, '/navigate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId, url: 'https://example.test/', expectedRevision: 1.5 }),
    })
    expect(badRevision.status).toBe(400)
    const goodRevision = await json(server.origin, '/navigate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId, url: 'https://example.test/', expectedRevision: 0 }),
    })
    expect(goodRevision).toMatchObject({ status: 200, body: { ok: true, revision: 1 } })
    const staleInput = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tabId,
        expectedRevision: 0,
        url: 'https://example.test/',
        text: 'from-url',
      }),
    })
    expect(staleInput).toMatchObject({
      status: 409,
      body: { code: 'BROWSER_REVISION_CONFLICT' },
    })
    expect(String((staleInput.body as { error?: unknown }).error)).toMatch(/observe again before mutating/)
    const typed = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tabId,
        expectedRevision: 1,
        url: 'https://example.test/',
        text: 'from-url',
      }),
    })
    expect(typed).toMatchObject({ status: 200, body: { ok: true, revision: 2 } })
    expect(String((typed.body as { text?: unknown }).text)).toContain('from-url')
    const observed = await json(server.origin, '/page-content', {
      headers: { authorization: `Bearer ${token}`, 'x-tab-id': tabId },
    })
    expect(observed).toMatchObject({ status: 200, body: { revision: 2 } })
    const emptyInput = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId, expectedRevision: 2 }),
    })
    expect(emptyInput).toMatchObject({ status: 400, body: { code: 'BROWSER_PROTOCOL' } })
    const busy = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('held') })
    const busyHttp = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'held' }),
    })
    expect(busyHttp.status).toBe(409)
    await ctx.browserRuntime.close({ target: busy.target, expectedRevision: busy.revision })
    const soloTarget = opened.get('solo')
    if (soloTarget === undefined) throw new Error('expected solo target')
    const open = await ctx.browserRuntime.observe({ target: soloTarget })
    if (open.status === 'open') {
      await ctx.browserRuntime.close({ target: open.target, expectedRevision: open.revision })
    }
    const closedInput = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId, expectedRevision: 2, text: 'closed' }),
    })
    expect(closedInput.status).toBe(404)
    const originalCreate = ctx.browserRuntime.create.bind(ctx.browserRuntime)
    ctx.browserRuntime.create = async () => {
      throw new Error('raw listener failure')
    }
    const boom = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'boom-profile' }),
    })
    expect(boom.status).toBe(500)
    ctx.browserRuntime.create = originalCreate
    const missingTabType = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: 0, tabId: 7, text: 'x' }),
    })
    expect(missingTabType.status).toBe(404)
    const originalObserve = ctx.browserRuntime.observe.bind(ctx.browserRuntime)
    ctx.browserRuntime.observe = async () => {
      throw new (await import('@deepseek-ai/dsh-browser-runtime')).BrowserRuntimeError(
        'gone',
        'BROWSER_NOT_FOUND',
      )
    }
    const notFound = await json(server.origin, '/navigate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: (temp.body as { tab: { id: string } }).tab.id, url: 'https://example.test/' }),
    })
    expect(notFound.status).toBe(404)
    ctx.browserRuntime.observe = async () => {
      throw new (await import('@deepseek-ai/dsh-browser-runtime')).BrowserRuntimeError(
        'aborted',
        'BROWSER_ABORTED',
      )
    }
    const aborted = await json(server.origin, '/navigate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: (temp.body as { tab: { id: string } }).tab.id, url: 'https://example.test/' }),
    })
    expect(aborted.status).toBe(500)
    ctx.browserRuntime.observe = originalObserve
  })

  it('rejects a stale HTTP mutation after Electron recovery and resumes after observe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-electron-http-recover-'))
    temps.push(root)
    const tokenFile = join(root, 'api-token')
    const ctx = new Context()
    contexts.push(ctx)
    installElectronTestHost(new FakeElectronHost())
    await ctx.plugin(ElectronBrowserRuntime, { idPrefix: 'electron-http' })
    const server = await listenElectronBrowserHttp({
      runtime: ctx.browserRuntime,
      tokenFile,
      idPrefix: 'electron-http',
    })
    servers.push(server)
    const token = (await readFile(tokenFile, 'utf8')).trim()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    let target: BrowserTarget | undefined
    ctx.on('browser/runtime-state', (state) => {
      if (state.status === 'open') target = state.target
    })
    const created = await json(server.origin, '/sessions/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'electron-http-tmp-1' }),
    })
    expect(created.status).toBe(200)
    const tabId = (created.body as { tab: { id: string }; revision: number }).tab.id
    const createdRevision = (created.body as { revision: number }).revision
    if (target === undefined) throw new Error('expected created target')
    const runtime = ctx.browserRuntime as unknown as {
      profiles: Map<string, { tabs: Map<string, { window: { webContents: { emitCrash(): void } } }> }>
    }
    runtime.profiles.get(target.profileId)?.tabs.get(target.tabId)?.window.webContents.emitCrash()
    const deadline = Date.now() + 2_000
    let recovered = await ctx.browserRuntime.observe({ target })
    while (!(recovered.status === 'open' && recovered.revision > createdRevision) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      recovered = await ctx.browserRuntime.observe({ target })
    }
    expect(recovered.status).toBe('open')
    expect(recovered.revision).toBeGreaterThan(createdRevision)
    const stale = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId, expectedRevision: createdRevision, text: 'stale' }),
    })
    expect(stale).toMatchObject({
      status: 409,
      body: { code: 'BROWSER_REVISION_CONFLICT' },
    })
    const observed = await json(server.origin, '/page-content', {
      headers: { authorization: `Bearer ${token}`, 'x-tab-id': tabId },
    })
    expect(observed).toMatchObject({ status: 200, body: { revision: recovered.revision } })
    const resumed = await json(server.origin, '/input', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tabId,
        expectedRevision: (observed.body as { revision: number }).revision,
        text: 'after-observe',
      }),
    })
    expect(resumed).toMatchObject({
      status: 200,
      body: { ok: true, revision: recovered.revision + 1 },
    })
    expect(String((resumed.body as { text?: unknown }).text)).toContain('after-observe')
  })
})
