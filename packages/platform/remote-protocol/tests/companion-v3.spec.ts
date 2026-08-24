import { describe, expect, it } from 'vitest'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionInteractionId,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseCompanionWorkspaceId,
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
} from '../src/index.ts'

describe('Encrypted Companion Protocol v3 product surface', () => {
  it('negotiates v3 and round-trips typed surface and history requests', () => {
    const protocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile', [3]),
      createCompanionVersionOffer('desktop', [3]),
    )
    expect(protocol.major).toBe(3)
    const operationId = parseCompanionOperationId('surface-1')
    const sessionId = parseCompanionSessionId('session-1')
    for (const message of [
      { type: 'operation', operation: { type: 'refresh-surface', operationId, offset: 0 } },
      { type: 'operation', operation: { type: 'load-history', operationId, sessionId, maxMessages: 20 } },
      { type: 'operation', operation: { type: 'load-history', operationId, sessionId, beforeSeq: 41, maxMessages: 20 } },
      { type: 'operation', operation: { type: 'cancel-session', operationId, sessionId } },
      { type: 'operation', operation: {
        type: 'read-image', operationId, sessionId, attachmentId: `sha256:${'b'.repeat(64)}`,
      } },
    ] as const) {
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }
  })

  it('round-trips approval and Ask User settlement without exposing Host rpc ids', () => {
    const protocol = currentProtocol()
    const operationId = parseCompanionOperationId('settle-1')
    const sessionId = parseCompanionSessionId('session-1')
    const interactionId = parseCompanionInteractionId('interaction-1')
    const approval = {
      type: 'operation',
      operation: {
        type: 'settle-interaction', operationId, sessionId, interactionId,
        settlement: { kind: 'approval', outcome: 'allowed-once' },
      },
    } as const
    const question = {
      type: 'operation',
      operation: {
        type: 'settle-interaction', operationId, sessionId, interactionId,
        settlement: {
          kind: 'question', answers: [{ id: 'choice', selected: ['A'], custom: 'details' }],
        },
      },
    } as const
    for (const message of [approval, question]) {
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }
  })

  it('round-trips a bounded shared surface projection and image byte chunks', () => {
    const protocol = currentProtocol()
    const operationId = parseCompanionOperationId('surface-1')
    const sessionId = parseCompanionSessionId('session-1')
    const surface = {
      type: 'projection',
      projection: {
        type: 'surface-snapshot', operationId, generation: 2, desktopRevision: 7,
        desktopName: 'Studio Mac', offset: 0, hasMore: false,
        sessions: [{
          sessionId, displayTitle: 'Session one', cwd: '/work', running: false,
          blank: false, updatedAt: 123, pendingInteraction: 'approval',
        }],
        workspaces: [{
          workspaceId: parseCompanionWorkspaceId('workspace-1'), path: '/work', title: 'Work', sessionIds: [sessionId],
          createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
        }],
      },
    } as const
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, surface))).toEqual(surface)

    const history = {
      type: 'projection',
      projection: {
        type: 'conversation-snapshot', operationId, sessionId, generation: 2, desktopRevision: 7,
        beforeSeq: 41, conversation: { sessionId, nodes: [], hasMore: false },
      },
    } as const
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, history))).toEqual(history)

    const image = {
      type: 'result',
      result: {
        type: 'image-chunk', operationId, sessionId, mediaType: 'image/png',
        attachmentId: `sha256:${'b'.repeat(64)}`, index: 0, count: 1,
        sha256: 'a'.repeat(64), data: 'AAEC',
      },
    } as const
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, image))).toEqual(image)
  })

  it('enforces exact fields and product limits on hostile v3 input', () => {
    const protocol = currentProtocol()
    const applicationVersion = 3
    const operationId = 'operation-1'
    const sessionId = 'session-1'
    for (const value of [
      {
        applicationVersion, type: 'operation', operation: {
          type: 'submit-prompt', operationId, sessionId,
          text: 'x'.repeat(REMOTE_PROTOCOL_LIMITS.promptTextBytes + 1),
        },
      },
      {
        applicationVersion, type: 'operation', operation: {
          type: 'load-history', operationId, sessionId,
          maxMessages: REMOTE_PROTOCOL_LIMITS.historyPageMessages + 1,
        },
      },
      {
        applicationVersion, type: 'operation', operation: {
          type: 'cancel-session', operationId, sessionId, bearer: 'forbidden',
        },
      },
      {
        applicationVersion, type: 'result', result: {
          type: 'image-chunk', operationId, sessionId, mediaType: 'image/png',
          attachmentId: 'image-1', index: 1, count: 1,
          sha256: 'a'.repeat(64), data: 'AAEC',
        },
      },
    ]) {
      expect(() => decodeCompanionMessage(protocol, new TextEncoder().encode(JSON.stringify(value)))).toThrow(RemoteProtocolError)
    }
  })

  it('round-trips rejection receipts, cancellation, and every pending-interaction label', () => {
    const protocol = currentProtocol()
    const operationId = parseCompanionOperationId('branches-operation')
    const sessionId = parseCompanionSessionId('branches-session')
    for (const result of [
      { type: 'interaction-receipt', operationId, accepted: true },
      { type: 'interaction-receipt', operationId, accepted: false, reason: 'not-pending' },
      { type: 'interaction-receipt', operationId, accepted: false, reason: 'bad-response' },
    ] as const) {
      const message = { type: 'result', result } as const
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }
    const cancellation = {
      type: 'operation',
      operation: {
        type: 'settle-interaction', operationId, sessionId,
        interactionId: parseCompanionInteractionId('branches-interaction'),
        settlement: { kind: 'question-cancelled' },
      },
    } as const
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, cancellation))).toEqual(cancellation)
    for (const pendingInteraction of [undefined, 'plan-review', 'question'] as const) {
      const message = surfaceMessage({ pendingInteraction })
      const decoded = decodeRaw(protocol, message)
      if (decoded.type !== 'projection' || decoded.projection.type !== 'surface-snapshot') {
        throw new Error('expected surface snapshot')
      }
      expect(decoded.projection.sessions[0]?.pendingInteraction).toBe(pendingInteraction)
    }
  })

  it.each(hostileV3Cases())('rejects hostile v3 field case $name', ({ message }) => {
    expect(() => decodeRaw(currentProtocol(), message)).toThrow(RemoteProtocolError)
  })
})

