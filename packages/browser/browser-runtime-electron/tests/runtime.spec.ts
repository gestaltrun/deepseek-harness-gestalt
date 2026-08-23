import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ElectronBrowserRuntime, { isElectronProcess, requireElectronProcess } from '@deepseek-ai/dsh-browser-runtime-electron'
import { installElectronTestHost } from '@deepseek-ai/dsh-browser-runtime-electron/testing'
import { BrowserProfileName, BrowserWorkspaceId, browserTargetKey } from '@deepseek-ai/dsh-browser-runtime'
import { FakeElectronHost, PNG_1X1_BASE64 } from './fake-electron.ts'

const contexts: Context[] = []

interface RuntimeInternals {
  profiles: Map<string, { tabs: Map<string, { window: { destroy(): void } }> }>
  closing: boolean
  recovering: Set<string>
  disposed: boolean
  states: Map<string, unknown>
  page(state: never, signal: AbortSignal | undefined): Promise<unknown>
  scheduleRecovery(target: unknown, reason: 'crashed' | 'unhealthy', projectNow: boolean): unknown
  reconnect(lastOpen: never, unavailable: never): Promise<void>
  hostApis(): Promise<unknown>
  destroyExistingTab(profile: { tabs: Map<string, unknown> }, tabId: string): void
  commitReconnectFailed(target: unknown): void
}

function runtimeOf(ctx: Context): RuntimeInternals {
  return ctx.browserRuntime as unknown as RuntimeInternals
}

async function setup(
  options: ConstructorParameters<typeof FakeElectronHost>[0] = {},
  overrides: Record<string, unknown> = {},
): Promise<{ ctx: Context; host: FakeElectronHost }> {
  const host = new FakeElectronHost(options)
  installElectronTestHost(host)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ElectronBrowserRuntime, {
    idPrefix: 'electron-test',
    requestTimeoutMs: 200,
    ...overrides,
  })
  return { ctx, host }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  installElectronTestHost(undefined)
})

describe('Electron Browser Runtime configuration', () => {
  it('rejects invalid Config values at load', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['blank idPrefix', { idPrefix: ' \t' }, /idPrefix must be non-empty/],
      ['zero viewportWidth', { viewportWidth: 0 }, /viewportWidth/],
      ['fractional viewportHeight', { viewportHeight: 1.5 }, /viewportHeight/],
      ['zero requestTimeoutMs', { requestTimeoutMs: 0 }, /requestTimeoutMs/],
      ['oversized requestTimeoutMs', { requestTimeoutMs: 2_147_483_648 }, /requestTimeoutMs/],
    ]
    for (const [label, overrides, failure] of cases) {
      const ctx = new Context()
      contexts.push(ctx)
      installElectronTestHost(new FakeElectronHost())
      await expect(ctx.plugin(ElectronBrowserRuntime, overrides), label).rejects.toThrow(failure)
    }
  })

  it('clears the test host only when this installation is still current', async () => {
    const first = new FakeElectronHost()
    const second = new FakeElectronHost()
    const disposeFirst = installElectronTestHost(first)
    const disposeSecond = installElectronTestHost(second)
    disposeFirst()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ElectronBrowserRuntime, { idPrefix: 'electron-test' })
    await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(first.windows).toHaveLength(0)
    expect(second.windows).toHaveLength(1)
    disposeSecond()
  })

  it('fails loud when composed on Node without injected Electron APIs', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(ElectronBrowserRuntime, { idPrefix: 'node' }))
      .rejects.toThrow(/process.versions.electron must be set/)
    expect(isElectronProcess({} as NodeJS.ProcessVersions)).toBe(false)
    expect(isElectronProcess({ electron: '41.2.1' } as NodeJS.ProcessVersions)).toBe(true)
    expect(() => { requireElectronProcess({} as NodeJS.ProcessVersions) }).toThrow(/process.versions.electron must be set/)
  })
})

