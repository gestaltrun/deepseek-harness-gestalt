import { describe, expect, it, vi } from 'vitest'
import {
  parseCompanionOperationId, parseCompanionSessionId, parseRelayCredential, parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime, companionMayMutate } from '../src/companion-lifecycle.ts'
import { MobileNoiseCompanionReceiver } from '../src/noise-companion.ts'
import {
  parseMobileConversationProjection, type MobileCompanionProjectionDto,
} from '../src/companion-projection.ts'

describe('Mobile Noise Companion receiver', () => {
  it('grants mutation authority only after authenticated generation-matching synchronization', () => {
    const runtime = connectedRuntime()
    const open = vi.fn(() => ({
      type: 'projection' as const,
      projection: { type: 'foreground-sync' as const, desktopName: 'Authenticated Desktop', generation: 2, desktopRevision: 7 },
    }))
    const receiver = new MobileNoiseCompanionReceiver({ open }, 2, runtime)

    expect(companionMayMutate(runtime.getState())).toBe(false)
    expect(receiver.receive(Uint8Array.of(9))).toMatchObject({ projection: { desktopRevision: 7 } })
    expect(companionMayMutate(runtime.getState())).toBe(true)
  })

  it('rejects another generation and never promotes an undecodable byte', () => {
    const runtime = connectedRuntime()
    const stale = new MobileNoiseCompanionReceiver({
      open: () => ({
        type: 'projection',
        projection: { type: 'foreground-sync', desktopName: 'Authenticated Desktop', generation: 1, desktopRevision: 7 },
      }),
    }, 2, runtime)
    expect(() => stale.receive(Uint8Array.of(9))).toThrow('another connection generation')
    expect(companionMayMutate(runtime.getState())).toBe(false)

    const invalid = new MobileNoiseCompanionReceiver({
      open: () => { throw new Error('Companion message is not valid protocol JSON') },
    }, 2, runtime)
    expect(() => invalid.receive(Uint8Array.of(1))).toThrow('not valid protocol JSON')
    expect(companionMayMutate(runtime.getState())).toBe(false)
  })

  it('projects a decoded result only through the generation-bound Mobile surface receiver', () => {
    const runtime = connectedRuntime()
    const result = {
      type: 'session-search' as const,
      operationId: 'search-noise' as never,
      items: [],
      hasMore: false,
    }
    const acceptValidatedCompanionResult = vi.fn()
    const receiver = new MobileNoiseCompanionReceiver({
      open: () => ({ type: 'result', result }),
    }, 2, runtime, () => ({ acceptValidatedCompanionResult }))

    expect(receiver.receive(Uint8Array.of(3))).toEqual({ type: 'result', result })
    expect(acceptValidatedCompanionResult).toHaveBeenCalledWith(result)
    runtime.forgetConnection()
    const missing = new MobileNoiseCompanionReceiver({
      open: () => ({ type: 'result', result }),
    }, 2, runtime, () => undefined)
    expect(() => missing.receive(Uint8Array.of(4))).toThrow('no active Mobile surface')
  })

  it('requests and applies v3 surface and conversation projections on the synchronized receiver', () => {
    const runtime = connectedRuntime()
    const acceptValidatedDesktopResync = vi.fn((_message: MobileCompanionProjectionDto) => {})
    const acceptValidatedCompanionProjection = vi.fn(() => true)
    const refreshSurface = vi.fn()
    const messages = [
      {
        type: 'projection' as const,
        projection: {
          type: 'foreground-sync' as const, desktopName: 'Authenticated Desktop',
          generation: 2, desktopRevision: 7,
        },
      },
      {
        type: 'projection' as const,
        projection: {
          type: 'surface-snapshot' as const, operationId: 'surface-v3' as never,
          generation: 2, desktopRevision: 7, desktopName: 'Authenticated Desktop', offset: 0, hasMore: false,
          sessions: [{
            sessionId: 'session-v3' as never, displayTitle: 'Real session', running: false,
            blank: false, updatedAt: 1,
          }],
          workspaces: [],
        },
      },
      {
        type: 'projection' as const,
        projection: {
          type: 'conversation-snapshot' as const, operationId: parseCompanionOperationId('history-v3'),
          generation: 2, desktopRevision: 7, sessionId: parseCompanionSessionId('session-v3'),
          conversation: {
            sessionId: 'session-v3', nodes: [{ kind: 'user', seq: 5, time: 5, content: [], source: {} }], turnTimings: [], turnEnds: [], partial: null,
            runningCalls: [], pending: [], queue: [], running: false, subagent: null,
            composerPhase: 'active', removed: false, openState: 'open', openError: null,
            hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
          },
        },
      },
      {
        type: 'projection' as const,
        projection: {
          type: 'conversation-snapshot' as const, operationId: parseCompanionOperationId('history-older-v3'),
          generation: 2, desktopRevision: 7, sessionId: parseCompanionSessionId('session-v3'), beforeSeq: 5,
          conversation: {
            sessionId: 'session-v3', nodes: [{ kind: 'user', seq: 2, time: 2, content: [], source: {} }],
            turnTimings: [], turnEnds: [], partial: null, runningCalls: [], pending: [], queue: [], running: false,
            subagent: null, composerPhase: 'active', removed: false, openState: 'open', openError: null,
            hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
          },
        },
      },
    ]
    const receiver = new MobileNoiseCompanionReceiver(
      { open: () => messages.shift()! }, 2, runtime, undefined,
      () => ({ acceptValidatedDesktopResync, acceptValidatedCompanionProjection }), refreshSurface,
    )
    receiver.receive(Uint8Array.of(1))
    receiver.receive(Uint8Array.of(2))
    receiver.receive(Uint8Array.of(3))
    receiver.receive(Uint8Array.of(4))
    expect(refreshSurface).toHaveBeenCalledOnce()
    expect(refreshSurface).toHaveBeenCalledWith(0)
    const resync = acceptValidatedDesktopResync.mock.lastCall?.[0]
    expect(resync?.desktopName).toBe('Authenticated Desktop')
    expect(resync?.sessions.ids).toEqual(['session-v3'])
    expect(resync?.conversations.map(conversation => conversation.sessionId)).toEqual(['session-v3'])
    expect(resync?.conversations[0]?.nodes.map(node => node.seq)).toEqual([2, 5])
    expect(acceptValidatedCompanionProjection).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'surface-snapshot', operationId: 'surface-v3',
    }))
    expect(acceptValidatedCompanionProjection).toHaveBeenCalledWith(expect.objectContaining({
      type: 'conversation-snapshot', operationId: 'history-older-v3', sessionId: 'session-v3', beforeSeq: 5,
    }))
  })

  it('normalizes an authenticated future conversation node through the unknown presentation arm', () => {
    const runtime = connectedRuntime()
    const acceptValidatedDesktopResync = vi.fn((_message: MobileCompanionProjectionDto) => {})
    const messages = [
      foregroundSync(),
      conversationPage({
        ...validConversation(),
        nodes: [{ kind: 'future-card', seq: 5, time: 10, payload: { label: 'Future' } }],
      }),
    ]
    const receiver = new MobileNoiseCompanionReceiver(
      { open: () => messages.shift()! }, 2, runtime, undefined,
      () => ({ acceptValidatedDesktopResync, acceptValidatedCompanionProjection: () => true }),
    )

    receiver.receive(Uint8Array.of(1))
    receiver.receive(Uint8Array.of(2))

    expect(acceptValidatedDesktopResync.mock.lastCall?.[0].conversations[0]?.nodes).toEqual([{
      kind: 'unknown', seq: 5, time: 10, type: 'future-card',
      data: { kind: 'future-card', seq: 5, time: 10, payload: { label: 'Future' } },
    }])
  })

  it.each([
    ['node content', { ...validConversation(), nodes: [{ kind: 'user', seq: 5, time: 10, content: null, source: null }] }],
    ['tool presentation intent', {
      ...validConversation(),
      nodes: [{
        kind: 'tool-result', seq: 5, time: 10, callId: 'call-invalid', call: null, callTime: null,
        content: [], isError: false, callView: {
          card: 'diff', title: 'Edit file', diffs: [{ path: 7, oldText: null, newText: 'new' }],
        },
        resultView: null, subCalls: [],
      }],
    }],
    ['pending interaction', {
      ...validConversation(),
      pending: [{ kind: 'approval', interactionId: 'approval-invalid', sessionId: 'session-v3', payload: { toolName: 'write' } }],
    }],
  ])('rejects invalid authenticated conversation %s before publishing it', (_label, conversation) => {
    const runtime = connectedRuntime()
    const acceptValidatedDesktopResync = vi.fn((_message: MobileCompanionProjectionDto) => {})
    const messages = [foregroundSync(), conversationPage(conversation)]
    const receiver = new MobileNoiseCompanionReceiver(
      { open: () => messages.shift()! }, 2, runtime, undefined,
      () => ({ acceptValidatedDesktopResync, acceptValidatedCompanionProjection: () => true }),
    )

    receiver.receive(Uint8Array.of(1))
    expect(() => receiver.receive(Uint8Array.of(2))).toThrow('Authenticated Companion conversation projection is invalid')
    expect(acceptValidatedDesktopResync).toHaveBeenCalledOnce()
    expect(acceptValidatedDesktopResync.mock.lastCall?.[0].conversations).toEqual([])
  })

  it.each([
    ['generic call', { card: 'generic', title: 'Read file', kind: 'read', rawInput: { path: 'a.ts' }, content: [{ type: 'text', text: 'Reading' }], locations: [{ path: 'a.ts', line: 1 }] }, null],
    ['terminal call', { card: 'terminal', title: 'pnpm test', description: 'Run tests', cwd: '/work' }, null],
    ['diff call', { card: 'diff', title: 'Edit file', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }], locations: [{ path: 'a.ts' }] }, null],
    ['generic result', null, { card: 'generic', title: 'Done', content: [{ type: 'text', text: 'Done' }] }],
    ['terminal result', null, { card: 'terminal', title: 'Done', output: 'ok', exitCode: 0 }],
    ['diff result', null, { card: 'diff', title: 'Edited', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] }],
    ['matches result', null, { card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'match' }] }], truncated: false, total: 1 }],
    ['paths result', null, { card: 'search', shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 }],
    ['read result', null, { card: 'read', path: 'a.ts', offset: 1, lines: [{ number: 1, text: 'line' }], totalLines: 1, lang: 'ts', content: [{ type: 'text', text: 'line' }] }],
    ['web search result', null, { card: 'web', kind: 'search', sources: [{ url: 'https://example.test', title: 'Example' }], answer: 'Answer', truncated: false }],
    ['web fetch result', null, { card: 'web', kind: 'fetch', url: 'https://example.test', statusCode: 200, truncated: false }],
    ['future cards', { card: 'chart', series: [1] }, { card: 'timeline', entries: [] }],
  ])('accepts structurally valid %s presentation intents', (_label, callView, resultView) => {
    expect(() => parseMobileConversationProjection({
      ...validConversation(), nodes: [toolResultNode(callView, resultView)],
    })).not.toThrow()
  })

  it.each([
    ['generic call', { card: 'generic' }, null],
    ['terminal call', { card: 'terminal', title: 7 }, null],
    ['diff call', { card: 'diff', title: 'Edit file', diffs: null }, null],
    ['generic result', null, { card: 'generic', content: [{ type: 'text' }] }],
    ['terminal result', null, { card: 'terminal', output: 7 }],
    ['diff result', null, { card: 'diff' }],
    ['search result', null, { card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: '1', line: 'match' }] }], truncated: false, total: 1 }],
    ['read result', null, { card: 'read', offset: 1, lines: [], totalLines: 0 }],
    ['web result', null, { card: 'web', kind: 'fetch', url: 'https://example.test', statusCode: '200', truncated: false }],
  ])('rejects structurally invalid %s presentation intents', (_label, callView, resultView) => {
    expect(() => parseMobileConversationProjection({
      ...validConversation(), nodes: [toolResultNode(callView, resultView)],
    })).toThrow('Authenticated Companion conversation projection is invalid')
  })

  it('loads every contiguous surface page and merges Workspace membership', () => {
    const runtime = connectedRuntime()
    const acceptValidatedDesktopResync = vi.fn((_message: MobileCompanionProjectionDto) => {})
    const refreshSurface = vi.fn()
    const messages = [
      {
        type: 'projection' as const,
        projection: {
          type: 'foreground-sync' as const,
          desktopName: 'Paged Desktop', generation: 2, desktopRevision: 7,
        },
      },
      surfacePage(0, 'session-first', true),
      surfacePage(1, 'session-second', false),
    ]
    const receiver = new MobileNoiseCompanionReceiver(
      { open: () => messages.shift()! }, 2, runtime, undefined,
      () => ({ acceptValidatedDesktopResync, acceptValidatedCompanionProjection: vi.fn(() => true) }),
      refreshSurface,
    )

    receiver.receive(Uint8Array.of(1))
    receiver.receive(Uint8Array.of(2))
    receiver.receive(Uint8Array.of(3))

    expect(refreshSurface.mock.calls).toEqual([[0], [1]])
    const resync = acceptValidatedDesktopResync.mock.lastCall?.[0]
    expect(resync?.sessions.ids).toEqual(['session-first', 'session-second'])
    expect(resync?.workspaces[0]?.sessionIds).toEqual(['session-first', 'session-second'])
  })

  it('drops an older page before a replacement baseline mutates aggregate state', () => {
    const runtime = connectedRuntime()
    const acceptValidatedDesktopResync = vi.fn((_message: MobileCompanionProjectionDto) => {})
    let expected = 'scan-a-0'
    const acceptValidatedCompanionProjection = vi.fn((projection: { operationId: string }) => (
      projection.operationId === expected
    ))
    const refreshSurface = vi.fn()
    const messages = [
      {
        type: 'projection' as const,
        projection: {
          type: 'foreground-sync' as const,
          desktopName: 'Paged Desktop', generation: 2, desktopRevision: 7,
        },
      },
      surfacePage(0, 'scan-a-first', true, 'scan-a-0'),
      surfacePage(1, 'scan-a-second', true, 'scan-a-1'),
      surfacePage(0, 'scan-b-first', true, 'scan-b-0'),
      surfacePage(2, 'scan-a-stale', false, 'scan-a-2'),
      surfacePage(1, 'scan-b-second', false, 'scan-b-1'),
    ]
    const receiver = new MobileNoiseCompanionReceiver(
      { open: () => messages.shift()! }, 2, runtime, undefined,
      () => ({ acceptValidatedDesktopResync, acceptValidatedCompanionProjection }),
      refreshSurface,
    )

    receiver.receive(Uint8Array.of(1))
    receiver.receive(Uint8Array.of(2))
    expected = 'scan-a-1'
    receiver.receive(Uint8Array.of(3))
    expected = 'scan-b-0'
    receiver.receive(Uint8Array.of(4))
    expected = 'scan-b-1'
    receiver.receive(Uint8Array.of(5))
    receiver.receive(Uint8Array.of(6))

    const resync = acceptValidatedDesktopResync.mock.lastCall?.[0]
    expect(resync?.sessions.ids).toEqual(['scan-b-first', 'scan-b-second'])
    expect(resync?.workspaces[0]?.sessionIds).toEqual(['scan-b-first', 'scan-b-second'])
    expect(refreshSurface.mock.calls).toEqual([[0], [1], [2], [1]])
  })
})

