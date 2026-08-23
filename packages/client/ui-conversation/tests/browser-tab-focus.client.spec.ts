import { describe, expect, it, vi } from 'vitest'
import type { ToolResultNode, RunningToolCall } from '@deepseek-ai/dsh-client-runtime/client'
import {
  browserTabIdentityFromTool,
  focusListedBrowserTab,
  listedBrowserTabRevision,
} from '../src/client/chat/browser-tab-focus.ts'
import { findToolCall } from '../src/client/chat/tool-node-reader.ts'

const TARGET = {
  profileId: 'profile-1',
  workspaceId: 'ws-1',
  browserId: 'br-1',
  tabId: 'tab-1',
}

const LISTED_REVISION = 7

function navigateResult(overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 5,
    time: 5_000,
    callId: 'nav-1',
    call: {
      name: 'browser_navigate',
      argsRaw: JSON.stringify({
        target: TARGET,
        expectedRevision: 1,
        url: 'https://example.test/',
      }),
    },
    callTime: 4_000,
    content: [{
      type: 'text',
      text: JSON.stringify({ status: 'open', target: TARGET, revision: 2 }, null, 2),
    }],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
    ...overrides,
  }
}

function listing(tabId = TARGET.tabId, revision = LISTED_REVISION) {
  return {
    activeWorkspaceId: TARGET.workspaceId,
    workspaces: [{
      workspaceId: TARGET.workspaceId,
      profileId: TARGET.profileId,
      activeBrowserId: TARGET.browserId,
      browsers: [{
        browserId: TARGET.browserId,
        activeTabId: tabId,
        tabs: [{ tabId, revision }],
      }],
    }],
  }
}

function chatSnapshot(root: ToolResultNode | RunningToolCall) {
  const node = {
    key: `tool:${root.callId}`,
    kind: 'tool-call' as const,
    id: root.callId,
    target: 'chat' as const,
    anchorSeq: 'kind' in root ? root.seq : 0,
    location: { kind: 'session' as const },
    visibility: 'visible' as const,
    data: { root },
  }
  return {
    order: [node.key],
    nodes: {
      get: (key: string) => key === node.key ? node : undefined,
      values: () => [node],
    },
    locations: { getTurn: () => [], getStep: () => [] },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: {
      nodes: 'kind' in root ? [root] : [],
      runningCalls: 'kind' in root ? [] : [root],
      partial: null,
      turnTimings: new Map(),
      turnEnds: new Map(),
    },
  }
}

describe('browserTabIdentityFromTool', () => {
  it('reads the target from browser_navigate args', () => {
    expect(browserTabIdentityFromTool(navigateResult())).toEqual(TARGET)
  })

  it('reads the target from a browser_create result when args have none', () => {
    const created = navigateResult({
      call: { name: 'browser_create', argsRaw: '{"profile":"temporary"}' },
    })
    expect(browserTabIdentityFromTool(created)).toEqual(TARGET)
  })

  it('ignores a non-browser tool even when the payload names a target', () => {
    expect(browserTabIdentityFromTool(navigateResult({
      call: { name: 'bash', argsRaw: JSON.stringify({ target: TARGET }) },
    }))).toBeUndefined()
  })

  it('returns undefined for a running browser_create with no target yet', () => {
    const running: RunningToolCall = {
      callId: 'create-1',
      name: 'browser_create',
      argsRaw: '{"profile":"temporary"}',
      turn: 1,
      step: 0,
      time: 1_000,
      callView: null,
      subCalls: [],
    }
    expect(browserTabIdentityFromTool(running)).toBeUndefined()
  })

  it('reads a complete target from running browser_navigate args', () => {
    const running: RunningToolCall = {
      callId: 'nav-running',
      name: 'browser_navigate',
      argsRaw: JSON.stringify({ target: TARGET, url: 'https://example.test/' }),
      turn: 1,
      step: 0,
      time: 1_000,
      callView: null,
      subCalls: [],
    }
    expect(browserTabIdentityFromTool(running)).toEqual(TARGET)
  })

  it('reads top-level identities when the payload has no nested target', () => {
    expect(browserTabIdentityFromTool(navigateResult({
      call: { name: 'browser_navigate', argsRaw: JSON.stringify(TARGET) },
    }))).toEqual(TARGET)
  })

  it('ignores incomplete identities, non-objects, and non-JSON text', () => {
    const empty = { content: [] as ToolResultNode['content'] }
    expect(browserTabIdentityFromTool(navigateResult({
      call: { name: 'browser_navigate', argsRaw: 'not-json' },
      content: [{ type: 'text', text: 'still-not-json' }],
    }))).toBeUndefined()
    expect(browserTabIdentityFromTool(navigateResult({
      call: { name: 'browser_navigate', argsRaw: 'null' },
      content: [{ type: 'reasoning', text: 'no target' }],
    }))).toBeUndefined()
    expect(browserTabIdentityFromTool(navigateResult({
      call: { name: 'browser_navigate', argsRaw: JSON.stringify({ target: 'nope' }) },
      ...empty,
    }))).toBeUndefined()
    expect(browserTabIdentityFromTool(navigateResult({
      call: {
        name: 'browser_navigate',
        argsRaw: JSON.stringify({
          profileId: '',
          workspaceId: TARGET.workspaceId,
          browserId: TARGET.browserId,
          tabId: TARGET.tabId,
        }),
      },
      ...empty,
    }))).toBeUndefined()
    expect(browserTabIdentityFromTool(navigateResult({
      call: {
        name: 'browser_navigate',
        argsRaw: JSON.stringify({
          profileId: TARGET.profileId,
          workspaceId: '',
          browserId: TARGET.browserId,
          tabId: TARGET.tabId,
        }),
      },
      ...empty,
    }))).toBeUndefined()
    expect(browserTabIdentityFromTool(navigateResult({
      call: {
        name: 'browser_navigate',
        argsRaw: JSON.stringify({
          profileId: TARGET.profileId,
          workspaceId: TARGET.workspaceId,
          browserId: '',
          tabId: TARGET.tabId,
        }),
      },
      ...empty,
    }))).toBeUndefined()
    expect(browserTabIdentityFromTool(navigateResult({
      call: {
        name: 'browser_navigate',
        argsRaw: JSON.stringify({
          profileId: TARGET.profileId,
          workspaceId: TARGET.workspaceId,
          browserId: TARGET.browserId,
          tabId: '',
        }),
      },
      ...empty,
    }))).toBeUndefined()
  })

  it('reads the target from a later result text after a non-JSON fragment', () => {
    expect(browserTabIdentityFromTool(navigateResult({
      call: { name: 'browser_create', argsRaw: '{"profile":"temporary"}' },
      content: [
        { type: 'text', text: 'streaming…' },
        { type: 'text', text: JSON.stringify({ target: TARGET, revision: 2 }) },
      ],
    }))).toEqual(TARGET)
  })
})

