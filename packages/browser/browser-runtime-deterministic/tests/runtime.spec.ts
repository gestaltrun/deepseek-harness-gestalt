import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  BrowserInstanceId,
  BrowserProfileId,
  BrowserProfileName,
  BrowserTabId,
  BrowserWorkspaceId,
} from '@deepseek-ai/dsh-browser-runtime'
import BrowserRuntimeDeterministic from '@deepseek-ai/dsh-browser-runtime-deterministic'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BrowserRuntimeInvariant from '../../browser-runtime/src/invariant.ts'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('deterministic Browser Runtime public lifecycle', () => {
  it('runs one temporary Profile and tab through create, navigate, observe, screenshot, focus, and close', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'trace',
      pages: [{
        url: 'https://example.test/',
        title: 'Example Domain',
        text: 'A deterministic browser page.',
        screenshotPngBase64: PNG_1X1,
      }],
    })

    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(created).toEqual({
      status: 'open',
      target: {
        profileId: 'trace-tmp-1',
        workspaceId: 'trace-tmp-1-workspace',
        browserId: 'trace-tmp-1-browser-1',
        tabId: 'trace-tmp-1-tab-1',
      },
      revision: 0,
      url: 'about:blank',
      title: 'New Tab',
      text: '',
      focused: false,
      chrome: {
        kind: 'temporary',
        partition: 'session-trace-tmp-1',
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
      text: 'A deterministic browser page.',
      focused: false,
    })
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(navigated)
    await expect(ctx.browserRuntime.screenshot({ target: created.target })).resolves.toEqual({
      target: created.target,
      revision: 1,
      url: 'https://example.test/',
      title: 'Example Domain',
      mediaType: 'image/png',
      data: PNG_1X1,
    })

    const focused = await ctx.browserRuntime.focus({
      target: created.target,
      expectedRevision: navigated.revision,
    })
    expect(focused).toMatchObject({ revision: 2, focused: true })

    await expect(ctx.browserRuntime.close({
      target: created.target,
      expectedRevision: focused.revision,
    })).resolves.toEqual({
      status: 'closed',
      target: created.target,
      revision: 3,
    })
  })

  it('serializes concurrent mutations and rejects the stale revision without changing committed state', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'serial',
      pages: [
        { url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 },
        { url: 'https://two.test/', title: 'Two', text: 'two', screenshotPngBase64: PNG_1X1 },
      ],
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const results = await Promise.allSettled([
      ctx.browserRuntime.navigate({ target: created.target, expectedRevision: 0, url: 'https://one.test/' }),
      ctx.browserRuntime.navigate({ target: created.target, expectedRevision: 0, url: 'https://two.test/' }),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({
      code: 'BROWSER_REVISION_CONFLICT',
    })
    const state = await ctx.browserRuntime.observe({ target: created.target })
    expect(state).toMatchObject({ status: 'open', revision: 1, url: 'https://one.test/' })
  })

  it('serializes synthetic input with navigation in both arrival orders', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'input-race',
      pages: [
        { url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 },
        { url: 'https://input.test/', title: 'Input', text: 'input', screenshotPngBase64: PNG_1X1 },
      ],
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const identities = created.target
    const inputFirst = await Promise.allSettled([
      ctx.browserRuntime.input({
        target: created.target,
        expectedRevision: created.revision,
        url: 'https://input.test/',
        text: 'synthetic input',
      }),
      ctx.browserRuntime.navigate({
        target: created.target,
        expectedRevision: created.revision,
        url: 'https://one.test/',
      }),
    ])
    expect(inputFirst.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const inputFirstRejected = inputFirst.find(result => result.status === 'rejected')
    expect(inputFirstRejected?.status === 'rejected' ? inputFirstRejected.reason : undefined).toMatchObject({
      code: 'BROWSER_REVISION_CONFLICT',
    })
    const afterInput = await ctx.browserRuntime.observe({ target: created.target })
    expect(afterInput).toMatchObject({
      status: 'open',
      revision: 1,
      url: 'https://input.test/',
      text: 'synthetic input',
      target: identities,
    })

    const navigateFirst = await Promise.allSettled([
      ctx.browserRuntime.navigate({
        target: created.target,
        expectedRevision: afterInput.revision,
        url: 'https://one.test/',
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
      url: 'https://one.test/',
      target: identities,
    })

    await expect(ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: afterNavigate.revision,
      url: 'https://unknown.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_UNKNOWN_URL' })
  })

  it('keeps blank-page title on text input and adopts configured facts on URL-only input', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'input-fields',
      pages: [{ url: 'https://input.test/', title: 'Input', text: 'page text', screenshotPngBase64: PNG_1X1 }],
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const typed = await ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: created.revision,
      text: 'typed',
    })
    expect(typed).toMatchObject({ title: 'New Tab', text: 'typed' })
    await expect(ctx.browserRuntime.input({
      target: created.target,
      expectedRevision: typed.revision,
      url: 'https://input.test/',
    })).resolves.toMatchObject({ title: 'Input', text: 'page text' })
  })

  it('restores a named Profile identity after close and isolates two Profiles on one origin', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'store',
      pages: [{ url: 'https://login.test/', title: 'Login', text: 'login', screenshotPngBase64: PNG_1X1 }],
    })
    const work = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    expect(work.chrome).toEqual({
      kind: 'persistent',
      name: 'work',
      partition: 'persist:session-store-work',
    })
    expect(work.target.profileId).toBe('store-profile-work')
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
    await ctx.browserRuntime.close({ target: work.target, expectedRevision: signedIn.revision })

    const personal = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('personal') })
    expect(personal.chrome).toEqual({
      kind: 'persistent',
      name: 'personal',
      partition: 'persist:session-store-personal',
    })
    expect(personal.target.profileId).not.toBe(work.target.profileId)
    const personalPage = await ctx.browserRuntime.navigate({
      target: personal.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    expect(personalPage.storage).toEqual({
      cookies: 'profile=personal',
      localStorage: 'personal',
      indexedDb: 'personal',
      cache: 'personal',
      serviceWorker: 'personal',
    })
    expect(personalPage.storage).not.toEqual(signedIn.storage)
    await ctx.browserRuntime.close({ target: personal.target, expectedRevision: personalPage.revision })

    const restored = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    expect(restored.target.profileId).toBe(work.target.profileId)
    expect(restored.chrome.partition).toBe(work.chrome.partition)
    expect(restored.url).toBe('https://login.test/')
    expect(restored.title).toBe('Login')
    expect(restored.text).toBe('login')
    expect(restored.storage).toEqual(signedIn.storage)
  })

  it('discards a temporary Profile identity and never labels it in address-field chrome', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'ephemeral',
      pages: [{ url: 'https://login.test/', title: 'Login', text: 'login', screenshotPngBase64: PNG_1X1 }],
    })
    const first = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(first.chrome).toEqual({
      kind: 'temporary',
      partition: 'session-ephemeral-tmp-1',
    })
    expect(first.chrome).not.toHaveProperty('name')
    await ctx.browserRuntime.navigate({
      target: first.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    await ctx.browserRuntime.close({ target: first.target, expectedRevision: 1 })

    const second = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(second.target.profileId).not.toBe(first.target.profileId)
    expect(second.chrome.partition).not.toBe(first.chrome.partition)
    expect(second.url).toBe('about:blank')
    expect(second.text).toBe('')
    expect(second.storage).toEqual({
      cookies: '',
      localStorage: '',
      indexedDb: '',
      cache: '',
      serviceWorker: '',
    })
    expect(second.chrome).not.toHaveProperty('name')
  })

  it('attaches a second tab to an open temporary Profile and rejects a missing attach', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'attach',
      pages: [{ url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 }],
    })
    const first = await ctx.browserRuntime.create({ profile: 'temporary' })
    const second = await ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })
    expect(second.target.profileId).toBe(first.target.profileId)
    expect(second.target.tabId).not.toBe(first.target.tabId)
    await expect(ctx.browserRuntime.create({
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: BrowserWorkspaceId('missing') },
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' })
  })

  it('attaches a second tab to an open named Profile without a second-writer rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'attach-named',
      pages: [{ url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 }],
    })
    const first = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    const second = await ctx.browserRuntime.create({
      profile: 'persistent',
      name: BrowserProfileName('work'),
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })
    expect(second.target.profileId).toBe(first.target.profileId)
    expect(second.target.tabId).not.toBe(first.target.tabId)
  })

  it('rejects a second writer of the same named Profile without corrupting stored identity', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'writer',
      pages: [{ url: 'https://login.test/', title: 'Login', text: 'login', screenshotPngBase64: PNG_1X1 }],
    })
    const first = await ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    await ctx.browserRuntime.navigate({
      target: first.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    await expect(ctx.browserRuntime.create({ profile: 'persistent', name: BrowserProfileName('work') }))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_BUSY' })
    const observed = await ctx.browserRuntime.observe({ target: first.target })
    expect(observed).toMatchObject({
      status: 'open',
      revision: 1,
      url: 'https://login.test/',
      text: 'login',
    })
  })

  it('reuses one shared Profile partition across two independent creates', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'shared',
      pages: [{ url: 'https://login.test/', title: 'Login', text: 'login', screenshotPngBase64: PNG_1X1 }],
    })
    const first = await ctx.browserRuntime.create({ profile: 'shared' })
    expect(first.chrome).toMatchObject({
      kind: 'shared',
      name: 'shared',
      partition: 'persist:session-shared-shared',
    })
    const navigated = await ctx.browserRuntime.navigate({
      target: first.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    const second = await ctx.browserRuntime.create({ profile: 'shared' })
    expect(second.target.profileId).toBe(first.target.profileId)
    expect(second.target.workspaceId).not.toBe(first.target.workspaceId)
    expect(second.chrome.partition).toBe(first.chrome.partition)
    expect(second.storage).toEqual(navigated.storage)
    expect(second.storage.cookies).toBe('profile=shared')
  })

  it('keeps a closed target closed after a later temporary Profile opens', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'capacity',
      pages: [{ url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 }],
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const closed = await ctx.browserRuntime.close({ target: created.target, expectedRevision: 0 })
    const later = await ctx.browserRuntime.create({ profile: 'temporary' })
    expect(later.target.profileId).not.toBe(created.target.profileId)
    await expect(ctx.browserRuntime.focus({ target: created.target, expectedRevision: closed.revision }))
      .rejects.toMatchObject({ code: 'BROWSER_NOT_OPEN' })
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(closed)
  })

  it('rejects malformed screenshot configuration at load', async () => {
    const empty = new Context()
    await expect(empty.plugin(BrowserRuntimeDeterministic, { pages: [] })).rejects.toThrow(/at least one page/)
    const duplicate = new Context()
    await expect(duplicate.plugin(BrowserRuntimeDeterministic, {
      pages: [
        { url: 'https://same.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 },
        { url: 'https://same.test/', title: 'Two', text: 'two', screenshotPngBase64: PNG_1X1 },
      ],
    })).rejects.toThrow(/duplicate page URL/)
    const malformed = new Context()
    await expect(malformed.plugin(BrowserRuntimeDeterministic, {
      pages: [{ url: 'https://bad.test/', title: 'Bad', text: 'bad', screenshotPngBase64: 'not base64!' }],
    })).rejects.toThrow(/canonical base64 data/)

    const nonCanonical = new Context()
    let nonCanonicalError: unknown
    try {
      await nonCanonical.plugin(BrowserRuntimeDeterministic, {
        pages: [{ url: 'https://short.test/', title: 'Short', text: 'short', screenshotPngBase64: 'A' }],
      })
    } catch (error) {
      nonCanonicalError = error
    }
    expect(nonCanonicalError).toBeInstanceOf(Error)
    if (!(nonCanonicalError instanceof Error)) throw new Error('expected screenshot validation to fail')
    expect(nonCanonicalError.message).toMatch(/canonical base64/)

    const nonCanonicalPaddingBits = new Context()
    await expect(nonCanonicalPaddingBits.plugin(BrowserRuntimeDeterministic, {
      pages: [{ url: 'https://padding.test/', title: 'Padding', text: 'padding', screenshotPngBase64: 'AB==' }],
    })).rejects.toThrow(/canonical base64/)

    const emptyScreenshot = new Context()
    await expect(emptyScreenshot.plugin(BrowserRuntimeDeterministic, {
      pages: [{ url: 'https://empty.test/', title: 'Empty', text: 'empty', screenshotPngBase64: '' }],
    })).rejects.toThrow()

    const wrongSignature = new Context()
    let wrongSignatureError: unknown
    try {
      await wrongSignature.plugin(BrowserRuntimeDeterministic, {
        pages: [{ url: 'https://text.test/', title: 'Text', text: 'text', screenshotPngBase64: 'SGVsbG8=' }],
      })
    } catch (error) {
      wrongSignatureError = error
    }
    expect(wrongSignatureError).toBeInstanceOf(Error)
    if (!(wrongSignatureError instanceof Error)) throw new Error('expected screenshot validation to fail')
    expect(wrongSignatureError.message).toMatch(/PNG data/)
  })

  it('closes the temporary Profile to quiescence and removes the service on Provider disposal', async () => {
    const ctx = new Context()
    const states: string[] = []
    ctx.on('browser/runtime-state', (state) => { states.push(`${state.status}:${String(state.revision)}`) })
    const fiber = await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'dispose',
      pages: [{ url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 }],
    })
    const runtime = ctx.browserRuntime
    await runtime.create({ profile: 'temporary' })
    await fiber.dispose()

    expect(states).toEqual(['open:0', 'closed:1'])
    expect(ctx.get('browserRuntime')).toBeUndefined()
    await expect(runtime.create({ profile: 'temporary' })).rejects.toMatchObject({ code: 'BROWSER_DISPOSED' })
  })

  it('drops named persist memory on disposal instead of leaving a half-open store', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'persist-dispose',
      pages: [{ url: 'https://login.test/', title: 'Login', text: 'login', screenshotPngBase64: PNG_1X1 }],
    })
    const runtime = ctx.browserRuntime
    const created = await runtime.create({ profile: 'persistent', name: BrowserProfileName('work') })
    await runtime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://login.test/',
    })
    const internals = runtime as unknown as { persisted: Map<string, unknown> }
    expect(internals.persisted.size).toBe(0)
    await fiber.dispose()
    expect(internals.persisted.size).toBe(0)
    await expect(runtime.create({ profile: 'persistent', name: BrowserProfileName('work') }))
      .rejects.toMatchObject({ code: 'BROWSER_DISPOSED' })
  })

  it('rejects aborted, missing, closed, and unconfigured operations without changing state', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'failure',
      pages: [{ url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 }],
    })
    const missing = {
      profileId: BrowserProfileId('missing-profile'),
      workspaceId: BrowserWorkspaceId('missing-workspace'),
      browserId: BrowserInstanceId('missing-browser'),
      tabId: BrowserTabId('missing-tab'),
    }
    await expect(ctx.browserRuntime.observe({ target: missing })).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' })

    const aborted = new AbortController()
    aborted.abort('cancelled')
    await expect(ctx.browserRuntime.create({ profile: 'temporary', signal: aborted.signal }))
      .rejects.toMatchObject({ code: 'BROWSER_ABORTED' })

    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    await expect(ctx.browserRuntime.observe({ target: missing })).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' })
    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://unknown.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_UNKNOWN_URL' })
    await expect(ctx.browserRuntime.screenshot({ target: created.target }))
      .rejects.toMatchObject({ code: 'BROWSER_UNKNOWN_URL' })

    const queuedAbort = new AbortController()
    const queued = ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: 0,
      url: 'https://one.test/',
      signal: queuedAbort.signal,
    })
    queuedAbort.abort('queued cancellation')
    await expect(queued).rejects.toMatchObject({ code: 'BROWSER_ABORTED' })

    const closed = await ctx.browserRuntime.close({ target: created.target, expectedRevision: 0 })
    await expect(ctx.browserRuntime.focus({ target: created.target, expectedRevision: closed.revision }))
      .rejects.toMatchObject({ code: 'BROWSER_NOT_OPEN' })
    await fiber.dispose()
  })

  it('contains post-commit observer failures without starving later observers', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntimeDeterministic, {
      pages: [{ url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 }],
    })
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const observed: number[] = []
    ctx.on('browser/runtime-state', () => { throw new Error('ordinary observer failed') })
    ctx.on('browser/runtime-state', (): unknown => Promise.reject(new Error('async observer failed')))
    ctx.on('browser/runtime-state', (state) => { observed.push(state.revision) })

    const navigated = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: 'https://one.test/',
    })
    expect(navigated.revision).toBe(1)
    expect(await ctx.browserRuntime.observe({ target: created.target })).toEqual(navigated)
    expect(observed).toEqual([1])
    await Promise.resolve()
  })

  it('registers and disposes the type-only Service Definition invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(BrowserRuntimeInvariant)
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})
