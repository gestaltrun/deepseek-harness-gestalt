import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BrowserProfileName, BrowserRuntimeError, BrowserTabId } from '@deepseek-ai/dsh-browser-runtime'
import BrowserRuntimeDeterministic from '@deepseek-ai/dsh-browser-runtime-deterministic'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import BrowserWorkspaceBinder from '@deepseek-ai/dsh-browser-workspace'
import * as BrowserWorkspaceInvariant from '../src/invariant.ts'
import { EMPTY_BROWSER_WORKSPACE, foldBrowserWorkspace } from '../src/fold.ts'
import { listBrowserWorkspacePages } from '../src/pages.ts'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PAGES = [
  { url: 'https://alpha.test/', title: 'Alpha', text: 'alpha', screenshotPngBase64: PNG_1X1 },
  { url: 'https://beta.test/', title: 'Beta', text: 'beta', screenshotPngBase64: PNG_1X1 },
]

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BrowserRuntimeDeterministic, { idPrefix: 'space', pages: PAGES })
  await ctx.plugin(BrowserWorkspaceBinder)
  return ctx
}

describe('Session-owned Browser Workspace', () => {
  it('starts empty independently per Session', async () => {
    const ctx = await harness()
    const first = ctx.sessions.create(SessionId('session-a'))
    const second = ctx.sessions.create(SessionId('session-b'))
    expect(ctx.browserWorkspace.snapshot(first)).toEqual(EMPTY_BROWSER_WORKSPACE)
    expect(ctx.sessionProjections.snapshot(first).values.browserWorkspace).toEqual(EMPTY_BROWSER_WORKSPACE)
    expect(ctx.browserWorkspace.snapshot(second)).toEqual(EMPTY_BROWSER_WORKSPACE)
    expect(foldBrowserWorkspace(first.events)).toEqual(ctx.browserWorkspace.snapshot(first))
  })

  it('lets one Session own multiple Profiles, instances, and tabs without exposing another Session', async () => {
    const ctx = await harness()
    const first = ctx.sessions.create(SessionId('session-a'))
    const second = ctx.sessions.create(SessionId('session-b'))

    const work = await ctx.browserWorkspace.create({
      session: first,
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })
    const personal = await ctx.browserWorkspace.create({
      session: first,
      profile: 'persistent',
      name: BrowserProfileName('personal'),
    })
    const secondTab = await ctx.browserWorkspace.create({
      session: first,
      profile: 'persistent',
      name: BrowserProfileName('work'),
      attach: { kind: 'browser', workspaceId: work.target.workspaceId, browserId: work.target.browserId },
    })
    const secondBrowser = await ctx.browserWorkspace.create({
      session: first,
      profile: 'persistent',
      name: BrowserProfileName('work'),
      attach: { kind: 'workspace', workspaceId: work.target.workspaceId },
    })
    expect(secondTab.target.workspaceId).toBe(work.target.workspaceId)
    expect(secondTab.target.browserId).toBe(work.target.browserId)
    expect(secondTab.target.tabId).not.toBe(work.target.tabId)
    expect(secondBrowser.target.workspaceId).toBe(work.target.workspaceId)
    expect(secondBrowser.target.browserId).not.toBe(work.target.browserId)

    await ctx.browserWorkspace.navigate({
      session: first,
      target: work.target,
      expectedRevision: 0,
      url: 'https://alpha.test/',
    })
    const focusedTab = await ctx.browserWorkspace.navigate({
      session: first,
      target: secondTab.target,
      expectedRevision: 0,
      url: 'https://beta.test/',
    })
    const focused = await ctx.browserWorkspace.focus({ session: first, target: secondTab.target, expectedRevision: focusedTab.revision })
    await ctx.browserWorkspace.focus({ session: first, target: secondTab.target, expectedRevision: focused.revision })
    await expect(ctx.browserWorkspace.screenshot({ session: first, target: secondTab.target }))
      .resolves.toMatchObject({ target: secondTab.target, mediaType: 'image/png' })

    const other = await ctx.browserWorkspace.create({ session: second, profile: 'temporary' })
    await ctx.browserWorkspace.navigate({
      session: second,
      target: other.target,
      expectedRevision: 0,
      url: 'https://beta.test/',
    })

    const firstSnapshot = ctx.browserWorkspace.snapshot(first)
    expect(firstSnapshot.workspaces).toHaveLength(2)
    expect(firstSnapshot.activeWorkspaceId).toBe(work.target.workspaceId)
    const workSpace = firstSnapshot.workspaces.find(item => item.workspaceId === work.target.workspaceId)
    expect(workSpace?.profileId).toBe(work.target.profileId)
    expect(workSpace?.browsers).toHaveLength(2)
    expect(workSpace?.activeBrowserId).toBe(work.target.browserId)
    expect(workSpace?.browsers[0]?.tabs.map(tab => tab.tabId)).toEqual([work.target.tabId, secondTab.target.tabId])
    expect(workSpace?.browsers[0]?.activeTabId).toBe(secondTab.target.tabId)
    expect(firstSnapshot.workspaces.some(item => item.workspaceId === personal.target.workspaceId)).toBe(true)
    expect(JSON.stringify(firstSnapshot)).not.toContain(other.target.tabId)

    const secondSnapshot = ctx.browserWorkspace.snapshot(second)
    expect(secondSnapshot.workspaces).toHaveLength(1)
    expect(secondSnapshot.workspaces[0]?.browsers[0]?.tabs).toEqual([
      { tabId: other.target.tabId, revision: 1 },
    ])
    expect(JSON.stringify(secondSnapshot)).not.toContain(work.target.tabId)

    await expect(ctx.browserWorkspace.observe({ session: second, target: work.target }))
      .rejects.toMatchObject({ code: 'BROWSER_TRANSFER_UNSUPPORTED' })
    await expect(ctx.browserWorkspace.create({
      session: second,
      profile: 'persistent',
      name: BrowserProfileName('work'),
      attach: { kind: 'browser', workspaceId: work.target.workspaceId, browserId: work.target.browserId },
    })).rejects.toMatchObject({ code: 'BROWSER_TRANSFER_UNSUPPORTED' })
    await expect(ctx.browserWorkspace.create({
      session: first,
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: work.target.workspaceId.replace('workspace', 'missing') as typeof work.target.workspaceId },
    })).rejects.toMatchObject({ code: 'BROWSER_SESSION_MISMATCH' })
    await expect(ctx.browserWorkspace.focus({
      session: first,
      target: {
        profileId: work.target.profileId,
        workspaceId: work.target.workspaceId,
        browserId: work.target.browserId,
        tabId: BrowserTabId('missing-tab'),
      },
      expectedRevision: 0,
    })).rejects.toMatchObject({ code: 'BROWSER_SESSION_MISMATCH' })

    await ctx.browserWorkspace.close({ session: first, target: work.target, expectedRevision: 1 })
    const afterInactiveClose = ctx.browserWorkspace.snapshot(first)
    const remainingWork = afterInactiveClose.workspaces.find(item => item.workspaceId === work.target.workspaceId)
    expect(remainingWork?.browsers[0]?.tabs).toEqual([
      { tabId: secondTab.target.tabId, revision: 3 },
    ])
    expect(remainingWork?.browsers[0]?.activeTabId).toBe(secondTab.target.tabId)
    await ctx.browserWorkspace.close({ session: first, target: secondTab.target, expectedRevision: focused.revision + 1 })
    const afterBrowserClose = ctx.browserWorkspace.snapshot(first)
    const remainingAfterBrowser = afterBrowserClose.workspaces.find(item => item.workspaceId === work.target.workspaceId)
    expect(remainingAfterBrowser?.browsers).toHaveLength(1)
    expect(remainingAfterBrowser?.activeBrowserId).toBe(secondBrowser.target.browserId)
  })

  it('reuses the shared Profile across Sessions without isolating storage', async () => {
    const ctx = await harness()
    const first = ctx.sessions.create(SessionId('session-shared-a'))
    const second = ctx.sessions.create(SessionId('session-shared-b'))
    const a = await ctx.browserWorkspace.create({ session: first, profile: 'shared' })
    await ctx.browserWorkspace.navigate({
      session: first,
      target: a.target,
      expectedRevision: 0,
      url: 'https://alpha.test/',
    })
    const b = await ctx.browserWorkspace.create({ session: second, profile: 'shared' })
    expect(b.target.profileId).toBe(a.target.profileId)
    expect(b.target.workspaceId).not.toBe(a.target.workspaceId)
    expect(b.chrome).toMatchObject({
      kind: 'shared',
      partition: a.chrome.partition,
    })
    expect(b.storage.cookies).toBe('profile=shared')
    expect(ctx.browserWorkspace.snapshot(first).workspaces[0]?.profileId).toBe(a.target.profileId)
    expect(ctx.browserWorkspace.snapshot(second).workspaces[0]?.profileId).toBe(a.target.profileId)
  })

  it('serializes create and reuses a matching retained Profile inside one Session', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-profile-reuse'))
    const [firstWork, secondWork] = await Promise.all([
      ctx.browserWorkspace.create({
        session,
        profile: 'persistent',
        name: BrowserProfileName('work'),
      }),
      ctx.browserWorkspace.create({
        session,
        profile: 'persistent',
        name: BrowserProfileName('work'),
      }),
    ])
    expect(secondWork.target).toMatchObject({
      profileId: firstWork.target.profileId,
      workspaceId: firstWork.target.workspaceId,
      browserId: firstWork.target.browserId,
    })
    expect(secondWork.target.tabId).not.toBe(firstWork.target.tabId)

    const personal = await ctx.browserWorkspace.create({
      session,
      profile: 'persistent',
      name: BrowserProfileName('personal'),
    })
    expect(personal.target.browserId).not.toBe(firstWork.target.browserId)

    const firstShared = await ctx.browserWorkspace.create({ session, profile: 'shared' })
    const secondShared = await ctx.browserWorkspace.create({ session, profile: 'shared' })
    expect(secondShared.target.browserId).toBe(firstShared.target.browserId)

    const firstTemporary = await ctx.browserWorkspace.create({ session, profile: 'temporary' })
    const secondTemporary = await ctx.browserWorkspace.create({ session, profile: 'temporary' })
    expect(secondTemporary.target.profileId).not.toBe(firstTemporary.target.profileId)
    expect(secondTemporary.target.browserId).not.toBe(firstTemporary.target.browserId)

    const pages = listBrowserWorkspacePages(ctx.browserWorkspace.snapshot(session))
    expect(pages.map(page => page.target.tabId)).toEqual([
      firstWork.target.tabId,
      secondWork.target.tabId,
      personal.target.tabId,
      firstShared.target.tabId,
      secondShared.target.tabId,
      firstTemporary.target.tabId,
      secondTemporary.target.tabId,
    ])
    expect(pages.every(page => page.revision === 0)).toBe(true)
    expect(listBrowserWorkspacePages(undefined)).toEqual([])
    expect(listBrowserWorkspacePages(null)).toEqual([])
  })

  it('recreates a retained Profile after Runtime restart leaves a durable target behind', async () => {
    const before = await harness()
    const originalSession = before.sessions.create(SessionId('session-before-restart'))
    await before.browserWorkspace.create({
      session: originalSession,
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })

    const after = await harness()
    const restoredSession = after.sessions.create(SessionId('session-after-restart'), {
      seed: originalSession.events,
    })
    const recreated = await after.browserWorkspace.create({
      session: restoredSession,
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })

    await expect(after.browserWorkspace.observe({
      session: restoredSession,
      target: recreated.target,
    })).resolves.toMatchObject({ status: 'open' })
    expect(listBrowserWorkspacePages(after.browserWorkspace.snapshot(restoredSession))).toEqual([
      expect.objectContaining({ target: recreated.target, revision: recreated.revision }),
    ])
  })

  it('drops missing and closed retained pages but propagates other observe failures', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-retained-states'))
    const first = await ctx.browserWorkspace.create({
      session,
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })
    await ctx.browserRuntime.close({ target: first.target, expectedRevision: first.revision })
    const observe = ctx.browserRuntime.observe.bind(ctx.browserRuntime)
    ctx.browserRuntime.observe = async () => {
      throw new BrowserRuntimeError('missing', 'BROWSER_NOT_FOUND')
    }
    const afterMissing = await ctx.browserWorkspace.create({
      session,
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })

    ctx.browserRuntime.observe = observe
    await ctx.browserRuntime.close({ target: afterMissing.target, expectedRevision: afterMissing.revision })
    const afterClosed = await ctx.browserWorkspace.create({
      session,
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })
    expect(afterClosed.target.tabId).not.toBe(afterMissing.target.tabId)

    ctx.browserRuntime.observe = async () => {
      throw new BrowserRuntimeError('protocol', 'BROWSER_PROTOCOL')
    }
    await expect(ctx.browserWorkspace.create({
      session,
      profile: 'persistent',
      name: BrowserProfileName('work'),
    })).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL' })
  })

  it('restores one Session Workspace after reload and closes leftover tabs on Session disposal', async () => {
    const ctx = await harness()
    const first = ctx.sessions.create(SessionId('session-a'))
    const created = await ctx.browserWorkspace.create({ session: first, profile: 'temporary' })
    const extra = await ctx.browserWorkspace.create({
      session: first,
      profile: 'temporary',
      attach: { kind: 'browser', workspaceId: created.target.workspaceId, browserId: created.target.browserId },
    })
    await ctx.browserWorkspace.navigate({
      session: first,
      target: extra.target,
      expectedRevision: 0,
      url: 'https://alpha.test/',
    })
    const logged = first.events.filter(event => event.type === 'browser/workspace')
    expect(logged.length).toBeGreaterThan(0)

    const replayed = foldBrowserWorkspace(first.events)
    expect(replayed).toEqual(ctx.browserWorkspace.snapshot(first))
    expect(ctx.sessionProjections.snapshot(first).values.browserWorkspace).toEqual(replayed)

    const restoredCtx = new Context()
    await restoredCtx.plugin(SessionStore)
    await restoredCtx.plugin(SessionProjectionRegistry)
    await restoredCtx.plugin(BrowserRuntimeDeterministic, { idPrefix: 'space', pages: PAGES })
    await restoredCtx.plugin(BrowserWorkspaceBinder)
    const restored = restoredCtx.sessions.create(SessionId('session-a-restored'), { seed: first.events })
    expect(restoredCtx.browserWorkspace.snapshot(restored)).toEqual(replayed)
    expect(restoredCtx.sessionProjections.snapshot(restored).values.browserWorkspace).toEqual(replayed)

    const sibling = await ctx.browserWorkspace.create({
      session: first,
      profile: 'temporary',
      attach: { kind: 'workspace', workspaceId: created.target.workspaceId },
    })
    await ctx.browserWorkspace.focus({ session: first, target: extra.target, expectedRevision: 1 })
    await ctx.browserWorkspace.close({ session: first, target: extra.target, expectedRevision: 2 })
    const afterClose = ctx.browserWorkspace.snapshot(first)
    expect(afterClose.workspaces[0]?.browsers[0]?.tabs).toEqual([
      { tabId: created.target.tabId, revision: 0 },
    ])
    expect(afterClose.workspaces[0]?.browsers[0]?.activeTabId).toBe(created.target.tabId)
    await ctx.browserWorkspace.close({ session: first, target: sibling.target, expectedRevision: 0 })
    await ctx.browserWorkspace.close({ session: first, target: created.target, expectedRevision: 0 })
    expect(ctx.browserWorkspace.snapshot(first).workspaces).toEqual([])
    expect(ctx.browserWorkspace.snapshot(first).activeWorkspaceId).toBeNull()

  })

  it('closes leftover live tabs when the owning Session leaves the store', async () => {
    const ctx = await harness()
    const leftover = ctx.sessions.prepare(SessionId('session-cleanup'))
    const detach = ctx.sessions.enter(leftover)
    ctx.sessions.announce(leftover)
    const live = await ctx.browserWorkspace.create({ session: leftover, profile: 'temporary' })
    detach()
    await expect.poll(() => ctx.browserRuntime.observe({ target: live.target })).toMatchObject({ status: 'closed' })
    expect(ctx.browserWorkspace.snapshot(leftover).workspaces).toEqual([])

    const observer = ctx.browserRuntime.observe.bind(ctx.browserRuntime)
    ctx.browserRuntime.observe = async (request) => {
      if (request.target.tabId === live.target.tabId) throw new Error('cleanup observe failed')
      return observer(request)
    }
    const failing = ctx.sessions.create(SessionId('session-failing-cleanup'))
    failing.append('browser/workspace', {
      activeWorkspaceId: live.target.workspaceId,
      workspaces: [{
        workspaceId: live.target.workspaceId,
        profileId: live.target.profileId,
        activeBrowserId: live.target.browserId,
        browsers: [{
          browserId: live.target.browserId,
          activeTabId: live.target.tabId,
          tabs: [{ tabId: live.target.tabId, revision: 0 }],
        }],
      }],
    })
    await ctx.browserWorkspace.cleanup(failing)
    ctx.browserRuntime.observe = observer

    const alreadyClosed = ctx.sessions.create(SessionId('session-already-closed'))
    alreadyClosed.append('browser/workspace', {
      activeWorkspaceId: live.target.workspaceId,
      workspaces: [{
        workspaceId: live.target.workspaceId,
        profileId: live.target.profileId,
        activeBrowserId: live.target.browserId,
        browsers: [{
          browserId: live.target.browserId,
          activeTabId: live.target.tabId,
          tabs: [{ tabId: live.target.tabId, revision: 0 }],
        }],
      }],
    })
    await ctx.browserWorkspace.cleanup(alreadyClosed)
    expect(ctx.browserWorkspace.snapshot(alreadyClosed).workspaces).toEqual([])
  })

  it('focuses and closes a background tab with that tab\'s listed revision', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-tab-revision'))
    const first = await ctx.browserWorkspace.create({ session, profile: 'temporary' })
    const second = await ctx.browserWorkspace.create({
      session,
      profile: 'temporary',
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })
    await ctx.browserWorkspace.navigate({
      session, target: first.target, expectedRevision: 0, url: 'https://alpha.test/',
    })
    await ctx.browserWorkspace.navigate({
      session, target: second.target, expectedRevision: 0, url: 'https://beta.test/',
    })
    const listed = ctx.browserWorkspace.snapshot(session).workspaces[0]?.browsers[0]?.tabs
    expect(listed).toEqual([
      { tabId: first.target.tabId, revision: 1 },
      { tabId: second.target.tabId, revision: 1 },
    ])
    const firstRevision = listed?.[0]?.revision
    const secondRevision = listed?.[1]?.revision
    if (firstRevision === undefined || secondRevision === undefined) {
      throw new Error('expected listed per-tab revisions')
    }
    const focused = await ctx.browserWorkspace.focus({
      session, target: first.target, expectedRevision: firstRevision,
    })
    expect(focused.revision).toBe(2)
    await expect(ctx.browserWorkspace.close({
      session, target: second.target, expectedRevision: secondRevision,
    })).resolves.toMatchObject({ status: 'closed', revision: 2 })

    const leftover = await ctx.browserWorkspace.create({
      session,
      profile: 'temporary',
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })
    await ctx.browserRuntime.close({ target: leftover.target, expectedRevision: leftover.revision })
    expect(ctx.browserWorkspace.snapshot(session).workspaces[0]?.browsers[0]?.tabs.some(
      tab => tab.tabId === leftover.target.tabId,
    )).toBe(true)
    await expect(ctx.browserWorkspace.observe({ session, target: leftover.target }))
      .resolves.toMatchObject({ status: 'closed', revision: leftover.revision + 1 })
    expect(ctx.browserWorkspace.snapshot(session).workspaces[0]?.browsers[0]?.tabs.some(
      tab => tab.tabId === leftover.target.tabId,
    )).toBe(false)
  })

  it('records a Runtime-internal revision bump on an owned unclosed tab', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-runtime-bump'))
    const first = await ctx.browserWorkspace.create({ session, profile: 'temporary' })
    const second = await ctx.browserWorkspace.create({
      session,
      profile: 'temporary',
      attach: { kind: 'browser', workspaceId: first.target.workspaceId, browserId: first.target.browserId },
    })
    const bumped = await ctx.browserRuntime.navigate({
      target: first.target,
      expectedRevision: 0,
      url: 'https://alpha.test/',
    })
    expect(bumped.revision).toBe(1)
    const listed = ctx.browserWorkspace.snapshot(session).workspaces[0]?.browsers[0]?.tabs
    expect(listed).toEqual([
      { tabId: first.target.tabId, revision: 1 },
      { tabId: second.target.tabId, revision: 0 },
    ])
    const firstRevision = listed?.[0]?.revision
    const secondRevision = listed?.[1]?.revision
    if (firstRevision === undefined || secondRevision === undefined) {
      throw new Error('expected listed per-tab revisions')
    }
    await expect(ctx.browserWorkspace.focus({
      session, target: first.target, expectedRevision: firstRevision,
    })).resolves.toMatchObject({ revision: 2, focused: true })
    await expect(ctx.browserWorkspace.close({
      session, target: second.target, expectedRevision: secondRevision,
    })).resolves.toMatchObject({ status: 'closed', revision: 1 })
  })

  it('ignores Runtime-state for unowned or already-closed tabs', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-runtime-state-filter'))
    const owned = await ctx.browserWorkspace.create({ session, profile: 'temporary' })
    const orphan = await ctx.browserRuntime.create({ profile: 'temporary' })
    ctx.emit('browser/runtime-state', {
      status: 'unavailable',
      target: owned.target,
      revision: 3,
      reason: 'crashed',
      reconnecting: true,
    })
    ctx.emit('browser/runtime-state', {
      status: 'closed',
      target: owned.target,
      revision: 4,
    })
    ctx.emit('browser/runtime-state', {
      status: 'unavailable',
      target: orphan.target,
      revision: 1,
      reason: 'reconnect-failed',
      reconnecting: false,
    })
    expect(ctx.browserWorkspace.snapshot(session).workspaces[0]?.browsers[0]?.tabs).toEqual([
      { tabId: owned.target.tabId, revision: 3 },
    ])
    expect(JSON.stringify(ctx.browserWorkspace.snapshot(session))).not.toContain(orphan.target.tabId)
  })

  it('disposes its invariant companion', async () => {
    const ctx = await harness()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(BrowserWorkspaceInvariant)
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })

  it('persists synthetic input revisions on the same Session identities', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-control'))
    const created = await ctx.browserWorkspace.create({ session, profile: 'temporary' })
    const navigated = await ctx.browserWorkspace.navigate({
      session,
      target: created.target,
      expectedRevision: 0,
      url: 'https://alpha.test/',
    })
    expect(ctx.browserWorkspace.snapshot(session).workspaces[0]?.browsers[0]?.tabs).toEqual([
      { tabId: created.target.tabId, revision: 1 },
    ])

    const inputted = await ctx.browserWorkspace.input({
      session,
      target: created.target,
      expectedRevision: navigated.revision,
      text: 'Agent input',
    })
    expect(inputted).toMatchObject({
      text: 'Agent input',
      target: created.target,
    })
    expect(ctx.browserWorkspace.snapshot(session).workspaces[0]?.browsers[0]?.tabs).toEqual([
      { tabId: created.target.tabId, revision: 2 },
    ])
    await expect(ctx.browserWorkspace.navigate({
      session,
      target: created.target,
      expectedRevision: navigated.revision,
      url: 'https://beta.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_REVISION_CONFLICT' })

    const replayed = foldBrowserWorkspace(session.events)
    expect(replayed.workspaces[0]?.browsers[0]?.tabs[0]?.revision).toBe(inputted.revision)
  })

  it('adapts Remote methods onto the Session-bound verbs', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-remote'))
    const created = await ctx.browserWorkspace.create({ session, profile: 'temporary' })
    const binder = ctx.browserWorkspace
    const opened = await binder.remoteNavigate(
      session.id, created.target, created.revision, 'https://alpha.test/',
    )
    await expect(binder.remoteObserve(session.id, created.target)).resolves.toMatchObject({ status: 'open' })
    await expect(binder.remoteScreenshot(session.id, created.target)).resolves.toMatchObject({
      target: created.target,
    })
    const focused = await binder.remoteFocus(session.id, created.target, opened.revision)
    const navigated = await binder.remoteNavigate(
      session.id, created.target, focused.revision, 'https://beta.test/',
    )
    expect(navigated.url).toBe('https://beta.test/')
    const inputted = await binder.remoteInput(session.id, created.target, navigated.revision, {
      url: 'https://beta.test/',
      text: 'typed',
    })
    const textOnly = await binder.remoteInput(session.id, created.target, inputted.revision, { text: 'again' })
    const urlOnly = await binder.remoteInput(session.id, created.target, textOnly.revision, { url: 'https://alpha.test/' })
    expect(() => binder.remoteInput(session.id, created.target, urlOnly.revision, {}))
      .toThrow(/requires url or text/)
    await expect(binder.remoteClose(session.id, created.target, urlOnly.revision))
      .resolves.toMatchObject({ status: 'closed' })
    expect(() => binder.remoteObserve(SessionId('missing'), created.target))
      .toThrow(/not owned by this Session/)
  })

  it('creates a Session-owned tab through the Remote create verb', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('session-remote-create'))
    const created = await ctx.browserWorkspace.remoteCreate(session.id, { profile: 'temporary' })
    expect(created.status).toBe('open')
    expect(ctx.browserWorkspace.snapshot(session).workspaces).toHaveLength(1)
    const sibling = await ctx.browserWorkspace.remoteCreate(session.id, {
      profile: 'temporary',
      attach: {
        kind: 'browser',
        workspaceId: created.target.workspaceId,
        browserId: created.target.browserId,
      },
    })
    expect(sibling.target.workspaceId).toBe(created.target.workspaceId)
    const named = await ctx.browserWorkspace.remoteCreate(session.id, {
      profile: 'persistent',
      name: 'work',
    })
    expect(named.chrome.kind).toBe('persistent')
  })
})