function surfacePage(offset: number, sessionId: string, hasMore: boolean, operationId = `surface-${String(offset)}`) {
  return {
    type: 'projection' as const,
    projection: {
      type: 'surface-snapshot' as const,
      operationId: parseCompanionOperationId(operationId),
      generation: 2,
      desktopRevision: 7,
      desktopName: 'Paged Desktop',
      offset,
      hasMore,
      sessions: [{
        sessionId: parseCompanionSessionId(sessionId),
        displayTitle: sessionId,
        running: false,
        blank: false,
        updatedAt: offset,
      }],
      workspaces: [{
        workspaceId: 'workspace-paged',
        path: '/work',
        title: 'Work',
        sessionIds: [parseCompanionSessionId(sessionId)],
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      }],
    },
  }
}

function foregroundSync() {
  return {
    type: 'projection' as const,
    projection: {
      type: 'foreground-sync' as const,
      desktopName: 'Authenticated Desktop', generation: 2, desktopRevision: 7,
    },
  }
}

function conversationPage(conversation: unknown) {
  return {
    type: 'projection' as const,
    projection: {
      type: 'conversation-snapshot' as const,
      operationId: parseCompanionOperationId('history-v3'),
      generation: 2,
      desktopRevision: 7,
      sessionId: parseCompanionSessionId('session-v3'),
      conversation,
    },
  }
}

function validConversation() {
  return {
    sessionId: 'session-v3', nodes: [], turnTimings: [], turnEnds: [], partial: null,
    runningCalls: [], pending: [], queue: [], running: false, subagent: null,
    composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
  }
}

function toolResultNode(callView: unknown, resultView: unknown) {
  return {
    kind: 'tool-result', seq: 5, time: 10, callId: 'call-one', call: null, callTime: null,
    content: [], isError: false, callView, resultView, subCalls: [],
  }
}

function connectedRuntime(): CompanionForegroundRuntime {
  const runtime = new CompanionForegroundRuntime()
  runtime.configure({
    endpoint: 'mobile',
    routeId: parseRelayRouteId('route-one'),
    credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    revision: 1,
  })
  runtime.markConnectionOpen()
  return runtime
}
