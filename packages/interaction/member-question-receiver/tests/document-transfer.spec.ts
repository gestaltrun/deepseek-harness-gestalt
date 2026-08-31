import { describe, expect, it } from 'vitest'
import {
  deriveMemberQuestionDocumentTransferId,
  encodeProtocolBase64Url,
  parseCompanionOperationId,
  parseDocumentTransferId,
  parseMemberQuestionId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionDocumentChunkOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import { MemberQuestionDocumentAssembler } from '../src/index.ts'

describe('member-question document transfer receiver', () => {
  it('reassembles out-of-order arbitrary bytes and treats exact duplicate chunks idempotently', () => {
    const bytes = Uint8Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes + 19 },
      (_, index) => (index * 17) % 256,
    )
    const chunks = chunksFor('mq-reassemble', bytes)
    const assembler = new MemberQuestionDocumentAssembler(
      'mq-reassemble' as never,
      ['artifacts/result.bin'],
    )

    expect(assembler.accept(chunks[1] as CompanionDocumentChunkOperation)).toBeUndefined()
    expect(assembler.accept(chunks[1] as CompanionDocumentChunkOperation)).toBeUndefined()
    expect(assembler.accept(chunks[0] as CompanionDocumentChunkOperation)).toEqual({
      path: 'artifacts/result.bin',
      bytes,
    })
  })

  it('rejects unknown transfers, conflicting duplicates, and inconsistent totals', () => {
    const [chunk] = chunksFor('mq-invalid', Uint8Array.of(1, 2, 3))
    if (chunk === undefined) throw new Error('missing document chunk')

    expect(() => new MemberQuestionDocumentAssembler('mq-other' as never, ['one.bin']).accept(chunk))
      .toThrow('question')
    expect(() => new MemberQuestionDocumentAssembler('mq-invalid' as never, ['one.bin']).accept({
      ...chunk,
      transferId: parseDocumentTransferId('unknown-transfer'),
    }))
      .toThrow('transfer')

    const duplicate = new MemberQuestionDocumentAssembler('mq-invalid' as never, ['one.bin'])
    expect(duplicate.accept({ ...chunk, total: 2 })).toBeUndefined()
    expect(() => duplicate.accept({ ...chunk, index: 0, total: 2, bytes: 'BA' })).toThrow('conflicting')
    expect(() => duplicate.accept({ ...chunk, index: 1, total: 3 })).toThrow('total')
  })

  it('rejects post-completion and cumulative oversize chunks while retaining incomplete indexes', () => {
    const [chunk] = chunksFor('mq-bounds', Uint8Array.of(1))
    if (chunk === undefined) throw new Error('missing document chunk')
    const completed = new MemberQuestionDocumentAssembler('mq-bounds' as never, ['one.bin'])
    expect(completed.accept(chunk)).toMatchObject({ path: 'one.bin' })
    expect(() => completed.accept({ ...chunk, index: 1 })).toThrow('after completion')

    const sparse = new MemberQuestionDocumentAssembler('mq-bounds' as never, ['one.bin'])
    expect(sparse.accept({ ...chunk, total: 2 })).toBeUndefined()
    expect(sparse.accept({ ...chunk, index: 2, total: 2 })).toBeUndefined()

    const oversized = new MemberQuestionDocumentAssembler('mq-bounds' as never, ['one.bin'])
    const fullChunk = encodeProtocolBase64Url(new Uint8Array(REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes))
    const total = Math.floor(
      REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes / REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes,
    ) + 1
    for (let index = 0; index < total - 1; index += 1) {
      expect(oversized.accept({ ...chunk, bytes: fullChunk, index, total })).toBeUndefined()
    }
    expect(() => oversized.accept({ ...chunk, bytes: fullChunk, index: total - 1, total }))
      .toThrow('cumulative byte ceiling')
  })
})

function chunksFor(question: string, bytes: Uint8Array): CompanionDocumentChunkOperation[] {
  const questionId = parseMemberQuestionId(question)
  const transferId = deriveMemberQuestionDocumentTransferId(questionId, 0)
  const total = Math.max(1, Math.ceil(bytes.byteLength / REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes))
  return Array.from({ length: total }, (_, index) => {
    const start = index * REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes
    return {
      type: 'document-chunk',
      operationId: parseCompanionOperationId(`operation-${String(index)}`),
      transferId,
      questionId,
      index,
      total,
      bytes: encodeProtocolBase64Url(bytes.slice(
        start,
        Math.min(bytes.byteLength, start + REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes),
      )),
    }
  })
}
