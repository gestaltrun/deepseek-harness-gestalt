import { describe, expect, it } from 'vitest'
import {
  parseAttachmentCapability,
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  decodeCompanionVersionOffer,
  encodeCompanionMessage,
  encodeCompanionVersionOffer,
  negotiateCompanionProtocol,
  parseCompanionInteractionId,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseCompanionTranscriptEntryId,
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
  type CompanionOfferAttachmentOperation,
} from '../src/index.ts'

describe('Encrypted Companion Protocol codec', () => {
  it('negotiates the current major before round-tripping an approved operation and Desktop-confirmed result', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile', [1, 2]),
      createCompanionVersionOffer('desktop', [1, 2]),
    )
    expect(negotiated.major).toBe(2)

    const operationId = parseCompanionOperationId('operation-keyless')
    const sessionId = parseCompanionSessionId('session-keyless')
    const operation = {
      type: 'operation',
      operation: {
        type: 'submit-prompt',
        operationId,
        sessionId,
        text: 'continue from Mobile',
      },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, operation))).toEqual(operation)

    const result = {
      type: 'result',
      result: {
        type: 'confirmed',
        operationId,
        committedAt: 1_787_027_200_000,
        outcome: 'accepted',
      },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, result))).toEqual(result)
  })

  it('round-trips Session creation with and without a Workspace and rejects empty fields', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const operationId = parseCompanionOperationId('operation-create')
    const sessionId = parseCompanionSessionId('session-create')
    const ungrouped = {
      type: 'operation',
      operation: {
        type: 'create-session',
        operationId,
        sessionId,
        title: 'Ungrouped Session',
      },
    } as const
    const workspace = {
      type: 'operation',
      operation: {
        type: 'create-session',
        operationId,
        sessionId,
        title: 'Workspace Session',
        workspace: 'Work',
      },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, ungrouped))).toEqual(ungrouped)
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, workspace))).toEqual(workspace)
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: { type: 'create-session', operationId, sessionId, title: '' },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: { type: 'create-session', operationId, sessionId, title: 'Work', workspace: '' },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: { type: 'create-session', operationId, sessionId, title: 'Work', extra: true },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
  })

  it('round-trips a prompt cancellation targeting one Session', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const cancel = {
      type: 'operation',
      operation: {
        type: 'cancel-prompt',
        operationId: parseCompanionOperationId('operation-cancel'),
        sessionId: parseCompanionSessionId('session-cancel'),
      },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, cancel))).toEqual(cancel)
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: { type: 'cancel-prompt', operationId: 'operation-cancel' },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
  })

  it('round-trips settle-approval and answer-ask-user operations', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const settle = {
      type: 'operation',
      operation: {
        type: 'settle-approval',
        operationId: parseCompanionOperationId('operation-settle'),
        sessionId: parseCompanionSessionId('session-settle'),
        interactionId: parseCompanionInteractionId('approval-1'),
        decision: 'once',
        persistent: true,
      },
    } as const
    const answer = {
      type: 'operation',
      operation: {
        type: 'answer-ask-user',
        operationId: parseCompanionOperationId('operation-answer'),
        sessionId: parseCompanionSessionId('session-answer'),
        interactionId: parseCompanionInteractionId('question-1'),
        decision: 'A',
      },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, settle))).toEqual(settle)
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, {
      type: 'operation',
      operation: {
        type: 'settle-approval',
        operationId: parseCompanionOperationId('operation-settle-once'),
        sessionId: parseCompanionSessionId('session-settle'),
        interactionId: parseCompanionInteractionId('approval-1'),
        decision: 'once',
      },
    }))).toMatchObject({ operation: { type: 'settle-approval', decision: 'once' } })
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, answer))).toEqual(answer)
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: {
        type: 'settle-approval',
        operationId: 'operation-settle',
        sessionId: 'session-settle',
        interactionId: 'approval-1',
        decision: '',
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: {
        type: 'answer-ask-user',
        operationId: 'operation-answer',
        sessionId: 'session-answer',
        interactionId: 'question-1',
        decision: 'A',
        extra: true,
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
  })

  it('round-trips a reconnect operation-status query and its committed or absent answer', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const operationId = parseCompanionOperationId('operation-uncertain')
    const query = {
      type: 'operation',
      operation: { type: 'query-operation-status', operationId },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, query))).toEqual(query)

    const committed = {
      type: 'result',
      result: {
        type: 'status',
        operationId,
        committed: {
          type: 'confirmed',
          operationId,
          committedAt: 1_787_027_200_000,
          outcome: 'accepted',
        },
      },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, committed))).toEqual(committed)

    const absent = {
      type: 'result',
      result: { type: 'status', operationId, absent: true },
    } as const
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, absent))).toEqual(absent)
  })

  it('rejects forged operation-status answers that misstate the queried operation', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const queried = parseCompanionOperationId('operation-queried')
    const other = parseCompanionOperationId('operation-other')
    const original = {
      type: 'confirmed',
      operationId: other,
      committedAt: 1_787_027_200_000,
      outcome: 'accepted',
    } as const
    const forged = [
      { applicationVersion: 2, type: 'result', result: { type: 'status', operationId: queried, committed: original } },
      { applicationVersion: 2, type: 'result', result: { type: 'status', operationId: queried, absent: false } },
      { applicationVersion: 2, type: 'result', result: { type: 'status', operationId: queried } },
      { applicationVersion: 2, type: 'result', result: { type: 'status', operationId: queried, committed: original, absent: true } },
      { applicationVersion: 2, type: 'result', result: { type: 'status', operationId: queried, committed: { type: 'confirmed', operationId: queried, committedAt: 0, outcome: 'accepted' } } },
    ]
    for (const message of forged) {
      expect(() => decodeCompanionMessage(negotiated, json(message))).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }
  })

  it('negotiates the immediately preceding major only with every required security capability', () => {
    const mobile = decodeCompanionVersionOffer(encodeCompanionVersionOffer(
      createCompanionVersionOffer('mobile', [1]),
    ))
    const desktop = decodeCompanionVersionOffer(encodeCompanionVersionOffer(
      createCompanionVersionOffer('desktop', [2, 1]),
    ))
    expect(negotiateFresh(mobile, desktop).major).toBe(1)

    const weakenedMobile = decodeCompanionVersionOffer(new TextEncoder().encode(JSON.stringify({
      endpoint: 'mobile',
      versions: [{
        major: 1,
        capabilities: ['authenticated-encryption', 'pairing-key-separation'],
      }],
    })))
    expect(() => negotiateFresh(weakenedMobile, desktop)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({
        code: 'COMPANION_SECURITY_CAPABILITY_MISSING',
        updateEndpoint: 'mobile',
      }),
    )
  })

  it('falls back to a safe preceding major when the shared current major loses a security capability', () => {
    const mobile = decodeCompanionVersionOffer(json({
      endpoint: 'mobile',
      versions: [
        {
          major: 2,
          capabilities: ['authenticated-encryption', 'pairing-key-separation'],
        },
        {
          major: 1,
          capabilities: ['authenticated-encryption', 'pairing-key-separation', 'replay-protection'],
        },
      ],
    }))
    const desktop = createCompanionVersionOffer('desktop', [2, 1])

    expect(negotiateFresh(mobile, desktop).major).toBe(1)
  })

  it('identifies the stale endpoint and exposes no application encoder when majors do not overlap', () => {
    const mobile = createCompanionVersionOffer('mobile', [1])
    const desktop = createCompanionVersionOffer('desktop', [2])
    expect(() => negotiateFresh(mobile, desktop)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({
        code: 'COMPANION_UPDATE_REQUIRED',
        updateEndpoint: 'mobile',
      }),
    )
  })

  it('rejects a caller-created object in place of a successful negotiation token', () => {
    const operation = {
      type: 'operation',
      operation: {
        type: 'submit-prompt',
        operationId: parseCompanionOperationId('operation-counterfeit'),
        sessionId: parseCompanionSessionId('session-counterfeit'),
        text: 'must not encode',
      },
    } as const
    expect(() => { Reflect.apply(encodeCompanionMessage, undefined, [{ major: 2 }, operation]) }).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'COMPANION_VERSION_NOT_NEGOTIATED' }),
    )
    for (const counterfeit of [null, 2]) {
      expect(() => { Reflect.apply(encodeCompanionMessage, undefined, [counterfeit, operation]) }).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'COMPANION_VERSION_NOT_NEGOTIATED' }),
      )
    }
  })

  it('invalidates only the renegotiated channel capability before evaluating new offers', () => {
    const firstChannel = createCompanionNegotiationChannel()
    const secondChannel = createCompanionNegotiationChannel()
    const firstProtocol = negotiateCompanionProtocol(
      firstChannel,
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const secondProtocol = negotiateCompanionProtocol(
      secondChannel,
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const operation = {
      type: 'operation' as const,
      operation: {
        type: 'submit-prompt' as const,
        operationId: parseCompanionOperationId('operation-channel'),
        sessionId: parseCompanionSessionId('session-channel'),
        text: 'channel lifetime',
      },
    }

    expect(() => negotiateCompanionProtocol(
      firstChannel,
      createCompanionVersionOffer('mobile', [1]),
      createCompanionVersionOffer('desktop', [2]),
    )).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'COMPANION_UPDATE_REQUIRED' }))
    expect(() => encodeCompanionMessage(firstProtocol, operation)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'COMPANION_VERSION_NOT_NEGOTIATED' }),
    )
    expect(decodeCompanionMessage(
      secondProtocol,
      encodeCompanionMessage(secondProtocol, operation),
    )).toEqual(operation)

    const renewedProtocol = negotiateCompanionProtocol(
      firstChannel,
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    expect(() => encodeCompanionMessage(firstProtocol, operation)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'COMPANION_VERSION_NOT_NEGOTIATED' }),
    )
    expect(decodeCompanionMessage(
      renewedProtocol,
      encodeCompanionMessage(renewedProtocol, operation),
    )).toEqual(operation)
  })

  it('rejects structurally forged negotiation channels', () => {
    expect(() => negotiateCompanionProtocol(
      { type: 'companion-negotiation-channel' },
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({
      code: 'COMPANION_VERSION_NOT_NEGOTIATED',
    }))
  })

  it('round-trips an approved transcript projection and enforces its page ceiling', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const entries = Array.from({ length: REMOTE_PROTOCOL_LIMITS.transcriptPageEntries }, (_, index) => ({
      type: 'text' as const,
      entryId: parseCompanionTranscriptEntryId(`entry-${String(index)}`),
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `entry ${String(index)}`,
    }))
    const projection = {
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: parseCompanionSessionId('session-keyless'),
        entries,
      },
    } as const
    expect(decodeCompanionMessage(
      negotiated,
      encodeCompanionMessage(negotiated, projection),
    )).toEqual(projection)

    const streaming = {
      type: 'projection' as const,
      projection: {
        type: 'transcript-page' as const,
        sessionId: parseCompanionSessionId('session-stream'),
        streaming: true,
        entries: [{
          type: 'text' as const,
          entryId: parseCompanionTranscriptEntryId('entry-stream'),
          role: 'user' as const,
          text: 'in flight',
        }],
      },
    }
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, streaming))).toEqual(streaming)

    const mixed = {
      type: 'projection' as const,
      projection: {
        type: 'transcript-page' as const,
        sessionId: parseCompanionSessionId('session-mixed'),
        entries: [
          {
            type: 'image' as const,
            entryId: parseCompanionTranscriptEntryId('entry-image'),
            fileName: 'shot.png',
            alt: 'shot.png',
          },
          {
            type: 'approval' as const,
            entryId: parseCompanionTranscriptEntryId('entry-approval'),
            interactionId: parseCompanionInteractionId('approval-1'),
            summary: 'Allow Desktop development action',
            authorized: ['once', 'always'],
            cwd: '/tmp',
            settled: { decision: 'once', persistent: false },
          },
          {
            type: 'ask-user' as const,
            entryId: parseCompanionTranscriptEntryId('entry-question'),
            interactionId: parseCompanionInteractionId('question-1'),
            summary: 'Which Desktop path?',
            authorized: ['A', 'B'],
          },
        ],
      },
    }
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, mixed))).toEqual(mixed)
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: 'session-mixed',
        streaming: 'yes',
        entries: [],
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: 'session-mixed',
        entries: [{
          type: 'approval',
          entryId: 'entry-approval',
          interactionId: 'approval-1',
          summary: 'Allow',
          authorized: ['once'],
          settled: { decision: 'always' },
        }],
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: {
        type: 'settle-approval',
        operationId: 'operation-settle',
        sessionId: 'session-settle',
        interactionId: 'approval-1',
        decision: 'once',
        persistent: 'yes',
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    const idle = {
      type: 'projection' as const,
      projection: {
        type: 'transcript-page' as const,
        sessionId: parseCompanionSessionId('session-idle'),
        streaming: false,
        entries: [{
          type: 'approval' as const,
          entryId: parseCompanionTranscriptEntryId('entry-idle-approval'),
          interactionId: parseCompanionInteractionId('approval-idle'),
          summary: 'Allow with extras',
          authorized: ['once'],
          diff: '-old\n+new',
          terminal: 'echo hi',
          settled: { decision: 'once' },
        }, {
          type: 'approval' as const,
          entryId: parseCompanionTranscriptEntryId('entry-minimal-approval'),
          interactionId: parseCompanionInteractionId('approval-minimal'),
          summary: 'Allow without extras',
          authorized: ['once'],
        }, {
          type: 'ask-user' as const,
          entryId: parseCompanionTranscriptEntryId('entry-idle-question'),
          interactionId: parseCompanionInteractionId('question-idle'),
          summary: 'Pick one',
          authorized: ['A'],
          settled: { decision: 'A', persistent: false },
        }],
      },
    }
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, idle))).toEqual(idle)
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: 'session-idle',
        entries: [{
          type: 'approval',
          entryId: 'entry-empty-auth',
          interactionId: 'approval-empty',
          summary: 'Allow',
          authorized: [],
        }],
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: 'session-idle',
        entries: [{
          type: 'approval',
          entryId: 'entry-dup-auth',
          interactionId: 'approval-dup',
          summary: 'Allow',
          authorized: ['once', 'once'],
        }],
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: 'session-idle',
        entries: [{
          type: 'ask-user',
          entryId: 'entry-blank-auth',
          interactionId: 'question-blank',
          summary: 'Pick',
          authorized: [''],
        }],
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: 'session-idle',
        entries: [{
          type: 'approval',
          entryId: 'entry-bad-persistent',
          interactionId: 'approval-bad',
          summary: 'Allow',
          authorized: ['once'],
          settled: { decision: 'once', persistent: 'yes' },
        }],
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId: 'session-idle',
        entries: [{
          type: 'image',
          entryId: 'entry-image-empty',
          fileName: 'shot.png',
          alt: '',
        }],
      },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))

    const oversized = {
      ...projection,
      projection: {
        ...projection.projection,
        entries: [...entries, {
          type: 'text' as const,
          entryId: parseCompanionTranscriptEntryId('entry-over-limit'),
          role: 'assistant' as const,
          text: 'must be rejected',
        }],
      },
    }
    expect(() => encodeCompanionMessage(negotiated, oversized)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
  })

  it('bounds transcript pages at 50 events or 48 KiB of encoded wire bytes', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    expect(REMOTE_PROTOCOL_LIMITS.transcriptPageEntries).toBe(50)
    expect(REMOTE_PROTOCOL_LIMITS.transcriptPageBytes).toBe(48 * 1_024)

    const exactLimit = transcriptPageWithEncodedBytes(negotiated, 50, 48 * 1_024)
    expect(encodeCompanionMessage(negotiated, exactLimit)).toHaveLength(48 * 1_024)
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, exactLimit))).toEqual(exactLimit)

    const tooManyEntries = transcriptPageWithEncodedBytes(negotiated, 51)
    expect(() => encodeCompanionMessage(negotiated, tooManyEntries)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
    expect(() => decodeCompanionMessage(negotiated, json({ applicationVersion: 2, ...tooManyEntries }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )

    const oneByteOverflow = transcriptPageWithEncodedBytes(negotiated, 1, (48 * 1_024) + 1)
    const oneByteOverflowWire = json({ applicationVersion: 2, ...oneByteOverflow })
    expect(oneByteOverflowWire).toHaveLength((48 * 1_024) + 1)
    expect(() => encodeCompanionMessage(negotiated, oneByteOverflow)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
    expect(() => decodeCompanionMessage(negotiated, oneByteOverflowWire)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )

    const multibyteBase = transcriptPageWithEncodedBytes(negotiated, 1)
    expect(decodeCompanionMessage(
      negotiated,
      encodeCompanionMessage(negotiated, multibyteBase),
    )).toEqual(multibyteBase)
    const baseBytes = encodeCompanionMessage(negotiated, multibyteBase).byteLength
    const firstEntry = multibyteBase.projection.entries[0]
    if (firstEntry === undefined) throw new Error('Multibyte transcript fixture requires one entry')
    const multibyteOverflow = {
      ...multibyteBase,
      projection: {
        ...multibyteBase.projection,
        entries: [{
          ...firstEntry,
          text: '界'.repeat(Math.floor(((48 * 1_024) - baseBytes) / 3) + 1),
        }],
      },
    }
    expect(new TextEncoder().encode(JSON.stringify({ applicationVersion: 2, ...multibyteOverflow })).byteLength).toBeGreaterThan(48 * 1_024)
    expect(() => encodeCompanionMessage(negotiated, multibyteOverflow)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
    expect(() => decodeCompanionMessage(negotiated, json({ applicationVersion: 2, ...multibyteOverflow }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
  })

  it('validates version offers before negotiation', () => {
    for (const majors of [[], [1, 1]] as const) {
      expect(() => createCompanionVersionOffer('mobile', majors)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }

    const malformedOffers = [
      null,
      [],
      'offer',
      { endpoint: 'relay', versions: [{ major: 1, capabilities: [] }] },
      { endpoint: 'mobile', versions: null },
      { endpoint: 'mobile', versions: [] },
      { endpoint: 'mobile', versions: [{ major: 1, capabilities: [] }, { major: 1, capabilities: [] }] },
      { endpoint: 'mobile', versions: [null] },
      { endpoint: 'mobile', versions: [{ major: 1, wrong: [] }] },
      { endpoint: 'mobile', versions: [{ major: 0, capabilities: [] }] },
      { endpoint: 'mobile', versions: [{ major: 3, capabilities: [] }] },
      { endpoint: 'mobile', versions: [{ major: 1, capabilities: null }] },
      { endpoint: 'mobile', versions: [{ major: 1, capabilities: ['replay-protection', 'replay-protection'] }] },
      { endpoint: 'mobile', versions: [{ major: 1, capabilities: ['plaintext'] }] },
      { endpoint: 'mobile', versions: [], extra: true },
    ]
    for (const offer of malformedOffers) {
      expect(() => decodeCompanionVersionOffer(json(offer))).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }
    expect(() => { Reflect.apply(encodeCompanionVersionOffer, undefined, [{
      endpoint: 'mobile', versions: [undefined],
    }]) }).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
  })

  it('rejects wrong negotiation roles and identifies either stale endpoint', () => {
    expect(() => negotiateFresh(
      createCompanionVersionOffer('desktop'),
      createCompanionVersionOffer('desktop'),
    )).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('mobile'),
    )).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))

    const weakenedDesktop = decodeCompanionVersionOffer(json({
      endpoint: 'desktop',
      versions: [{ major: 2, capabilities: ['authenticated-encryption', 'pairing-key-separation'] }],
    }))
    expect(() => negotiateFresh(
      createCompanionVersionOffer('mobile', [2]),
      weakenedDesktop,
    )).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({
      code: 'COMPANION_SECURITY_CAPABILITY_MISSING', updateEndpoint: 'desktop',
    }))

    expect(() => negotiateFresh(
      createCompanionVersionOffer('mobile', [2]),
      createCompanionVersionOffer('desktop', [1]),
    )).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({
      code: 'COMPANION_UPDATE_REQUIRED', updateEndpoint: 'desktop',
    }))
  })

  it('rejects unapproved application messages and fields', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const operationId = 'operation'
    const sessionId = 'session'
    const baseOperation = { type: 'submit-prompt', operationId, sessionId, text: 'continue' }
    const malformed = [
      null,
      [],
      'message',
      { applicationVersion: 1, type: 'operation', operation: baseOperation },
      { applicationVersion: 2, type: 'host-request', operation: baseOperation },
      { applicationVersion: 2, type: 'operation', result: baseOperation },
      { applicationVersion: 2, type: 'operation', operation: null },
      { applicationVersion: 2, type: 'operation', operation: { ...baseOperation, type: 'terminal-input' } },
      { applicationVersion: 2, type: 'operation', operation: { ...baseOperation, extra: true } },
      { applicationVersion: 2, type: 'operation', operation: { ...baseOperation, text: '' } },
      { applicationVersion: 2, type: 'operation', operation: { ...baseOperation, text: 1 } },
      { applicationVersion: 2, type: 'result', result: null },
      { applicationVersion: 2, type: 'result', result: { type: 'pending' } },
      { applicationVersion: 2, type: 'result', result: { type: 'confirmed', operationId, committedAt: 1, outcome: 'accepted', extra: true } },
      { applicationVersion: 2, type: 'result', result: { type: 'confirmed', operationId, committedAt: 1, outcome: 'unknown' } },
      { applicationVersion: 2, type: 'result', result: { type: 'confirmed', operationId, committedAt: -1, outcome: 'accepted' } },
      { applicationVersion: 2, type: 'result', result: { type: 'confirmed', operationId, committedAt: 1.5, outcome: 'accepted' } },
      { applicationVersion: 2, type: 'projection', projection: null },
      { applicationVersion: 2, type: 'projection', projection: { type: 'workspace-admin' } },
      { applicationVersion: 2, type: 'projection', projection: { type: 'transcript-page', sessionId, entries: null } },
      { applicationVersion: 2, type: 'projection', projection: { type: 'transcript-page', sessionId, entries: [], extra: true } },
      { applicationVersion: 2, type: 'projection', projection: { type: 'transcript-page', sessionId, entries: [null] } },
      { applicationVersion: 2, type: 'projection', projection: { type: 'transcript-page', sessionId, entries: [{ type: 'tool', entryId: 'entry', role: 'assistant', text: '' }] } },
      { applicationVersion: 2, type: 'projection', projection: { type: 'transcript-page', sessionId, entries: [{ type: 'text', entryId: 'entry', role: 'assistant', text: '', extra: true }] } },
      { applicationVersion: 2, type: 'projection', projection: { type: 'transcript-page', sessionId, entries: [{ type: 'text', entryId: 'entry', role: 'system', text: '' }] } },
      { applicationVersion: 2, type: 'projection', projection: { type: 'transcript-page', sessionId, entries: [{ type: 'text', entryId: 'entry', role: 'user', text: 1 }] } },
    ]
    for (const value of malformed) {
      expect(() => decodeCompanionMessage(negotiated, json(value))).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }

    const oversizedEntries = Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.transcriptPageEntries + 1 },
      (_, index) => ({ type: 'text', entryId: `entry-${String(index)}`, role: 'assistant', text: '' }),
    )
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'projection',
      projection: { type: 'transcript-page', sessionId, entries: oversizedEntries },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }))
  })

  it('enforces Companion message and encoded-value ceilings', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const exactLimit = companionOperationWithEncodedBytes(negotiated, REMOTE_PROTOCOL_LIMITS.companionMessageBytes)
    const exactWire = encodeCompanionMessage(negotiated, exactLimit)
    expect(exactWire).toHaveLength(60 * 1_024)
    expect(decodeCompanionMessage(negotiated, exactWire)).toEqual(exactLimit)

    const oneByteOverflow = companionOperationWithEncodedBytes(
      negotiated,
      REMOTE_PROTOCOL_LIMITS.companionMessageBytes + 1,
    )
    const oneByteOverflowWire = json({ applicationVersion: 2, ...oneByteOverflow })
    expect(oneByteOverflowWire).toHaveLength((60 * 1_024) + 1)
    expect(() => encodeCompanionMessage(negotiated, oneByteOverflow)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
    expect(() => decodeCompanionMessage(negotiated, oneByteOverflowWire)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )

    const multibyteBase = companionOperationWithEncodedBytes(negotiated)
    const multibyteBaseBytes = encodeCompanionMessage(negotiated, multibyteBase).byteLength
    multibyteBase.operation.text = '界'.repeat(
      Math.floor((REMOTE_PROTOCOL_LIMITS.companionMessageBytes - (multibyteBaseBytes - 1)) / 3) + 1,
    )
    const multibyteWire = json({ applicationVersion: 2, ...multibyteBase })
    expect(multibyteWire.byteLength).toBeGreaterThan(REMOTE_PROTOCOL_LIMITS.companionMessageBytes)
    expect(multibyteBase.operation.text.length).toBeLessThan(REMOTE_PROTOCOL_LIMITS.companionMessageBytes)
    expect(() => encodeCompanionMessage(negotiated, multibyteBase)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
    expect(() => decodeCompanionMessage(negotiated, multibyteWire)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )

    const manyValues = Array.from({ length: 17 }, () => Array.from({ length: 256 }, () => null))
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2, type: 'operation', operation: { type: 'submit-prompt', operationId: 'operation', sessionId: 'session', text: 'x', extra: manyValues },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }))
  })

  it('brands only bounded canonical Companion identifiers', () => {
    for (const value of [undefined, '', 'x'.repeat(129), 'not valid']) {
      expect(() => parseCompanionOperationId(value)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
      expect(() => parseCompanionInteractionId(value)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }
  })

  it('round-trips one bounded offer-attachment control message', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile', [1, 2]),
      createCompanionVersionOffer('desktop', [1, 2]),
    )
    const message = {
      type: 'operation' as const,
      operation: {
        type: 'offer-attachment' as const,
        operationId: parseCompanionOperationId('operation-attachment'),
        sessionId: parseCompanionSessionId('session-attachment'),
        capability: 'A'.repeat(43) as never,
        ciphertextSha256: '0'.repeat(64),
        byteLength: 4_096,
        expiresAt: 1_787_027_200_000,
        fileName: 'notes.txt',
      },
    }
    const encoded = encodeCompanionMessage(negotiated, message)
    expect(encoded.byteLength).toBeLessThanOrEqual(REMOTE_PROTOCOL_LIMITS.companionMessageBytes)
    expect(decodeCompanionMessage(negotiated, encoded)).toEqual(message)
  })

  it('rejects malformed offer-attachment control messages', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile', [1, 2]),
      createCompanionVersionOffer('desktop', [1, 2]),
    )
    const base: Record<string, unknown> = {
      applicationVersion: 2,
      type: 'operation',
      operation: {
        type: 'offer-attachment',
        operationId: 'operation-attachment',
        sessionId: 'session-attachment',
        capability: 'A'.repeat(43),
        ciphertextSha256: '0'.repeat(64),
        byteLength: 4_096,
        expiresAt: 1_787_027_200_000,
        fileName: 'notes.txt',
      },
    }
    const invalid = (mutate: (operation: Record<string, unknown>) => void): Uint8Array => {
      const record = structuredClone(base)
      mutate(record.operation as Record<string, unknown>)
      return json(record)
    }
    expect(() => decodeCompanionMessage(negotiated, invalid((operation) => {
      operation.ciphertextSha256 = 'XYZ'.repeat(16) + 'z'
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, invalid((operation) => {
      operation.capability = 'A'.repeat(42)
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, invalid((operation) => {
      operation.byteLength = 0
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, invalid((operation) => {
      operation.byteLength = REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes + 1
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }))
    expect(() => decodeCompanionMessage(negotiated, invalid((operation) => {
      operation.fileName = ''
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
    expect(() => decodeCompanionMessage(negotiated, invalid((operation) => {
      operation.extra = 'unsupported'
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
  })

  it('bounds the offer file name on complete UTF-8 bytes including multibyte characters', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile', [1, 2]),
      createCompanionVersionOffer('desktop', [1, 2]),
    )
    const exactAscii = 'a'.repeat(REMOTE_PROTOCOL_LIMITS.attachmentFileNameBytes)
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, {
      type: 'operation',
      operation: attachmentOffer({ fileName: exactAscii }),
    }))).toEqual({
      type: 'operation',
      operation: attachmentOffer({ fileName: exactAscii }),
    })
    const multibyteExact = '文'.repeat(Math.floor(REMOTE_PROTOCOL_LIMITS.attachmentFileNameBytes / 3))
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, {
      type: 'operation',
      operation: attachmentOffer({ fileName: multibyteExact }),
    }))).toEqual({
      type: 'operation',
      operation: attachmentOffer({ fileName: multibyteExact }),
    })
    const multibyteOverflow = `${'文'.repeat(Math.floor(REMOTE_PROTOCOL_LIMITS.attachmentFileNameBytes / 3))}x`
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'operation',
      operation: attachmentOffer({ fileName: multibyteOverflow }),
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
  })

  it('round-trips and bounds one attachment-rejected result', () => {
    const negotiated = negotiateFresh(
      createCompanionVersionOffer('mobile', [1, 2]),
      createCompanionVersionOffer('desktop', [1, 2]),
    )
    const message = {
      type: 'result' as const,
      result: {
        type: 'attachment-rejected' as const,
        operationId: parseCompanionOperationId('operation-attachment'),
        reason: 'hash-mismatch' as const,
      },
    }
    expect(decodeCompanionMessage(negotiated, encodeCompanionMessage(negotiated, message))).toEqual(message)
    expect(() => decodeCompanionMessage(negotiated, json({
      applicationVersion: 2,
      type: 'result',
      result: { type: 'attachment-rejected', operationId: 'operation-attachment', reason: 'unknown' },
    }))).toThrow(expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }))
  })
})

function attachmentOffer(overrides: { fileName: string }): CompanionOfferAttachmentOperation {
  return {
    type: 'offer-attachment',
    operationId: parseCompanionOperationId('operation-attachment'),
    sessionId: parseCompanionSessionId('session-attachment'),
    capability: parseAttachmentCapability('A'.repeat(43)),
    ciphertextSha256: '0'.repeat(64),
    byteLength: 4_096,
    expiresAt: 1_787_027_200_000,
    fileName: overrides.fileName,
  }
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function negotiateFresh(
  mobile: Parameters<typeof negotiateCompanionProtocol>[1],
  desktop: Parameters<typeof negotiateCompanionProtocol>[2],
): ReturnType<typeof negotiateCompanionProtocol> {
  return negotiateCompanionProtocol(createCompanionNegotiationChannel(), mobile, desktop)
}

function transcriptPageWithEncodedBytes(
  negotiated: ReturnType<typeof negotiateCompanionProtocol>,
  entryCount: number,
  targetBytes?: number,
) {
  const projection = {
    type: 'projection' as const,
    projection: {
      type: 'transcript-page' as const,
      sessionId: parseCompanionSessionId('session-limit'),
      entries: Array.from({ length: entryCount }, (_, index) => ({
        type: 'text' as const,
        entryId: parseCompanionTranscriptEntryId(`entry-${String(index)}`),
        role: 'assistant' as const,
        text: '',
      })),
    },
  }
  if (targetBytes === undefined) return projection
  const baseBytes = encodeCompanionMessage(negotiated, projection).byteLength
  const last = projection.projection.entries.at(-1)
  if (last === undefined || baseBytes > targetBytes) throw new Error('Transcript fixture cannot reach target size')
  last.text = 'x'.repeat(targetBytes - baseBytes)
  return projection
}

function companionOperationWithEncodedBytes(
  negotiated: ReturnType<typeof negotiateCompanionProtocol>,
  targetBytes?: number,
) {
  const operation = {
    type: 'operation' as const,
    operation: {
      type: 'submit-prompt' as const,
      operationId: parseCompanionOperationId('operation-limit'),
      sessionId: parseCompanionSessionId('session-limit'),
      text: 'x',
    },
  }
  if (targetBytes === undefined) return operation
  const baseBytes = encodeCompanionMessage(negotiated, operation).byteLength
  if (baseBytes > targetBytes) throw new Error('Companion fixture cannot reach target size')
  operation.operation.text = 'x'.repeat(targetBytes - baseBytes + 1)
  return operation
}
