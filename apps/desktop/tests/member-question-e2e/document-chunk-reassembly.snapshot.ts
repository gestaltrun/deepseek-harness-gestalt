import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MemberQuestionDocumentAssembler } from '@deepseek-ai/dsh-member-question-receiver'
import {
  createMemberQuestionProtocol,
  encodeMemberQuestionDocuments,
} from '@deepseek-ai/dsh-member-question-sender'
import {
  decodeCompanionMessage,
  deriveMemberQuestionDocumentTransferId,
  parseMemberQuestionId,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'

const expected = fileURLToPath(new URL('./snapshots/document-chunk-reassembly.expected.json', import.meta.url))
const QUESTION_ID = parseMemberQuestionId('mqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const CHUNKED_BYTES = Uint8Array.from(
  { length: REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes + 19 },
  (_, index) => index % 251,
)

describe('assembled member-question document-chunk transcript', () => {
  it('records encode, wire, and reassembly of markdown plus arbitrary bytes', async () => {
    const protocol = createMemberQuestionProtocol()
    const markdown = new TextEncoder().encode('# Guarded rollout\n')
    const documents = encodeMemberQuestionDocuments(protocol, QUESTION_ID, [
      { path: 'decision.md', bytes: markdown },
      { path: 'payload.bin', bytes: CHUNKED_BYTES },
      { path: 'empty.dat', bytes: new Uint8Array() },
    ])
    const assembler = new MemberQuestionDocumentAssembler(QUESTION_ID, documents.map(document => document.path))
    const completed = documents.flatMap(document => document.encoded.map((encoded) => {
      const message = decodeCompanionMessage(protocol, encoded)
      if (message.type !== 'operation' || message.operation.type !== 'document-chunk') {
        throw new Error('expected a document-chunk operation')
      }
      return assembler.accept(message.operation)
    })).filter(document => document !== undefined)

    const report = JSON.stringify({
      schemaVersion: 1,
      questionId: QUESTION_ID,
      documentTransfers: documents.map((document, index) => ({
        path: document.path,
        transferId: document.transferId,
        derivedTransferId: deriveMemberQuestionDocumentTransferId(QUESTION_ID, index),
        chunks: document.messages.map((message) => {
          if (message.type !== 'operation' || message.operation.type !== 'document-chunk') {
            throw new Error('expected a document-chunk operation')
          }
          return {
            index: message.operation.index,
            total: message.operation.total,
            questionId: message.operation.questionId,
            transferId: message.operation.transferId,
            byteLength: Buffer.from(message.operation.bytes, 'base64url').byteLength,
          }
        }),
      })),
      reassembled: completed.map(document => ({
        path: document.path,
        byteLength: document.bytes.byteLength,
        sha256: createHash('sha256').update(document.bytes).digest('hex'),
      })),
    }, null, 2) + '\n'

    await expect(report).toMatchFileSnapshot(expected)
  })
})
