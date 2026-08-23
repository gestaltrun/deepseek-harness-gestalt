import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  addressedBrowserRuntimeState,
  assertBrowserCreateAttach,
  assertBrowserNotAborted,
  assertBrowserProfileName,
  assertUnattachedPersistentWriterAvailable,
  browserProfileChrome,
  browserSessionNameFromPartition,
  browserSessionPartition,
  browserTemporaryPartition,
  BrowserInstanceId,
  BrowserProfileId,
  BrowserProfileName,
  BrowserRuntimeError,
  BrowserTabId,
  BrowserWorkspaceId,
  emitBrowserRuntimeState,
  enqueueBrowserRuntimeOperation,
  labeledBrowserProfileName,
  openBrowserPagesForProfile,
  requireExpectedBrowserRevision,
  requireExpectedOpenBrowserPage,
  requireOpenBrowserPage,
  resolveBrowserProfileCreate,
  browserProfileRetainsIdentity,
  browserSharedWorkspaceSeq,
  sameBrowserInstance,
  sameBrowserProfile,
  sameBrowserTarget,
  sameBrowserWorkspace,
  browserProfileStorage,
  browserTargetFor,
} from '@deepseek-ai/dsh-browser-runtime'

describe('Browser Runtime public vocabulary', () => {
  it('brands opaque identities without changing Provider-issued values', () => {
    expect({
      profileId: BrowserProfileId('profile'),
      workspaceId: BrowserWorkspaceId('workspace'),
      browserId: BrowserInstanceId('browser'),
      tabId: BrowserTabId('tab'),
    }).toEqual({
      profileId: 'profile',
      workspaceId: 'workspace',
      browserId: 'browser',
      tabId: 'tab',
    })
  })

  it('retains the stable Browser Runtime error code', () => {
    const error = new BrowserRuntimeError('missing target', 'BROWSER_NOT_FOUND')
    expect(error).toMatchObject({ name: 'BrowserRuntimeError', message: 'missing target', code: 'BROWSER_NOT_FOUND' })
  })

  it('brands a named Browser Profile without adding an account-picker identity', () => {
    expect(BrowserProfileName('work')).toBe('work')
  })

  it('maps a named Profile to a stable Electron persist partition and an address-field label', () => {
    const name = BrowserProfileName('work')
    expect(browserSessionPartition('tandem-work')).toBe('persist:session-tandem-work')
    expect(browserProfileChrome({ kind: 'persistent', name, sessionName: 'tandem-work' })).toEqual({
      kind: 'persistent',
      name: 'work',
      partition: 'persist:session-tandem-work',
    })
    expect(labeledBrowserProfileName(browserProfileChrome({
      kind: 'persistent',
      name,
      sessionName: 'tandem-work',
    }))).toBe('work')
  })

  it('omits the address-field label for a temporary Profile', () => {
    const chrome = browserProfileChrome({ kind: 'temporary', sessionName: 'tandem-tmp-1' })
    expect(browserTemporaryPartition('tandem-tmp-1')).toBe('session-tandem-tmp-1')
    expect(browserSessionNameFromPartition('persist:session-tandem-work')).toBe('tandem-work')
    expect(browserSessionNameFromPartition('session-tandem-tmp-1')).toBe('tandem-tmp-1')
    expect(() => browserSessionNameFromPartition('default')).toThrow(/not a session key/)
    expect(chrome).toEqual({
      kind: 'temporary',
      partition: 'session-tandem-tmp-1',
    })
    expect(labeledBrowserProfileName(chrome)).toBeUndefined()
    expect(chrome).not.toHaveProperty('name')
    expect(() => browserProfileChrome({ kind: 'persistent', sessionName: 'tandem-work' }))
      .toThrow(BrowserRuntimeError)
  })

  it('rejects a Profile name that cannot be a stable partition key', () => {
    for (const [label, name] of [
      ['empty', ''],
      ['blank', '  '],
      ['path separator', 'work/home'],
      ['backslash', 'work\\home'],
      ['control character', 'work\nname'],
      ['leading hyphen', '-work'],
      ['reserved temporary marker', 'tmp-1'],
      ['reserved shared Profile', 'shared'],
    ] as const) {
      expect(() => assertBrowserProfileName(name), label).toThrow(BrowserRuntimeError)
      try {
        assertBrowserProfileName(name)
      } catch (error) {
        expect(error).toMatchObject({ code: 'BROWSER_PROFILE_NAME' })
      }
    }
    expect(assertBrowserProfileName('Work.Account_1')).toBe('Work.Account_1')
  })

  it('resolves unique temporary facts and stable named-Profile facts', () => {
    expect(resolveBrowserProfileCreate('tandem', { profile: 'temporary' }, 2)).toEqual({
      profileId: 'tandem-tmp-2',
      sessionName: 'tandem-tmp-2',
      chrome: { kind: 'temporary', partition: 'session-tandem-tmp-2' },
    })
    expect(resolveBrowserProfileCreate('tandem', { profile: 'persistent', name: 'work' }, 9)).toEqual({
      profileId: 'tandem-profile-work',
      sessionName: 'tandem-work',
      chrome: { kind: 'persistent', name: 'work', partition: 'persist:session-tandem-work' },
    })
    expect(resolveBrowserProfileCreate('tandem', { profile: 'shared' }, 9)).toEqual({
      profileId: 'tandem-profile-shared',
      sessionName: 'tandem-shared',
      chrome: { kind: 'shared', name: 'shared', partition: 'persist:session-tandem-shared' },
    })
    expect(browserProfileChrome({ kind: 'shared', sessionName: 'tandem-shared' })).toEqual({
      kind: 'shared',
      name: 'shared',
      partition: 'persist:session-tandem-shared',
    })
    const sharedFirst = browserTargetFor(BrowserProfileId('tandem-profile-shared'), 'tandem-shared', 1, undefined, 1)
    const sharedSecond = browserTargetFor(BrowserProfileId('tandem-profile-shared'), 'tandem-shared', 2, undefined, 2)
    expect(sharedFirst.workspaceId).toBe('tandem-shared-workspace-1')
    expect(sharedSecond.workspaceId).toBe('tandem-shared-workspace-2')
    expect(sameBrowserProfile(sharedFirst, sharedSecond)).toBe(true)
    expect(sameBrowserWorkspace(sharedFirst, sharedSecond)).toBe(false)
    expect(labeledBrowserProfileName(browserProfileChrome({ kind: 'shared', sessionName: 'tandem-shared' })))
      .toBe('shared')
    expect(browserProfileRetainsIdentity('shared')).toBe(true)
    expect(browserProfileRetainsIdentity('persistent')).toBe(true)
    expect(browserProfileRetainsIdentity('temporary')).toBe(false)
    expect(browserSharedWorkspaceSeq([], BrowserProfileId('tandem-profile-shared'), undefined)).toBe(1)
    expect(browserSharedWorkspaceSeq([{
      status: 'open',
      target: sharedFirst,
      revision: 0,
      url: 'about:blank',
      title: '',
      text: '',
      focused: false,
      chrome: { kind: 'shared', name: BrowserProfileName('shared'), partition: 'persist:session-tandem-shared' },
      storage: { cookies: '', localStorage: '', indexedDb: '', cache: '', serviceWorker: '' },
    }], BrowserProfileId('tandem-profile-shared'), undefined)).toBe(2)
    expect(browserSharedWorkspaceSeq([], BrowserProfileId('tandem-profile-shared'), {
      kind: 'workspace',
      workspaceId: sharedFirst.workspaceId,
    })).toBeUndefined()
    const work = browserTargetFor(BrowserProfileId('tandem-profile-work'), 'tandem-work', 1)
    expect(work).toEqual({
      profileId: 'tandem-profile-work',
      workspaceId: 'tandem-work-workspace',
      browserId: 'tandem-work-browser-1',
      tabId: 'tandem-work-tab-1',
    })
    const second = browserTargetFor(BrowserProfileId('tandem-profile-work'), 'tandem-work', 2, {
      kind: 'browser',
      workspaceId: work.workspaceId,
      browserId: work.browserId,
    })
    expect(sameBrowserProfile(work, second)).toBe(true)
    expect(sameBrowserWorkspace(work, second)).toBe(true)
    expect(sameBrowserInstance(work, second)).toBe(true)
    expect(second.tabId).toBe('tandem-work-tab-2')
    expect(() => {
      assertBrowserCreateAttach([], work.profileId, {
        kind: 'workspace',
        workspaceId: work.workspaceId,
      })
    }).toThrow(BrowserRuntimeError)
    expect(() => {
      assertBrowserCreateAttach([{
        status: 'open',
        target: work,
        revision: 0,
        url: 'about:blank',
        title: 'New Tab',
        text: '',
        focused: false,
        chrome: { kind: 'temporary', partition: 'session-tandem-work' },
        storage: browserProfileStorage(''),
      }], work.profileId, {
        kind: 'browser',
        workspaceId: work.workspaceId,
        browserId: BrowserInstanceId('missing-browser'),
      })
    }).toThrow(BrowserRuntimeError)
    expect(browserProfileStorage('work')).toEqual({
      cookies: 'profile=work',
      localStorage: 'work',
      indexedDb: 'work',
      cache: 'work',
      serviceWorker: 'work',
    })
    expect(browserProfileStorage('')).toEqual({
      cookies: 'profile=',
      localStorage: '',
      indexedDb: '',
      cache: '',
      serviceWorker: '',
    })
  })
})

