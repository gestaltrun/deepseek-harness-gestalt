import { describe, expect, it } from 'vitest'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  encodeCompanionMessage,
  encodeProtocolBase64Url,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseDocumentTransferId,
  parseMemberQuestionId,
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
  type CompanionDocumentChunkOperation,
  type RemoteProtocolErrorCode,
} from '../src/index.ts'

describe('Encrypted Companion Protocol document transfer frames', () => {
  it('round-trips chunk frames including the short final chunk and the chunk-count ceiling', () => {
    const protocol = currentProtocol()
    const chunks = [
      documentChunk({ index: 0, total: 3, bytes: encodeProtocolBase64Url(exactChunkBytes()) }),
      documentChunk({ index: 1, total: 3, bytes: encodeProtocolBase64Url(Uint8Array.of(0xe6, 0x96, 0x87)) }),
      documentChunk({ index: 2, total: 3, bytes: encodeProtocolBase64Url(Uint8Array.of(7)) }),
    ]
    for (const message of chunks) {
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }
    // Frames carry no transfer state, so any arrival order decodes; ordering is a consumer reassembly duty.
    for (const message of [...chunks].reverse()) {
      expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, message))).toEqual(message)
    }

    const ceiling = documentChunk({
      index: REMOTE_PROTOCOL_LIMITS.documentTransferChunks - 1,
      total: REMOTE_PROTOCOL_LIMITS.documentTransferChunks,
      bytes: encodeProtocolBase64Url(Uint8Array.of(9)),
    })
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, ceiling))).toEqual(ceiling)

    const projection = {
      type: 'projection' as const,
      projection: {
        type: 'document-transfer-state' as const,
        transferId: parseDocumentTransferId('document-transfer-1'),
        received: 2,
        total: 3,
      },
    }
    expect(decodeCompanionMessage(protocol, encodeCompanionMessage(protocol, projection))).toEqual(projection)
  })

  it('rejects unknown fields, unknown types, out-of-range frames, oversize chunks, and base64url aliases', () => {
    const protocol = currentProtocol()
    const oversizeChunk = encodeProtocolBase64Url(
      new Uint8Array(REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes + 1),
    )
    const canonicalBytes = encodeProtocolBase64Url(Uint8Array.of(1, 2, 3))
    const invalidCases: { wire: Uint8Array; code: RemoteProtocolErrorCode }[] = [
      { wire: wireChunk((chunk) => { chunk.extra = true }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireState((state) => { state.extra = true }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.type = 'document-chunk-v2' }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.total = 0 }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      {
        wire: wireChunk((chunk) => { chunk.total = REMOTE_PROTOCOL_LIMITS.documentTransferChunks + 1 }),
        code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED',
      },
      { wire: wireChunk((chunk) => { chunk.total = true }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.total = 1.5 }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.index = 3 }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.index = -1 }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireState((state) => { state.total = 0 }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      {
        wire: wireState((state) => { state.total = REMOTE_PROTOCOL_LIMITS.documentTransferChunks + 1 }),
        code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED',
      },
      { wire: wireState((state) => { state.received = 4 }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.bytes = oversizeChunk }), code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' },
      {
        wire: wireChunk((chunk) => { chunk.bytes = `${canonicalBytes as string}=` }),
        code: 'REMOTE_PROTOCOL_INVALID_MESSAGE',
      },
      { wire: wireChunk((chunk) => { chunk.bytes = 7 }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.transferId = 'not valid' }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
      { wire: wireChunk((chunk) => { chunk.questionId = 'member-question-1 ' }), code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' },
    ]
    for (const { wire, code } of invalidCases) {
      expect(() => decodeCompanionMessage(protocol, wire)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code }),
      )
    }
    expect(() => parseDocumentTransferId('not valid')).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
  })

  it('requires application major 4 for document transfer frames', () => {
    const stale = negotiateFresh(createCompanionVersionOffer('mobile', [3]), createCompanionVersionOffer('desktop', [3]))
    expect(stale.major).toBe(3)
    const chunk = documentChunk({ index: 0, total: 1, bytes: encodeProtocolBase64Url(Uint8Array.of(1)) })
    const projection = {
      type: 'projection' as const,
      projection: {
        type: 'document-transfer-state' as const,
        transferId: parseDocumentTransferId('document-transfer-1'),
        received: 1,
        total: 1,
      },
    }
    for (const message of [chunk, projection]) {
      expect(() => encodeCompanionMessage(stale, message)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'COMPANION_UPDATE_REQUIRED' }),
      )
    }
    expect(() => decodeCompanionMessage(stale, wireChunk(() => {}, 3))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
    expect(() => decodeCompanionMessage(stale, wireState(() => {}, 3))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
  })
})

function exactChunkBytes(): Uint8Array {
  return Uint8Array.from(
    { length: REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes },
    (_, index) => index % 251,
  )
}

function documentChunk(
  operation: Omit<CompanionDocumentChunkOperation, 'type' | 'operationId' | 'transferId' | 'questionId'>,
): { type: 'operation'; operation: CompanionDocumentChunkOperation } {
  return {
    type: 'operation',
    operation: {
      type: 'document-chunk',
      operationId: parseCompanionOperationId('operation-document-chunk'),
      transferId: parseDocumentTransferId('document-transfer-1'),
      questionId: parseMemberQuestionId('member-question-1'),
      ...operation,
    },
  }
}

function rawChunkOperation(): Record<string, unknown> {
  return {
    type: 'document-chunk',
    operationId: 'operation-document-chunk',
    transferId: 'document-transfer-1',
    questionId: 'member-question-1',
    index: 0,
    total: 3,
    bytes: encodeProtocolBase64Url(Uint8Array.of(1, 2, 3)),
  }
}

function rawTransferState(): Record<string, unknown> {
  return { type: 'document-transfer-state', transferId: 'document-transfer-1', received: 2, total: 3 }
}

function wireChunk(mutate: (chunk: Record<string, unknown>) => void, version = 4): Uint8Array {
  return json({
    applicationVersion: version,
    type: 'operation',
    operation: mutateOnClone(rawChunkOperation(), mutate),
  })
}

function wireState(mutate: (state: Record<string, unknown>) => void, version = 4): Uint8Array {
  return json({
    applicationVersion: version,
    type: 'projection',
    projection: mutateOnClone(rawTransferState(), mutate),
  })
}

function mutateOnClone<T>(value: T, mutate: (cloned: T) => void): T {
  const cloned = structuredClone(value)
  mutate(cloned)
  return cloned
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

function currentProtocol(): ReturnType<typeof negotiateCompanionProtocol> {
  return negotiateFresh(createCompanionVersionOffer('mobile'), createCompanionVersionOffer('desktop'))
}