describe('listedBrowserTabRevision', () => {
  it('returns the listing revision, not the tool-result revision', () => {
    expect(listedBrowserTabRevision(listing(), TARGET)).toBe(LISTED_REVISION)
  })

  it('returns undefined when the tab is absent from the listing', () => {
    expect(listedBrowserTabRevision(listing('other-tab'), TARGET)).toBeUndefined()
    expect(listedBrowserTabRevision(null, TARGET)).toBeUndefined()
    expect(listedBrowserTabRevision(undefined, TARGET)).toBeUndefined()
    expect(listedBrowserTabRevision(7, TARGET)).toBeUndefined()
  })

  it('skips malformed listing rows and illegal revisions', () => {
    expect(listedBrowserTabRevision({ workspaces: { not: 'array' } }, TARGET)).toBeUndefined()
    expect(listedBrowserTabRevision({
      workspaces: [
        null,
        'skip',
        { workspaceId: 'other', profileId: TARGET.profileId, browsers: [] },
        { workspaceId: TARGET.workspaceId, profileId: 'other', browsers: [] },
        { workspaceId: TARGET.workspaceId, profileId: TARGET.profileId },
        { workspaceId: TARGET.workspaceId, profileId: TARGET.profileId, browsers: { not: 'array' } },
        {
          workspaceId: TARGET.workspaceId,
          profileId: TARGET.profileId,
          browsers: [
            null,
            'skip',
            { browserId: 'other', tabs: [] },
            { browserId: TARGET.browserId },
            { browserId: TARGET.browserId, tabs: { not: 'array' } },
            {
              browserId: TARGET.browserId,
              tabs: [
                null,
                'skip',
                { tabId: 'other', revision: 1 },
                { tabId: TARGET.tabId, revision: -1 },
                { tabId: TARGET.tabId, revision: 1.5 },
                { tabId: TARGET.tabId, revision: '7' },
              ],
            },
          ],
        },
      ],
    }, TARGET)).toBeUndefined()
  })
})

describe('focusListedBrowserTab', () => {
  it('calls focus with the listed revision of a browser_navigate target', () => {
    const focus = vi.fn(() => Promise.resolve({ ok: true, value: {} }))
    const root = navigateResult()
    focusListedBrowserTab({
      snapshot: { chat: chatSnapshot(root) } as never,
      listing: listing(),
      callId: root.callId,
      focus,
    })
    expect(findToolCall({ chat: chatSnapshot(root) } as never, root.callId)?.callId).toBe(root.callId)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith(TARGET, LISTED_REVISION)
    expect(focus).not.toHaveBeenCalledWith(TARGET, 2)
  })

  it('does not call focus when the tab is gone', () => {
    const focus = vi.fn(() => Promise.resolve({ ok: true, value: {} }))
    focusListedBrowserTab({
      snapshot: { chat: chatSnapshot(navigateResult()) } as never,
      listing: listing('gone-tab'),
      callId: 'nav-1',
      focus,
    })
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not call focus for a missing call or absent remote', () => {
    const focus = vi.fn(() => Promise.resolve({ ok: true, value: {} }))
    focusListedBrowserTab({
      snapshot: { chat: chatSnapshot(navigateResult()) } as never,
      listing: listing(),
      callId: undefined,
      focus,
    })
    focusListedBrowserTab({
      snapshot: { chat: chatSnapshot(navigateResult()) } as never,
      listing: listing(),
      callId: 'nav-1',
      focus: undefined,
    })
    focusListedBrowserTab({
      snapshot: { chat: chatSnapshot(navigateResult()) } as never,
      listing: listing(),
      callId: 'missing-call',
      focus,
    })
    expect(focus).not.toHaveBeenCalled()
  })

  it('swallows a rejected focus after details already opened', async () => {
    const focus = vi.fn(() => Promise.reject(new Error('conflict')))
    focusListedBrowserTab({
      snapshot: { chat: chatSnapshot(navigateResult()) } as never,
      listing: listing(),
      callId: 'nav-1',
      focus,
    })
    expect(focus).toHaveBeenCalledWith(TARGET, LISTED_REVISION)
    await expect(focus.mock.results[0]!.value).rejects.toThrow('conflict')
  })
})