describe('Browser Runtime shared Provider helpers', () => {
  const target = {
    profileId: BrowserProfileId('profile'),
    workspaceId: BrowserWorkspaceId('workspace'),
    browserId: BrowserInstanceId('browser'),
    tabId: BrowserTabId('tab'),
  }

  it('compares opaque targets and rejects aborted work', () => {
    expect(sameBrowserTarget(target, { ...target })).toBe(true)
    expect(sameBrowserTarget(target, { ...target, tabId: BrowserTabId('other') })).toBe(false)
    assertBrowserNotAborted(undefined)
    const signal = AbortSignal.abort('stop')
    expect(() => {
      assertBrowserNotAborted(signal)
    }).toThrow(BrowserRuntimeError)
  })

  it('lists open pages and rejects a second unattached named persistent writer', () => {
    const open = Object.freeze({
      status: 'open' as const,
      target,
      revision: 0,
      url: 'about:blank',
      title: '',
      text: '',
      focused: false,
      chrome: {
        kind: 'persistent' as const,
        name: BrowserProfileName('work'),
        partition: 'persist:session-work',
      },
      storage: browserProfileStorage('work'),
    })
    const closed = Object.freeze({ status: 'closed' as const, target, revision: 1 })
    expect(openBrowserPagesForProfile([open, closed], target.profileId)).toEqual([open])
    expect(openBrowserPagesForProfile([open], BrowserProfileId('other'))).toEqual([])
    assertUnattachedPersistentWriterAvailable([open], { profile: 'temporary' }, 'persist:session-work')
    assertUnattachedPersistentWriterAvailable([], { profile: 'shared' }, 'persist:session-work')
    assertUnattachedPersistentWriterAvailable([], {
      profile: 'persistent',
      name: BrowserProfileName('work'),
    }, 'persist:session-work')
    assertUnattachedPersistentWriterAvailable([open], {
      profile: 'persistent',
      name: BrowserProfileName('work'),
      attach: { kind: 'workspace', workspaceId: target.workspaceId },
    }, 'persist:session-work')
    expect(() => {
      assertUnattachedPersistentWriterAvailable([open], {
        profile: 'persistent',
        name: BrowserProfileName('work'),
      }, 'persist:session-work')
    }).toThrow(BrowserRuntimeError)
  })

  it('addresses open state and serializes one queued operation', async () => {
    const open = Object.freeze({
      status: 'open' as const,
      target,
      revision: 0,
      url: 'about:blank',
      title: '',
      text: '',
      focused: false,
      chrome: { kind: 'temporary' as const, partition: 'session-tmp-1' },
      storage: {
        cookies: '',
        localStorage: '',
        indexedDb: '',
        cache: '',
        serviceWorker: '',
      },
    })
    expect(addressedBrowserRuntimeState(open, target)).toBe(open)
    expect(() => {
      addressedBrowserRuntimeState(undefined, target)
    }).toThrow(BrowserRuntimeError)
    expect(requireOpenBrowserPage(open)).toBe(open)
    expect(requireExpectedOpenBrowserPage(open, 0)).toBe(open)
    expect(() => {
      requireExpectedBrowserRevision(open, 1)
    }).toThrow(/current 0; observe again before mutating/)
    expect(() => {
      requireExpectedOpenBrowserPage(open, 1)
    }).toThrow(BrowserRuntimeError)
    expect(() => {
      requireOpenBrowserPage({ status: 'closed', target, revision: 1 })
    }).toThrow(BrowserRuntimeError)
    const first = enqueueBrowserRuntimeOperation(Promise.resolve(), () => undefined, () => 1)
    await expect(first.result).resolves.toBe(1)
    expect(() => {
      enqueueBrowserRuntimeOperation(first.queue, () => {
        throw new BrowserRuntimeError('browser runtime is disposed', 'BROWSER_DISPOSED')
      }, () => 2)
    }).toThrow(BrowserRuntimeError)
  })

  it('contains post-commit observer failures', async () => {
    const ctx = new Context()
    const warnings: unknown[] = []
    ctx.on('browser/runtime-state', () => { throw new Error('sync') })
    ctx.on('browser/runtime-state', (): unknown => Promise.reject(new Error('async')))
    emitBrowserRuntimeState(ctx, { status: 'closed', target, revision: 0 }, (error) => {
      warnings.push(error)
    })
    await Promise.resolve()
    expect(warnings.map(error => error instanceof Error ? error.message : error)).toEqual(['sync', 'async'])
  })
})