function hostileV3Cases(): Array<{ name: string; message: Record<string, unknown> }> {
  const operationId = 'hostile-operation'
  const sessionId = 'hostile-session'
  const interactionId = 'hostile-interaction'
  const image = (overrides: Record<string, unknown>) => rawResult({
    type: 'image-chunk', operationId, sessionId, mediaType: 'image/png',
    attachmentId: `sha256:${'b'.repeat(64)}`, index: 0, count: 1,
    sha256: 'a'.repeat(64), data: 'AAEC', ...overrides,
  })
  const settlement = (value: unknown) => rawOperation({
    type: 'settle-interaction', operationId, sessionId, interactionId, settlement: value,
  })
  const question = (answers: unknown) => settlement({ kind: 'question', answers })
  const answer = (overrides: Record<string, unknown> = {}) => ({ id: 'choice', selected: ['A'], ...overrides })
  return [
    { name: 'image chunk count ceiling', message: image({ count: REMOTE_PROTOCOL_LIMITS.imageChunks + 1 }) },
    { name: 'image sha256', message: image({ sha256: 'A'.repeat(64) }) },
    { name: 'image mediaType type', message: image({ mediaType: 1 }) },
    { name: 'image mediaType syntax', message: image({ mediaType: 'not-a-media-type' }) },
    {
      name: 'image mediaType bytes',
      message: image({ mediaType: `image/${'a'.repeat(REMOTE_PROTOCOL_LIMITS.attachmentMediaTypeBytes)}` }),
    },
    { name: 'image attachment id type', message: image({ attachmentId: 1 }) },
    { name: 'image attachment id digest', message: image({ attachmentId: 'image-not-content-addressed' }) },
    { name: 'image negative index', message: image({ index: -1 }) },
    { name: 'image fractional index', message: image({ index: 0.5 }) },
    {
      name: 'interaction receipt accepted flag',
      message: rawResult({ type: 'interaction-receipt', operationId, accepted: 'yes', reason: 'not-pending' }),
    },
    {
      name: 'interaction receipt reason',
      message: rawResult({ type: 'interaction-receipt', operationId, accepted: false, reason: 'later' }),
    },
    { name: 'approval outcome', message: settlement({ kind: 'approval', outcome: 'always' }) },
    { name: 'settlement kind', message: settlement({ kind: 'future' }) },
    { name: 'answers type', message: question('no') },
    { name: 'answers empty', message: question([]) },
    {
      name: 'answers ceiling',
      message: question(Array.from(
        { length: REMOTE_PROTOCOL_LIMITS.interactionQuestions + 1 },
        (_, index) => ({ id: `choice-${String(index)}`, selected: [] }),
      )),
    },
    { name: 'answer duplicate ids', message: question([answer(), answer()]) },
    { name: 'answer selections type', message: question([answer({ selected: 'A' })]) },
    {
      name: 'answer selections ceiling',
      message: question([answer({
        selected: Array.from(
          { length: REMOTE_PROTOCOL_LIMITS.interactionSelections + 1 },
          (_, index) => `choice-${String(index)}`,
        ),
      })]),
    },
    { name: 'answer duplicate selections', message: question([answer({ selected: ['A', 'A'] })]) },
    { name: 'answer id type', message: question([answer({ id: 1 })]) },
    { name: 'answer id empty', message: question([answer({ id: '' })]) },
    {
      name: 'answer id bytes',
      message: question([answer({ id: 'x'.repeat(REMOTE_PROTOCOL_LIMITS.interactionStringBytes + 1) })]),
    },
    { name: 'answer selected type', message: question([answer({ selected: [1] })]) },
    { name: 'answer custom empty', message: question([answer({ custom: '' })]) },
    { name: 'surface desktopName type', message: surfaceMessage({}, { desktopName: 1 }) },
    { name: 'surface negative offset', message: surfaceMessage({}, { offset: -1 }) },
    { name: 'surface desktopName blank', message: surfaceMessage({}, { desktopName: ' ' }) },
    { name: 'surface desktopName length', message: surfaceMessage({}, { desktopName: 'x'.repeat(129) }) },
    { name: 'surface sessions type', message: surfaceMessage({}, { sessions: {} }) },
    {
      name: 'surface sessions ceiling',
      message: surfaceMessage({}, { sessions: Array.from(
        { length: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows + 1 }, () => surfaceSession(),
      ) }),
    },
    { name: 'surface workspaces type', message: surfaceMessage({}, { workspaces: {} }) },
    {
      name: 'surface workspaces ceiling',
      message: surfaceMessage({}, { workspaces: Array.from(
        { length: REMOTE_PROTOCOL_LIMITS.surfaceWorkspaceRows + 1 }, () => surfaceWorkspace(),
      ) }),
    },
    { name: 'surface hasMore', message: surfaceMessage({}, { hasMore: 'no' }) },
    { name: 'session title', message: surfaceMessage({ displayTitle: ' ' }) },
    { name: 'session cwd', message: surfaceMessage({ cwd: 1 }) },
    { name: 'session running', message: surfaceMessage({ running: 'no' }) },
    { name: 'session blank', message: surfaceMessage({ blank: 'no' }) },
    { name: 'session pending interaction', message: surfaceMessage({ pendingInteraction: 'future' }) },
    { name: 'session negative updatedAt', message: surfaceMessage({ updatedAt: -1 }) },
    { name: 'session fractional updatedAt', message: surfaceMessage({ updatedAt: 1.5 }) },
    {
      name: 'duplicate sessions',
      message: surfaceMessage({}, { sessions: [surfaceSession(), surfaceSession()] }),
    },
    { name: 'workspace path type', message: surfaceMessage({}, {}, { path: 1 }) },
    { name: 'workspace title empty', message: surfaceMessage({}, {}, { title: '' }) },
    { name: 'workspace sessionIds type', message: surfaceMessage({}, {}, { sessionIds: 'session' }) },
    {
      name: 'workspace sessionIds ceiling',
      message: surfaceMessage({}, {}, { sessionIds: Array.from(
        { length: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows + 1 }, (_, index) => `session-${String(index)}`,
      ) }),
    },
    { name: 'workspace duplicate sessionIds', message: surfaceMessage({}, {}, { sessionIds: [sessionId, sessionId] }) },
    { name: 'workspace invisible sessionId', message: surfaceMessage({}, {}, { sessionIds: ['other-session'] }) },
  ]
}

