import { describe, expect, it } from 'vitest'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseCompanionWorkspaceId,
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
} from '../src/index.ts'

describe('Encrypted Companion Protocol v4 live projection', () => {
  it('negotiates v4 and round-trips opened-Session observation changes', () => {
    const protocol = currentProtocol()
    expect(protocol.major).toBe(4)
    const operationId = parseCompanionOperationId('observe-session')
    const sessionId = parseCompanionSessionId('session-live')

    for (const message of [
      { type: 'operation', operation: { type: 'observe-session', operationId, sessionId } },
      { type: 'operation', operation: { type: 'observe-session', operationId } },
    ] as const) {
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }
  })

  it('round-trips bounded hidden summaries and opened conversation replacements', () => {
    const protocol = currentProtocol()
    const sessionId = parseCompanionSessionId('session-live')
    const workspaceId = parseCompanionWorkspaceId('workspace-live')
    const summary = {
      sessionId,
      displayTitle: 'Live delivery',
      cwd: '/work/live',
      running: true,
      blank: false,
      updatedAt: 42,
      pendingInteraction: 'question' as const,
    }
    const hidden = {
      type: 'projection',
      projection: {
        type: 'session-live', generation: 2, desktopRevision: 8,
        sessionId, position: 3, summary,
        workspaces: [{
          workspaceId, path: '/work/live', title: 'Live', sessionIds: [sessionId],
          createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
        }],
      },
    } as const
    const opened = {
      type: 'projection',
      projection: {
        ...hidden.projection,
        desktopRevision: 9,
        conversation: {
          sessionId,
          nodes: [], turnTimings: [], turnEnds: [], partial: {
            turn: 1, step: 1, blocks: [{ kind: 'text', text: 'streaming output' }],
          },
          runningCalls: [], pending: [], queue: [], running: true, subagent: null,
          composerPhase: 'active', removed: false, openState: 'open', openError: null,
          hasMore: false, loadingOlder: false, promptError: null, blank: false,
          lastAgentError: null,
        },
      },
    } as const

    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, hidden))).toEqual(hidden)
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, opened))).toEqual(opened)
  })

  it('round-trips an authoritative Session removal without stale summary content', () => {
    const protocol = currentProtocol()
    const removed = {
      type: 'projection',
      projection: {
        type: 'session-live', generation: 2, desktopRevision: 10,
        sessionId: parseCompanionSessionId('session-removed'), removed: true,
      },
    } as const
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, removed))).toEqual(removed)
  })

  it('rejects v4-only observation and live projection values under v3', () => {
    const protocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile', [3]),
      createCompanionVersionOffer('desktop', [3]),
    )
    const operation = {
      type: 'operation',
      operation: {
        type: 'observe-session', operationId: parseCompanionOperationId('observe-v3'),
        sessionId: parseCompanionSessionId('session-v3'),
      },
    } as const
    expect(() => encodeCompanionMessage(protocol, operation)).toThrow(RemoteProtocolError)
    expect(() => decodeRaw(protocol, { type: 'operation', operation: operation.operation }, 3))
      .toThrow(RemoteProtocolError)
    expect(() => decodeRaw(protocol, {
      type: 'projection', projection: liveProjection({}),
    }, 3)).toThrow(RemoteProtocolError)
  })

  it.each([
    {
      name: 'negative position',
      projection: liveProjection({ position: -1 }),
    },
    {
      name: 'summary identity mismatch',
      projection: liveProjection({ summary: {
        ...summary(), sessionId: 'another-session',
      } }),
    },
    {
      name: 'removal mixed with retained fields',
      projection: liveProjection({ removed: true }),
    },
  ])('rejects hostile live projection: $name', ({ projection }) => {
    const protocol = currentProtocol()
    expect(() => decodeRaw(protocol, { type: 'projection', projection })).toThrow(RemoteProtocolError)
  })

  it.each([
    ['false removal', { type: 'session-live', generation: 1, desktopRevision: 2, sessionId: 'session-live', removed: false }],
    ['non-array workspaces', liveProjection({ workspaces: null })],
    ['too many workspaces', liveProjection({ workspaces: Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.surfaceWorkspaceRows + 1 },
      (_, index) => workspace({ workspaceId: `workspace-${String(index)}` }),
    ) })],
    ['empty Workspace membership', liveProjection({ workspaces: [workspace({ sessionIds: [] })] })],
    ['duplicate Workspace identity', liveProjection({ workspaces: [workspace({}), workspace({})] })],
    ['non-string summary title', liveProjection({ summary: summary({ displayTitle: null }) })],
    ['blank summary title', liveProjection({ summary: summary({ displayTitle: '  ' }) })],
    ['non-string summary cwd', liveProjection({ summary: summary({ cwd: 7 }) })],
    ['non-boolean summary running', liveProjection({ summary: summary({ running: 'yes' }) })],
    ['non-boolean summary blank', liveProjection({ summary: summary({ blank: 'no' }) })],
    ['non-string Workspace field', liveProjection({ workspaces: [workspace({ path: 7 })] })],
    ['empty Workspace field', liveProjection({ workspaces: [workspace({ title: '' })] })],
    ['non-array Workspace membership', liveProjection({ workspaces: [workspace({ sessionIds: null })] })],
    ['oversized Workspace membership', liveProjection({ workspaces: [workspace({
      sessionIds: Array.from({ length: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows + 1 }, () => 'session-live'),
    })] })],
    ['duplicate Workspace membership', liveProjection({
      workspaces: [workspace({ sessionIds: ['session-live', 'session-live'] })],
    })],
    ['foreign Workspace membership', liveProjection({ workspaces: [workspace({ sessionIds: ['session-other'] })] })],
  ] as const)('rejects malformed live replacement: %s', (_name, projection) => {
    expect(() => decodeRaw(currentProtocol(), { type: 'projection', projection })).toThrow(RemoteProtocolError)
  })

  it('accepts every terminal mutation variant inside a status result', () => {
    const protocol = currentProtocol()
    const operationId = parseCompanionOperationId('status-live')
    for (const committed of [
      {
        type: 'operation-failed', operationId,
        failure: { kind: 'business', code: 'LIVE_FAILED', message: 'Live projection failed' },
      },
      { type: 'interaction-receipt', operationId, accepted: true },
    ] as const) {
      const message = { type: 'result', result: { type: 'status', operationId, committed } } as const
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }
  })

  it('retains conversation replacement cursors independently from live projection', () => {
    const protocol = currentProtocol()
    for (const projection of [
      {
        type: 'conversation-snapshot', operationId: parseCompanionOperationId('history-tail'),
        generation: 1, desktopRevision: 2, sessionId: parseCompanionSessionId('session-live'), conversation: {},
      },
      {
        type: 'conversation-snapshot', operationId: parseCompanionOperationId('history-older'),
        generation: 1, desktopRevision: 3, sessionId: parseCompanionSessionId('session-live'),
        beforeSeq: 4, conversation: {},
      },
    ] as const) {
      const message = { type: 'projection', projection } as const
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }
  })
})

function currentProtocol() {
  return negotiateCompanionProtocol(
    createCompanionNegotiationChannel(),
    createCompanionVersionOffer('mobile'),
    createCompanionVersionOffer('desktop'),
  )
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-live', displayTitle: 'Live', running: false,
    blank: false, updatedAt: 1,
    ...overrides,
  }
}

function workspace(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceId: 'workspace-live', path: '/work/live', title: 'Live', sessionIds: ['session-live'],
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  }
}

function liveProjection(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'session-live', generation: 1, desktopRevision: 2,
    sessionId: 'session-live', position: 0, summary: summary(), workspaces: [],
    ...overrides,
  }
}

function decodeRaw(
  protocol: ReturnType<typeof currentProtocol>,
  message: Record<string, unknown>,
  applicationVersion = 4,
) {
  return decodeCompanionMessage(protocol, new TextEncoder().encode(JSON.stringify({
    applicationVersion,
    ...message,
  })))
}