describe('Electron Browser Runtime public lifecycle', () => {
  it('presents one open page over a parent window and conceals only that page', async () => {
    const { ctx, host } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'temporary' })
    const second = await ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = ctx.browserRuntime as ElectronBrowserRuntime
    const parent = { id: 'main' }
    const bounds = { x: 10, y: 20, width: 640, height: 480 }
    runtime.present(first.target, bounds, parent)
    runtime.raisePresented()
    expect(host.windows[0]?.raiseCalls).toBe(1)
    expect(host.windows[0]?.shown).toBe(true)
    expect(host.windows[0]?.parent).toBe(parent)
    expect(host.windows[0]?.bounds).toEqual(bounds)
    runtime.present(first.target, { ...bounds, width: 641 }, parent)
    expect(host.windows[0]?.showInactiveCalls).toBe(1)
    runtime.present(second.target, { ...bounds, x: 11 }, parent)
    expect(host.windows[0]?.shown).toBe(false)
    expect(host.windows[0]?.parent).toBe(parent)
    expect(host.windows[1]?.shown).toBe(true)
    runtime.conceal(first.target)
    expect(host.windows[1]?.shown).toBe(true)
    runtime.conceal(second.target)
    runtime.raisePresented()
    expect(host.windows[1]?.raiseCalls).toBe(0)
    expect(host.windows[1]?.shown).toBe(false)
    runtime.present(first.target, bounds, parent)
    runtime.present(first.target, bounds, parent)
    expect(host.windows[0]?.shown).toBe(true)
    expect(host.windows[0]?.showInactiveCalls).toBe(2)
    expect(host.windows[0]?.webContents.focused).toBe(false)
    runtime.conceal(first.target)
    runtime.present({ ...first.target, tabId: 'missing' as typeof first.target.tabId }, bounds, parent)
    expect(host.windows[0]?.shown).toBe(false)
    runtime.present(second.target, bounds, parent)
    host.windows[1]!.destroyed = true
    runtime.conceal(second.target)
    expect(host.windows[1]?.shown).toBe(true)
    runtime.present(first.target, bounds, parent)
    await ctx.browserRuntime.close({ target: first.target, expectedRevision: first.revision })
    runtime.conceal(first.target)
    expect(host.windows[0]?.destroyed).toBe(true)
  })

  it('commits a navigation when Chromium aborts loadURL after a redirect', async () => {
    for (const abortLoadThenCommit of [true, 'errno', 'message'] as const) {
      const { ctx, host } = await setup({ abortLoadThenCommit })
      const created = await ctx.browserRuntime.create({ profile: 'temporary' })
      const navigated = await ctx.browserRuntime.navigate({
        target: created.target,
        expectedRevision: created.revision,
        url: 'https://www.google.com/search?q=dsh',
      })
      expect(navigated.url, String(abortLoadThenCommit)).toBe('https://www.google.com/search?q=dsh&sei=1')
      expect(host.windows[0]?.webContents.stopped).toBe(false)
      const handler = host.windows[0]?.webContents.windowOpenHandler
      expect(handler?.({ url: '' })).toEqual({ action: 'deny' })
      expect(handler?.({ url: 'https://example.test/' })).toEqual({ action: 'deny' })
    }
    const plain = await setup()
    const opened = await plain.ctx.browserRuntime.create({ profile: 'temporary' })
    expect(plain.host.windows[0]?.webContents.windowOpenHandler?.({ url: 'https://example.test/' }))
      .toEqual({ action: 'deny' })
    expect(opened.status).toBe('open')
  })

  it('commits a navigation when Chromium paints a net-error document', async () => {
    const closed = await setup({ failLoad: 'net' })
    const created = await closed.ctx.browserRuntime.create({ profile: 'temporary' })
    const navigated = await closed.ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://www.biadu.com/',
    })
    expect(navigated).toMatchObject({
      status: 'open',
      url: 'https://www.biadu.com/',
      revision: created.revision + 1,
    })

    const interstitial = await setup({ failLoad: 'net-chrome-error' })
    const blank = await interstitial.ctx.browserRuntime.create({ profile: 'temporary' })
    const failed = await interstitial.ctx.browserRuntime.navigate({
      target: blank.target,
      expectedRevision: blank.revision,
      url: 'https://missing.example/',
    })
    expect(failed.url).toBe('https://missing.example/')
    expect(failed.status).toBe('open')
  })

  it('rejects a navigation whose loadURL throws a non-object', async () => {
    const { ctx } = await setup({ failLoad: 'primitive' })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
  })

  it('rejects a navigation whose loadURL throws null', async () => {
    const { ctx } = await setup({ failLoad: 'null' })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
  })

  it('runs one temporary Profile through create, navigate, observe, screenshot, focus, and close', async () => {
    const { ctx, host } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(created).toMatchObject({
      status: 'open',
      target: {
        profileId: 'electron-test-tmp-1',
        workspaceId: 'electron-test-tmp-1-workspace',
        browserId: 'electron-test-tmp-1-browser-1',
        tabId: 'electron-test-tmp-1-tab-1',
      },
      revision: 0,
      url: 'about:blank',
      title: 'New Tab',
      focused: false,
      chrome: { kind: 'temporary', partition: 'session-electron-test-tmp-1' },
    })
    expect(created.chrome).not.toHaveProperty('name')
    expect(host.sessions.has('session-electron-test-tmp-1')).toBe(true)

    const navigated = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://example.test/',
    })
    expect(navigated).toMatchObject({
      revision: 1,
      url: 'https://example.test/',
      title: 'Example Domain',
      text: 'An Electron protocol page.',
    })
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(navigated)
    await expect(ctx.browserRuntime.screenshot({ target: created.target })).resolves.toMatchObject({
      target: created.target,
      revision: 1,
      url: 'https://example.test/',
      title: 'Example Domain',
      mediaType: 'image/png',
      data: PNG_1X1_BASE64,
    })
    const focused = await ctx.browserRuntime.focus({ target: created.target, expectedRevision: 1 })
    expect(focused).toMatchObject({ revision: 2, focused: true })
    const closed = await ctx.browserRuntime.close({ target: created.target, expectedRevision: 2 })
    expect(closed).toEqual({ status: 'closed', target: created.target, revision: 3 })
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(closed)
    expect(host.sessions.get('session-electron-test-tmp-1')?.cleared).toBe(1)
    expect(host.windows.every(window => window.destroyed)).toBe(true)
  })

  it('retries one hidden-page compositor bootstrap miss after an animation frame', async () => {
    const { ctx, host } = await setup({ captureFailures: 1 })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })

    await expect(ctx.browserRuntime.screenshot({ target: created.target })).resolves.toMatchObject({
      mediaType: 'image/png',
      data: PNG_1X1_BASE64,
    })
    expect(host.windows[0]?.webContents.captureAttempts).toBe(2)
  })

  it('does not retry a non-compositor screenshot failure', async () => {
    const { ctx, host } = await setup({ captureFailures: 1, captureFailureMessage: 'capture failed' })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })

    await expect(ctx.browserRuntime.screenshot({ target: created.target }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE', message: /capture failed/ })
    expect(host.windows[0]?.webContents.captureAttempts).toBe(1)
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
      text: 'An Electron protocol page.synthetic input',
      target: identities,
    })
    const afterInput = await ctx.browserRuntime.observe({ target: created.target })
    expect(afterInput).toMatchObject({ revision: 1, target: identities })

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
    const afterNavigate = await ctx.browserRuntime.observe({ target: created.target })
    expect(afterNavigate).toMatchObject({ revision: 2, url: 'https://login.test/', target: identities })
    await expect(ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: afterNavigate.revision,
      url: 'https://example.test/',
    })).resolves.toMatchObject({ revision: 3, url: 'https://example.test/' })
  })

  it('types through one path and treats newline as U+000A', async () => {
    const keys = await setup()
    const created = await keys.ctx.browserRuntime.create({ profile: 'temporary' })
    const typed = await keys.ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: 0,
      text: 'ab\n👍',
    })
    const keyContents = keys.host.windows[0]?.webContents
    expect(keyContents?.inputEvents).toEqual(['a', 'b', '\n', '👍'])
    expect(typed.text).toBe('ab\n👍')

    const focused = await setup({ focusedEditable: true })
    const page = await focused.ctx.browserRuntime.create({ profile: 'temporary' })
    const inserted = await focused.ctx.browserRuntime.input({
      target: page.target,
      expectedRevision: 0,
      text: 'line\n👍',
    })
    expect(focused.host.windows[0]?.webContents.inputEvents).toEqual([])
    expect(inserted.text).toBe('line\n👍')
  })

  it('restores a named Electron Profile through a stable persist partition and isolates two identities', async () => {
    const { ctx, host } = await setup()
    const work = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    expect(work.chrome).toEqual({
      kind: 'persistent',
      name: 'work',
      partition: 'persist:session-electron-test-work',
    })
    const signedIn = await ctx.browserRuntime.navigate({
      target: work.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    expect(signedIn.storage).toEqual({
      cookies: '',
      localStorage: '',
      indexedDb: '',
      cache: '',
      serviceWorker: '',
    })
    expect(signedIn.text).toContain('identity=work')
    await ctx.browserRuntime.close({ target: work.target, expectedRevision: signedIn.revision })
    expect(host.sessions.get('persist:session-electron-test-work')?.flushed).toBe(1)
    expect(host.sessions.get('persist:session-electron-test-work')?.cleared).toBe(0)

    const personal = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('personal') })
    expect(personal.chrome.partition).toBe('persist:session-electron-test-personal')
    const personalPage = await ctx.browserRuntime.navigate({
      target: personal.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    expect(personalPage.storage).toEqual(signedIn.storage)
    expect(personalPage.text).toContain('identity=personal')
    expect(personalPage.chrome.partition).not.toBe(signedIn.chrome.partition)
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
  })

  it('attaches a second Electron tab to an open temporary Profile', async () => {
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
    await ctx.browserRuntime.close({ target: second.target, expectedRevision: 0 })
    await ctx.browserRuntime.close({ target: first.target, expectedRevision: 0 })
  })

  it('discards a temporary Electron Profile identity and never labels it', async () => {
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
  })

  it('rejects a second writer of the same named Electron Profile', async () => {
    const { ctx } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    await expect(ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') }))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_BUSY' })
    await expect(ctx.browserRuntime.observe({ target: first.target })).resolves.toMatchObject({
      status: 'open',
      chrome: { name: 'work' },
    })
  })

  it('reuses one shared Electron Profile without a second-writer rejection', async () => {
    const { ctx } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'shared' })
    const second = await ctx.browserRuntime.create({ profile: 'shared' })
    expect(first.chrome).toMatchObject({
      kind: 'shared',
      partition: 'persist:session-electron-test-shared',
    })
    expect(second.target.profileId).toBe(first.target.profileId)
    expect(second.target.workspaceId).not.toBe(first.target.workspaceId)
    expect(second.chrome.partition).toBe(first.chrome.partition)
    await ctx.browserRuntime.close({ target: second.target, expectedRevision: 0 })
    await ctx.browserRuntime.close({ target: first.target, expectedRevision: 0 })
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

  it('aborts a pending screenshot and input load', async () => {
    const { ctx } = await setup({ loadDelayMs: 400, captureDelayMs: 400 }, { requestTimeoutMs: 5_000 })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('cancelled mid-shot')) }, 20)
    await expect(ctx.browserRuntime.screenshot({ target: created.target, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    const inputAbort = new AbortController()
    setTimeout(() => { inputAbort.abort(new Error('cancelled mid-input')) }, 20)
    await expect(ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
      signal: inputAbort.signal,
    })).rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
  })

  it('rejects already-aborted work before touching Electron windows', async () => {
    const { ctx, host } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before entry'))
    const target = { profileId: 'p' as never, workspaceId: 'w' as never, browserId: 'b' as never, tabId: 't' as never }
    await expect(ctx.browserRuntime.create({ profile: 'temporary', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    expect(host.windows).toHaveLength(0)
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

describe('Electron Browser Runtime protocol and recovery', () => {
  it('aborts a pending navigation', async () => {
    const { ctx } = await setup({ loadDelayMs: 400 }, { requestTimeoutMs: 5_000 })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('cancelled mid-navigate')) }, 20)
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
    const window = runtimeOf(ctx).profiles.get(created.target.profileId)?.tabs.get(created.target.tabId)?.window as
      { webContents: { stopped: boolean } } | undefined
    expect(window?.webContents.stopped).toBe(true)
  })

  it('bounds a hung Chromium operation', async () => {
    const { ctx } = await setup({ loadDelayMs: 400 }, { requestTimeoutMs: 50 })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
  })

  it('rejects a non-PNG screenshot and a non-string page text', async () => {
    const empty = await setup({ captureEmpty: true })
    const created = await empty.ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(empty.ctx.browserRuntime.screenshot({ target: created.target }))
      .rejects.toMatchObject({ code: 'BROWSER_PROTOCOL', message: /must be image\/png/ })
    const typed = await setup({ executeNonString: true })
    await expect(typed.ctx.browserRuntime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_PROTOCOL', message: /page text must be a string/ })
  })

  it('stops a raced load only while the hidden window still exists', async () => {
    const { ctx, host } = await setup({ loadDelayMs: 400 }, { requestTimeoutMs: 5_000 })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const controller = new AbortController()
    setTimeout(() => {
      host.windows[0]?.destroy()
      controller.abort(new Error('cancelled after destroy'))
    }, 20)
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'BROWSER_ABORTED' })
  })

  it('recovers one crashed tab without moving a sibling', async () => {
    const { ctx } = await setup()
    const first = await ctx.browserRuntime.create({ profile: 'temporary' })
    const second = await ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: first.target.workspaceId },
    })
    await ctx.browserRuntime.navigate({
      target: first.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })
    const firstWindow = runtimeOf(ctx).profiles.get(first.target.profileId)?.tabs.get(first.target.tabId)?.window as
      { webContents: { emitCrash(): void } } | undefined
    firstWindow?.webContents.emitCrash()
    const deadline = Date.now() + 2_000
    let crashed = await ctx.browserRuntime.observe({ target: first.target })
    while (!(crashed.status === 'open' && crashed.revision >= 3) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      crashed = await ctx.browserRuntime.observe({ target: first.target })
    }
    expect(crashed).toMatchObject({ status: 'open', target: first.target, url: 'https://example.test/' })
    await expect(ctx.browserRuntime.observe({ target: second.target })).resolves.toMatchObject({
      status: 'open',
      revision: 0,
      target: second.target,
    })
  })

  it('projects a renderer crash as unavailable and recovers the same target', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })
    const window = (runtimeOf(ctx).profiles.get(created.target.profileId)?.tabs.get(created.target.tabId)?.window
      ?? undefined) as { webContents: { emitCrash(): void } } | undefined
    window?.webContents.emitCrash()
    const deadline = Date.now() + 2_000
    let state = await ctx.browserRuntime.observe({ target: created.target })
    while (!(state.status === 'open' && state.revision >= 3) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await ctx.browserRuntime.observe({ target: created.target })
    }
    expect(state).toMatchObject({
      status: 'open',
      target: created.target,
      url: 'https://example.test/',
    })
  })

  it('projects reconnect-failed when recovery cannot recreate the window', async () => {
    const { ctx } = await setup({ failLoad: true })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
    const recovered = await setup()
    const open = await recovered.ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = runtimeOf(recovered.ctx)
    const { BrowserRuntimeError } = await import('@deepseek-ai/dsh-browser-runtime')
    runtime.hostApis = async () => { throw new BrowserRuntimeError('no host', 'BROWSER_RUNTIME_UNAVAILABLE') }
    runtime.scheduleRecovery(open.target, 'crashed', true)
    const deadline = Date.now() + 2_000
    let state = await recovered.ctx.browserRuntime.observe({ target: open.target })
    while (!(state.status === 'unavailable' && state.reason === 'reconnect-failed') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await recovered.ctx.browserRuntime.observe({ target: open.target })
    }
    expect(state).toMatchObject({ status: 'unavailable', reason: 'reconnect-failed', reconnecting: false })
    expect(runtime.profiles.get(open.target.profileId)?.tabs.has(open.target.tabId)).toBeFalsy()
    const missing = await setup()
    const missingOpen = await missing.ctx.browserRuntime.create({ profile: 'temporary' })
    const missingRuntime = runtimeOf(missing.ctx)
    missingRuntime.hostApis = async () => {
      missingRuntime.profiles.clear()
      throw new Error('no profile left')
    }
    missingRuntime.scheduleRecovery(missingOpen.target, 'crashed', true)
    const missingDeadline = Date.now() + 2_000
    let missingState = await missing.ctx.browserRuntime.observe({ target: missingOpen.target })
    while (!(missingState.status === 'unavailable' && missingState.reason === 'reconnect-failed') && Date.now() < missingDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      missingState = await missing.ctx.browserRuntime.observe({ target: missingOpen.target })
    }
    expect(missingState).toMatchObject({ status: 'unavailable', reason: 'reconnect-failed' })
    const kept = await setup()
    const keptFirst = await kept.ctx.browserRuntime.create({ profile: 'temporary' })
    const keptSecond = await kept.ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: keptFirst.target.workspaceId },
    })
    const keptRuntime = runtimeOf(kept.ctx)
    keptRuntime.hostApis = async () => { throw new Error('sibling reconnect failed') }
    keptRuntime.scheduleRecovery(keptFirst.target, 'crashed', true)
    const keptDeadline = Date.now() + 2_000
    let keptState = await kept.ctx.browserRuntime.observe({ target: keptFirst.target })
    while (!(keptState.status === 'unavailable' && keptState.reason === 'reconnect-failed') && Date.now() < keptDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      keptState = await kept.ctx.browserRuntime.observe({ target: keptFirst.target })
    }
    expect(keptRuntime.profiles.get(keptSecond.target.profileId)?.tabs.has(keptSecond.target.tabId)).toBe(true)
  })

  it('reports an unhealthy observe as unavailable and recovers', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = runtimeOf(ctx)
    const { BrowserRuntimeError } = await import('@deepseek-ai/dsh-browser-runtime')
    let failOnce = true
    const originalPage = runtime.page.bind(runtime)
    runtime.page = async (state, signal) => {
      if (failOnce) {
        failOnce = false
        throw new BrowserRuntimeError('Electron no longer reports the addressed tab', 'BROWSER_RUNTIME_UNAVAILABLE')
      }
      return originalPage(state, signal)
    }
    const projected = await ctx.browserRuntime.observe({ target: created.target })
    expect(projected).toMatchObject({ status: 'unavailable', reason: 'unhealthy' })
    const deadline = Date.now() + 2_000
    let state = projected
    while (state.status !== 'open' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await ctx.browserRuntime.observe({ target: created.target })
    }
    expect(state).toMatchObject({ status: 'open', target: created.target })
  })

  it('rejects navigation when the hidden window is already gone', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    runtimeOf(ctx).profiles.clear()
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://example.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
  })

  it('contains failing partition cleanup and still disposes', async () => {
    const { ctx } = await setup({ failFlush: true, failClear: true })
    const runtime = ctx.browserRuntime
    await runtime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    const warnings: unknown[][] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
    await ctx.fiber.dispose()
    expect(warnings.some(args => String(args[0]).includes('partition cleanup failed'))).toBe(true)
    warn.mockRestore()
    await expect(runtime.create({ profile: 'temporary' })).rejects.toMatchObject({ code: 'BROWSER_DISPOSED' })
  })

  it('stops recovery work once disposal begins', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    runtime.closing = true
    await expect(runtime.reconnect(created as never, undefined as never)).resolves.toBeUndefined()
    runtime.scheduleRecovery(created.target, 'crashed', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    runtime.recovering.add(browserTargetKey(created.target))
    expect(runtime.scheduleRecovery(created.target, 'crashed', false)).toMatchObject({
      target: created.target,
    })
    runtime.recovering.clear()
    runtime.closing = false
    const current = await ctx.browserRuntime.observe({ target: created.target })
    if (current.status !== 'closed') {
      await ctx.browserRuntime.close({ target: created.target, expectedRevision: current.revision })
    }
    expect(runtime.scheduleRecovery(created.target, 'crashed', false)).toMatchObject({ status: 'closed' })
    runtime.states.clear()
    expect(runtime.scheduleRecovery(created.target, 'crashed', false)).toBeUndefined()
    runtime.states.set('gone', { status: 'unavailable', target: created.target, revision: 1, reason: 'crashed', reconnecting: false })
    expect(runtime.scheduleRecovery(created.target, 'crashed', false)).toMatchObject({ status: 'unavailable' })
    const sibling = await setup()
    const first = await sibling.ctx.browserRuntime.create({ profile: 'temporary' })
    const second = await sibling.ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: first.target.workspaceId },
    })
    const siblingRuntime = runtimeOf(sibling.ctx)
    siblingRuntime.recovering.add(browserTargetKey(first.target))
    siblingRuntime.states.delete(browserTargetKey(first.target))
    expect(siblingRuntime.scheduleRecovery(first.target, 'crashed', false)).toMatchObject({
      status: 'open',
      target: second.target,
    })
  })

  it('destroys leftover windows on teardown even when already closed', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = runtimeOf(ctx)
    const tab = runtime.profiles.get(created.target.profileId)?.tabs.get(created.target.tabId)
    tab?.window.destroy()
    runtime.profiles.get(created.target.profileId)?.tabs.delete(created.target.tabId)
    await expect(ctx.browserRuntime.close({ target: created.target, expectedRevision: 0 }))
      .resolves.toMatchObject({ status: 'closed' })
    await ctx.fiber.dispose()
    expect(runtime.disposed).toBe(true)
  })

  it('rethrows non-runtime failures from observe without projecting recovery', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    runtime.page = async () => { throw new Error('raw inventory failure') }
    await expect(ctx.browserRuntime.observe({ target: created.target })).rejects.toThrow('raw inventory failure')
  })

  it('rejects mutations while the runtime is unavailable', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = runtimeOf(ctx)
    const hold = new Promise<void>((resolve) => {
      runtime.reconnect = async () => {
        resolve()
        await new Promise(wait => setTimeout(wait, 50))
      }
    })
    runtime.scheduleRecovery(created.target, 'crashed', true)
    await hold
    await expect(ctx.browserRuntime.focus({
      target: created.target,
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
  })

  it('rejects a destroyed hidden window as unavailable', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const tab = runtimeOf(ctx).profiles.get(created.target.profileId)?.tabs.get(created.target.tabId)
    tab?.window.destroy()
    await expect(ctx.browserRuntime.screenshot({ target: created.target }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
  })

  it('logs a rejected reconnect transaction', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = runtimeOf(ctx)
    const warnings: unknown[][] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
    runtime.reconnect = async () => { throw new Error('forced reconnect rejection') }
    runtime.scheduleRecovery(created.target, 'crashed', true)
    await (runtime as unknown as { queue: Promise<void> }).queue
    expect(warnings.some(args => String(args[0]).includes('reconnect transaction failed'))).toBe(true)
    warn.mockRestore()
  })

  it('covers attach-create failure without dropping the existing Profile', async () => {
    const { ctx } = await setup({ failLoad: true })
    await expect(ctx.browserRuntime.create({ profile: 'temporary' }))
      .rejects.toMatchObject({ code: 'BROWSER_RUNTIME_UNAVAILABLE' })
    const healthy = await setup()
    const first = await healthy.ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = runtimeOf(healthy.ctx)
    const originalLoad = (runtime as unknown as {
      load(window: unknown, url: string, signal: AbortSignal | undefined): Promise<void>
    }).load.bind(runtime)
    let failNext = false
    ;(runtime as unknown as {
      load(window: unknown, url: string, signal: AbortSignal | undefined): Promise<void>
    }).load = async (window, url, signal) => {
      if (failNext) throw new Error('attach load failed')
      return originalLoad(window, url, signal)
    }
    failNext = true
    await expect(healthy.ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })).rejects.toThrow('attach load failed')
    failNext = false
    await expect(healthy.ctx.browserRuntime.observe({ target: first.target })).resolves.toMatchObject({ status: 'open' })
  })

  it('projects recovery later when projectNow is false', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const projected = runtimeOf(ctx).scheduleRecovery(created.target, 'unhealthy', false)
    expect(projected).toBeUndefined()
    const deadline = Date.now() + 2_000
    let state = await ctx.browserRuntime.observe({ target: created.target })
    while (!(state.status === 'open' && state.revision > created.revision) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      state = await ctx.browserRuntime.observe({ target: created.target })
    }
    expect(state).toMatchObject({ status: 'open', target: created.target })
    expect(state.revision).toBeGreaterThan(created.revision)
  })

  it('covers missing-tab destroy and reconnect-failed skip helpers', async () => {
    const { ctx } = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const runtime = runtimeOf(ctx)
    const profile = runtime.profiles.get(created.target.profileId)
    if (profile === undefined) throw new Error('expected open profile')
    runtime.destroyExistingTab(profile, 'missing-tab')
    runtime.commitReconnectFailed(created.target)
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toMatchObject({ status: 'open' })
  })

  it('falls back to the addressed state when recovery cannot project', async () => {
    const { ctx } = await setup()
    const runtime = runtimeOf(ctx)
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const { BrowserRuntimeError } = await import('@deepseek-ai/dsh-browser-runtime')
    runtime.page = async () => {
      runtime.states.clear()
      throw new BrowserRuntimeError('unreachable', 'BROWSER_RUNTIME_UNAVAILABLE')
    }
    runtime.scheduleRecovery = () => undefined
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(created)
  })
})
