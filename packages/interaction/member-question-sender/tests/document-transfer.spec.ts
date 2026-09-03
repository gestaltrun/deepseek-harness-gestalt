import { describe, expect, it } from 'vitest'
import {
  decodeCompanionMessage,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionDocumentChunkOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  createMemberQuestionProtocol,
  encodeMemberQuestionDocuments,
} from '../src/index.ts'

describe('member-question document transfer sender', () => {
  it('encodes arbitrary bytes into bounded Companion document chunks', () => {
    const protocol = createMemberQuestionProtocol()
    const bytes = Uint8Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * 2 + 7 },
      (_, index) => index % 251,
    )
    const [document] = encodeMemberQuestionDocuments(protocol, 'mq-document' as never, [{
      path: 'evidence/report.bin',
      bytes,
    }])

    expect(document?.path).toBe('evidence/report.bin')
    expect(document?.messages).toHaveLength(3)
    const operations = document?.encoded.map((encoded) => {
      const message = decodeCompanionMessage(protocol, encoded)
      expect(message.type).toBe('operation')
      if (message.type !== 'operation' || message.operation.type !== 'document-chunk') {
        throw new Error('expected document-chunk operation')
      }
      return message.operation
    }) as CompanionDocumentChunkOperation[]
    expect(operations.map(operation => operation.index)).toEqual([0, 1, 2])
    expect(new Set(operations.map(operation => operation.transferId))).toEqual(new Set([document?.transferId]))
    expect(operations.every(operation => operation.total === 3 && operation.questionId === 'mq-document')).toBe(true)
  })

  it('emits one empty chunk and rejects a document above the transfer ceiling', () => {
    const protocol = createMemberQuestionProtocol()
    const [empty] = encodeMemberQuestionDocuments(protocol, 'mq-empty' as never, [{
      path: 'empty.dat',
      bytes: new Uint8Array(),
    }])
    expect(empty?.messages).toHaveLength(1)

    expect(() => encodeMemberQuestionDocuments(protocol, 'mq-oversize' as never, [{
      path: 'oversize.dat',
      bytes: new Uint8Array(REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes + 1),
    }])).toThrow('document exceeds')
  })

  it('rejects document counts and chunk totals outside protocol ceilings', () => {
    const protocol = createMemberQuestionProtocol()
    expect(() => encodeMemberQuestionDocuments(protocol, 'mq-count' as never, Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.memberQuestionReferences + 1 },
      (_, index) => ({ path: `${String(index)}.dat`, bytes: new Uint8Array() }),
    ))).toThrow('document count exceeds')
    expect(() => encodeMemberQuestionDocuments(protocol, 'mq-chunks' as never, [{
      path: 'too-many-chunks.dat',
      bytes: new Uint8Array(
        REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * REMOTE_PROTOCOL_LIMITS.documentTransferChunks + 1,
      ),
    }])).toThrow('chunk transfer ceiling')
  })
})
