import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserWorkspaceBinder from '@deepseek-ai/dsh-browser-workspace'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import BrowserRuntimeDeterministic from '@deepseek-ai/dsh-browser-runtime-deterministic'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'
import * as ToolBrowserInvariant from '../src/invariant.ts'

const signal = new AbortController().signal
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536, maxResults: 10 } })
  await ctx.plugin(BrowserRuntimeDeterministic, {
    idPrefix: 'tool',
    pages: [{
      url: 'https://example.test/',
      title: 'Example Domain',
      text: 'A deterministic browser page.',
      screenshotPngBase64: PNG_1X1,
    }],
  })
  await ctx.plugin(ToolBrowser)
  return ctx
}

describe('deferred Browser Runtime Consumer', () => {
  it('keeps an eligible deferred tool executable before discovery', async () => {
    const ctx = await harness()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['tool_search'])
    await expect(ctx.tools.execute({
      callId: CallId('guessed-browser-create'),
      name: 'browser_create',
      arguments: {},
      signal,
    })).resolves.toMatchObject({ isError: false, value: { revision: 0 } })
  })

  it('discovers all browser schemas without activating tools and logs complete canonical facts', async () => {
    const ctx = await harness()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['tool_search'])
    expect(ctx.tools.catalogSchemas().map(schema => schema.name)).toEqual([
      'browser_create',
      'browser_navigate',
      'browser_observe',
      'browser_screenshot',
      'browser_focus',
      'browser_input',
      'browser_close',
    ])

    const discovery = await ctx.tools.execute({
      callId: CallId('search-browser'),
      name: 'tool_search',
      arguments: { query: 'browser', limit: 7 },
      signal,
    })
    expect(discovery.isError).toBe(false)
    if (discovery.isError) throw new Error('expected browser tool discovery to succeed')
    expect(discovery.loadedTools?.map(schema => schema.name).sort()).toEqual([
      'browser_close',
      'browser_create',
      'browser_focus',
      'browser_input',
      'browser_navigate',
      'browser_observe',
      'browser_screenshot',
    ])
    for (const name of discovery.loadedTools?.map(schema => schema.name) ?? []) {
      expect(ctx.tools.get(name)).not.toHaveProperty('presentCall')
      expect(ctx.tools.get(name)).not.toHaveProperty('presentResult')
    }

    const created = await ctx.tools.execute({
      callId: CallId('browser-create'),
      name: 'browser_create',
      arguments: { profile: 'temporary' },
      signal,
    })
    expect(created).toMatchObject({
      isError: false,
      value: {
        status: 'open',
        target: {
          profileId: 'tool-tmp-1',
          workspaceId: 'tool-tmp-1-workspace',
          browserId: 'tool-tmp-1-browser-1',
          tabId: 'tool-tmp-1-tab-1',
        },
        chrome: { kind: 'temporary', partition: 'session-tool-tmp-1' },
        revision: 0,
      },
    })
    expect(created.content).toEqual([{
      type: 'text',
      text: JSON.stringify(created.isError ? null : created.value, null, 2),
    }])

    const target = {
      profileId: 'tool-tmp-1',
      workspaceId: 'tool-tmp-1-workspace',
      browserId: 'tool-tmp-1-browser-1',
      tabId: 'tool-tmp-1-tab-1',
    }
    const navigated = await ctx.tools.execute({
      callId: CallId('browser-navigate'),
      name: 'browser_navigate',
      arguments: { target, expectedRevision: 0, url: 'https://example.test/' },
      signal,
    })
    expect(navigated).toMatchObject({ isError: false, value: { revision: 1, title: 'Example Domain' } })

    const observed = await ctx.tools.execute({
      callId: CallId('browser-observe'),
      name: 'browser_observe',
      arguments: { target },
      signal,
    })
    expect(observed).toMatchObject({ isError: false, value: { revision: 1 } })

    const screenshot = await ctx.tools.execute({
      callId: CallId('browser-screenshot'),
      name: 'browser_screenshot',
      arguments: { target },
      signal,
    })
    expect(screenshot).toMatchObject({ isError: false, value: { mediaType: 'image/png', data: PNG_1X1 } })

    const focused = await ctx.tools.execute({
      callId: CallId('browser-focus'),
      name: 'browser_focus',
      arguments: { target, expectedRevision: 1 },
      signal,
    })
    expect(focused).toMatchObject({ isError: false, value: { revision: 2, focused: true } })

    const inputted = await ctx.tools.execute({
      callId: CallId('browser-input'),
      name: 'browser_input',
      arguments: { target, expectedRevision: 2, text: 'Agent input' },
      signal,
    })
    expect(inputted).toMatchObject({ isError: false, value: { revision: 3, text: 'Agent input' } })

    const stale = await ctx.tools.execute({
      callId: CallId('browser-stale-navigate'),
      name: 'browser_navigate',
      arguments: { target, expectedRevision: 2, url: 'https://example.test/' },
      signal,
    })
    expect(stale).toMatchObject({ isError: true })

    const closed = await ctx.tools.execute({
      callId: CallId('browser-close'),
      name: 'browser_close',
      arguments: { target, expectedRevision: 3 },
      signal,
    })
    expect(closed).toMatchObject({ isError: false, value: { status: 'closed', revision: 4 } })
  })

  it('defaults omitted profile to the shared installation-wide identity', async () => {
    const ctx = await harness()
    const created = await ctx.tools.execute({
      callId: CallId('shared-default'),
      name: 'browser_create',
      arguments: {},
      signal,
    })
    expect(created).toMatchObject({
      isError: false,
      value: {
        chrome: {
          kind: 'shared',
          name: 'shared',
          partition: 'persist:session-tool-shared',
        },
        target: { profileId: 'tool-profile-shared' },
      },
    })
    const explicit = await ctx.tools.execute({
      callId: CallId('shared-explicit'),
      name: 'browser_create',
      arguments: { profile: 'shared' },
      signal,
    })
    const createdTarget = created.isError ? undefined : created.value as { target: { workspaceId: string } }
    const explicitTarget = explicit.isError ? undefined : explicit.value as {
      chrome: { partition: string }
      target: { profileId: string; workspaceId: string }
    }
    expect(explicit).toMatchObject({ isError: false })
    expect(explicitTarget?.target.profileId).toBe('tool-profile-shared')
    expect(explicitTarget?.target.workspaceId).not.toBe(createdTarget?.target.workspaceId)
    expect(explicitTarget?.chrome.partition).toBe('persist:session-tool-shared')
  })

  it('uses the ui-browser settings default when the model omits profile', async () => {
    const ctx = await harness()
    let section: Record<string, unknown> = { defaultKind: 'temporary' }
    ctx.provide('settings', { get: () => section })
    const created = await ctx.tools.execute({
      callId: CallId('settings-temporary-default'),
      name: 'browser_create',
      arguments: {},
      signal,
    })
    expect(created).toMatchObject({
      isError: false,
      value: { chrome: { kind: 'temporary' } },
    })
    section = { defaultKind: 'persistent', defaultPersistentName: 'work' }
    const persistent = await ctx.tools.execute({
      callId: CallId('settings-persistent-default'),
      name: 'browser_create',
      arguments: {},
      signal,
    })
    expect(persistent).toMatchObject({
      isError: false,
      value: { chrome: { kind: 'persistent', name: 'work' } },
    })
  })

  it('rejects invalid Consumer arguments and timeout configuration at their owning boundaries', async () => {
    const ctx = await harness()
    const target = {
      profileId: 'tool-tmp-1',
      workspaceId: 'tool-tmp-1-workspace',
      browserId: 'tool-tmp-1-browser-1',
      tabId: 'tool-tmp-1-tab-1',
    }
    await ctx.tools.execute({
      callId: CallId('create'),
      name: 'browser_create',
      arguments: { profile: 'temporary' },
      signal,
    })

    const unknownProfile = await ctx.tools.execute({
      callId: CallId('unknown-profile'),
      name: 'browser_create',
      arguments: { profile: 'unknown' },
      signal,
    })
    expect(unknownProfile).toMatchObject({ isError: true })

    const missingName = await ctx.tools.execute({
      callId: CallId('missing-name'),
      name: 'browser_create',
      arguments: { profile: 'persistent' },
      signal,
    })
    expect(missingName).toMatchObject({ isError: true })

    const blankName = await ctx.tools.execute({
      callId: CallId('blank-name'),
      name: 'browser_create',
      arguments: { profile: 'persistent', name: '  ' },
      signal,
    })
    expect(blankName).toMatchObject({ isError: true })

    const named = await ctx.tools.execute({
      callId: CallId('named-create'),
      name: 'browser_create',
      arguments: { profile: 'persistent', name: 'work' },
      signal,
    })
    expect(named).toMatchObject({
      isError: false,
      value: { chrome: { kind: 'persistent', name: 'work' } },
    })

    const emptyIdentity = await ctx.tools.execute({
      callId: CallId('empty-identity'),
      name: 'browser_navigate',
      arguments: { target: { ...target, profileId: '' }, expectedRevision: 0, url: 'https://example.test/' },
      signal,
    })
    expect(emptyIdentity).toMatchObject({ isError: true })

    const emptyUrl = await ctx.tools.execute({
      callId: CallId('empty-url'),
      name: 'browser_navigate',
      arguments: { target, expectedRevision: 0, url: ' ' },
      signal,
    })
    expect(emptyUrl).toMatchObject({ isError: true })

    const emptyInputUrl = await ctx.tools.execute({
      callId: CallId('empty-input-url'),
      name: 'browser_input',
      arguments: { target, expectedRevision: 0, url: ' ' },
      signal,
    })
    expect(emptyInputUrl).toMatchObject({ isError: true })

    const emptyInputText = await ctx.tools.execute({
      callId: CallId('empty-input-text'),
      name: 'browser_input',
      arguments: { target, expectedRevision: 0, text: ' ' },
      signal,
    })
    expect(emptyInputText).toMatchObject({ isError: true })

    const inputWithUrl = await ctx.tools.execute({
      callId: CallId('input-with-url'),
      name: 'browser_input',
      arguments: { target, expectedRevision: 0, url: 'https://example.test/' },
      signal,
    })
    expect(inputWithUrl).toMatchObject({ isError: false, value: { url: 'https://example.test/' } })

    const inputWithUrlAndText = await ctx.tools.execute({
      callId: CallId('input-with-url-and-text'),
      name: 'browser_input',
      arguments: { target, expectedRevision: 1, url: 'https://example.test/', text: 'typed' },
      signal,
    })
    expect(inputWithUrlAndText).toMatchObject({ isError: false, value: { text: 'typed' } })

    const clickOnlyInput = await ctx.tools.execute({
      callId: CallId('input-click-only'),
      name: 'browser_input',
      arguments: { target, expectedRevision: 1 },
      signal,
    })
    expect(clickOnlyInput).toMatchObject({ isError: true })

    const negativeRevision = await ctx.tools.execute({
      callId: CallId('negative-revision'),
      name: 'browser_focus',
      arguments: { target, expectedRevision: -1 },
      signal,
    })
    expect(negativeRevision).toMatchObject({ isError: true })

    const unsafeRevision = await ctx.tools.execute({
      callId: CallId('unsafe-revision'),
      name: 'browser_focus',
      arguments: { target, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      signal,
    })
    expect(unsafeRevision).toMatchObject({ isError: true })

    const badAttachNull = await ctx.tools.execute({
      callId: CallId('bad-attach-null'),
      name: 'browser_create',
      arguments: { attach: null },
      signal,
    })
    expect(badAttachNull).toMatchObject({ isError: true })

    const badAttachObject = await ctx.tools.execute({
      callId: CallId('bad-attach-object'),
      name: 'browser_create',
      arguments: { attach: 'nope' },
      signal,
    })
    expect(badAttachObject).toMatchObject({ isError: true })

    const badAttachKind = await ctx.tools.execute({
      callId: CallId('bad-attach-kind'),
      name: 'browser_create',
      arguments: { attach: { kind: 'other', workspaceId: 'ws' } },
      signal,
    })
    expect(badAttachKind).toMatchObject({ isError: true })

    const badAttachWorkspace = await ctx.tools.execute({
      callId: CallId('bad-attach-workspace'),
      name: 'browser_create',
      arguments: { attach: { kind: 'workspace', workspaceId: '  ' } },
      signal,
    })
    expect(badAttachWorkspace).toMatchObject({ isError: true })

    const badAttachBrowser = await ctx.tools.execute({
      callId: CallId('bad-attach-browser'),
      name: 'browser_create',
      arguments: { attach: { kind: 'browser', workspaceId: 'ws' } },
      signal,
    })
    expect(badAttachBrowser).toMatchObject({ isError: true })

    const createdForAttach = await ctx.tools.execute({
      callId: CallId('attach-base'),
      name: 'browser_create',
      arguments: {},
      signal,
    })
    expect(createdForAttach).toMatchObject({ isError: false })
    const createdTarget = createdForAttach.isError ? undefined : createdForAttach.value as { target: typeof target }
    const attached = await ctx.tools.execute({
      callId: CallId('attach-tab'),
      name: 'browser_create',
      arguments: {
        attach: {
          kind: 'browser',
          workspaceId: createdTarget?.target.workspaceId,
          browserId: createdTarget?.target.browserId,
        },
      },
      signal,
    })
    expect(attached).toMatchObject({ isError: false })
    const attachedWorkspace = await ctx.tools.execute({
      callId: CallId('attach-workspace'),
      name: 'browser_create',
      arguments: {
        attach: {
          kind: 'workspace',
          workspaceId: createdTarget?.target.workspaceId,
        },
      },
      signal,
    })
    expect(attachedWorkspace).toMatchObject({ isError: false })

    expect(() => { ToolBrowser.apply(new Context(), { timeoutMs: 0 }) }).toThrow(/positive safe integer/)
    expect(() => { ToolBrowser.apply(new Context(), { timeoutMs: 1.5 }) }).toThrow(/positive safe integer/)
  })

  it('fails loud without deferred discovery and rolls back every partial registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: false })
    await ctx.plugin(BrowserRuntimeDeterministic, {
      pages: [{
        url: 'https://example.test/',
        title: 'Example Domain',
        text: 'A deterministic browser page.',
        screenshotPngBase64: PNG_1X1,
      }],
    })

    await expect(ctx.plugin(ToolBrowser)).rejects.toThrow(/sets deferLoading but dsh-tools toolSearch is disabled/)
    expect(ctx.tools.catalogSchemas()).toEqual([])
  })

  it('removes every deferred browser definition when the Consumer fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536 } })
    await ctx.plugin(BrowserRuntimeDeterministic, {
      pages: [{
        url: 'https://example.test/',
        title: 'Example Domain',
        text: 'A deterministic browser page.',
        screenshotPngBase64: PNG_1X1,
      }],
    })
    const fiber = await ctx.plugin(ToolBrowser)
    expect(ctx.tools.catalogSchemas()).toHaveLength(7)
    await fiber.dispose()
    expect(ctx.tools.catalogSchemas()).toEqual([])
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['tool_search'])
  })

  it('binds created tabs to the calling Agent Session when the Workspace binder is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536, maxResults: 10 } })
    await ctx.plugin(BrowserRuntimeDeterministic, {
      idPrefix: 'bound',
      pages: [{
        url: 'https://example.test/',
        title: 'Example Domain',
        text: 'A deterministic browser page.',
        screenshotPngBase64: PNG_1X1,
      }],
    })
    await ctx.plugin(BrowserWorkspaceBinder)
    await ctx.plugin(ToolBrowser)
    const session = ctx.sessions.create(SessionId('bound-session'))
    const agent = { id: session.id, session } as unknown as Agent
    const created = await ctx.tools.execute({
      callId: CallId('bound-create'),
      name: 'browser_create',
      arguments: {},
      signal,
      agent,
    })
    expect(created).toMatchObject({ isError: false, value: { revision: 0 } })
    expect(ctx.browserWorkspace.snapshot(session).workspaces).toHaveLength(1)
    const createdValue = created.isError
      ? undefined
      : created.value as { target: { profileId: string; workspaceId: string; browserId: string; tabId: string } }
    const target = createdValue?.target
    const named = await ctx.tools.execute({
      callId: CallId('bound-named'),
      name: 'browser_create',
      arguments: { profile: 'persistent', name: 'work' },
      signal,
      agent,
    })
    expect(named).toMatchObject({ isError: false })
    const namedTarget = named.isError ? undefined : (named.value as { target: { workspaceId: string; browserId: string } }).target
    const temporary = await ctx.tools.execute({
      callId: CallId('bound-temporary'),
      name: 'browser_create',
      arguments: { profile: 'temporary' },
      signal,
      agent,
    })
    expect(temporary).toMatchObject({ isError: false, value: { chrome: { kind: 'temporary' } } })
    const temporaryTarget = temporary.isError
      ? undefined
      : (temporary.value as { target: { workspaceId: string; browserId: string } }).target
    await expect(ctx.tools.execute({
      callId: CallId('bound-temporary-attach'),
      name: 'browser_create',
      arguments: {
        profile: 'temporary',
        attach: { kind: 'browser', workspaceId: temporaryTarget?.workspaceId, browserId: temporaryTarget?.browserId },
      },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false, value: { chrome: { kind: 'temporary' } } })
    await expect(ctx.tools.execute({
      callId: CallId('bound-named-attach'),
      name: 'browser_create',
      arguments: {
        profile: 'persistent',
        name: 'work',
        attach: { kind: 'browser', workspaceId: namedTarget?.workspaceId, browserId: namedTarget?.browserId },
      },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false })
    await expect(ctx.tools.execute({
      callId: CallId('bound-observe'),
      name: 'browser_observe',
      arguments: { target },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false })
    await expect(ctx.tools.execute({
      callId: CallId('bound-navigate'),
      name: 'browser_navigate',
      arguments: { target, expectedRevision: 0, url: 'https://example.test/' },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false })
    await expect(ctx.tools.execute({
      callId: CallId('bound-screenshot'),
      name: 'browser_screenshot',
      arguments: { target },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false })
    await expect(ctx.tools.execute({
      callId: CallId('bound-focus'),
      name: 'browser_focus',
      arguments: { target, expectedRevision: 1 },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false })
    await expect(ctx.tools.execute({
      callId: CallId('bound-input'),
      name: 'browser_input',
      arguments: { target, expectedRevision: 2, text: 'Agent input' },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false, value: { text: 'Agent input' } })
    await expect(ctx.tools.execute({
      callId: CallId('bound-close'),
      name: 'browser_close',
      arguments: { target, expectedRevision: 3 },
      signal,
      agent,
    })).resolves.toMatchObject({ isError: false })
  })

  it('uses the direct-call timeout default and disposes its empty invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536 } })
    await ctx.plugin(BrowserRuntimeDeterministic, {
      pages: [{
        url: 'https://example.test/',
        title: 'Example Domain',
        text: 'A deterministic browser page.',
        screenshotPngBase64: PNG_1X1,
      }],
    })
    ToolBrowser.apply(ctx, {})
    expect(ctx.tools.catalogSchemas()).toHaveLength(7)

    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(ToolBrowserInvariant)
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})
