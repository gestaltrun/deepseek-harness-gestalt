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
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
} from '../src/index.ts'

describe('Encrypted Companion Protocol v3 product surface', () => {
  it('negotiates v3 and round-trips typed surface and history requests', () => {
    const protocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    expect(protocol.major).toBe(3)
    const operationId = parseCompanionOperationId('surface-1')
    const sessionId = parseCompanionSessionId('session-1')
    for (const message of [
      { type: 'operation', operation: { type: 'refresh-surface', operationId } },
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
        desktopName: 'Studio Mac', hasMore: false,
        sessions: [{
          sessionId, displayTitle: 'Session one', cwd: '/work', running: false,
          blank: false, updatedAt: 123, pendingInteraction: 'approval',
        }],
        workspaces: [{
          workspaceId: 'workspace-1', path: '/work', title: 'Work', sessionIds: [sessionId],
          createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
        }],
      },
    } as const
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, surface))).toEqual(surface)

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
})

function currentProtocol() {
  return negotiateCompanionProtocol(
    createCompanionNegotiationChannel(),
    createCompanionVersionOffer('mobile'),
    createCompanionVersionOffer('desktop'),
  )
}