function rawOperation(operation: Record<string, unknown>): Record<string, unknown> {
  return { applicationVersion: 3, type: 'operation', operation }
}

function rawResult(result: Record<string, unknown>): Record<string, unknown> {
  return { applicationVersion: 3, type: 'result', result }
}

function surfaceSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'hostile-session', displayTitle: 'Session', running: false,
    blank: false, updatedAt: 1, ...overrides,
  }
}

function surfaceWorkspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: 'hostile-workspace', path: '/work', title: 'Work', sessionIds: ['hostile-session'],
    createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z', ...overrides,
  }
}

function surfaceMessage(
  sessionOverrides: Record<string, unknown> = {},
  projectionOverrides: Record<string, unknown> = {},
  workspaceOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    applicationVersion: 3,
    type: 'projection',
    projection: {
      type: 'surface-snapshot', operationId: 'hostile-operation', generation: 1, desktopRevision: 1,
      desktopName: 'Desktop', offset: 0, sessions: [surfaceSession(sessionOverrides)],
      workspaces: [surfaceWorkspace(workspaceOverrides)], hasMore: false,
      ...projectionOverrides,
    },
  }
}

function decodeRaw(protocol: ReturnType<typeof currentProtocol>, message: Record<string, unknown>) {
  return decodeCompanionMessage(protocol, new TextEncoder().encode(JSON.stringify(message)))
}

function currentProtocol() {
  return negotiateCompanionProtocol(
    createCompanionNegotiationChannel(),
    createCompanionVersionOffer('mobile', [3]),
    createCompanionVersionOffer('desktop', [3]),
  )
}
