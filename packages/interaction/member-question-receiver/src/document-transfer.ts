/** Ordered reconstruction of one member-question reference list. */

import {
  decodeProtocolBase64Url,
  deriveMemberQuestionDocumentTransferId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionDocumentChunkOperation,
  type DocumentTransferId,
  type MemberQuestionId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { ReassembledMemberQuestionDocument } from './types.ts'

interface TransferState {
  readonly path: string
  readonly chunks: Map<number, Uint8Array>
  total?: number
  byteLength: number
  completed: boolean
}

/**
 * Question-scoped consumer for bounded document frames. Cross-frame totals,
 * duplicate identity, and aggregate bytes are stateful obligations that the
 * per-message Companion decoder cannot enforce.
 */
export class MemberQuestionDocumentAssembler {
  private readonly transfers = new Map<DocumentTransferId, TransferState>()

  /**
   * @param questionId - member question owning every accepted frame.
   * @param referencePaths - bounded reference paths in operation order.
   */
  constructor(
    private readonly questionId: MemberQuestionId,
    referencePaths: readonly string[],
  ) {
    for (const [index, path] of referencePaths.entries()) {
      this.transfers.set(deriveMemberQuestionDocumentTransferId(questionId, index), {
        path,
        chunks: new Map(),
        byteLength: 0,
        completed: false,
      })
    }
  }

  /**
   * Accept one decoded chunk and return the document exactly once when complete.
   * @param operation - decoded Companion document-chunk operation.
   * @returns complete bytes when this frame closes its transfer, otherwise undefined.
   */
  accept(operation: CompanionDocumentChunkOperation): ReassembledMemberQuestionDocument | undefined {
    if (operation.questionId !== this.questionId) {
      throw new Error('member-question document chunk names a different question')
    }
    const state = this.transfers.get(operation.transferId)
    if (state === undefined) throw new Error('member-question document chunk names an unknown transfer')
    if (state.total !== undefined && state.total !== operation.total) {
      throw new Error('member-question document chunks declare inconsistent totals')
    }
    state.total = operation.total
    const bytes = decodeProtocolBase64Url(
      operation.bytes,
      REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes,
      'Companion document-chunk bytes',
    )
    const retained = state.chunks.get(operation.index)
    if (retained !== undefined) {
      if (!sameBytes(retained, bytes)) throw new Error('member-question document chunk has conflicting duplicate bytes')
      return undefined
    }
    if (state.completed) throw new Error('member-question document transfer received a new chunk after completion')
    state.chunks.set(operation.index, bytes)
    state.byteLength += bytes.byteLength
    if (state.byteLength > REMOTE_PROTOCOL_LIMITS.documentTransferTotalBytes) {
      throw new Error('member-question document transfer exceeds its cumulative byte ceiling')
    }
    if (state.chunks.size !== operation.total) return undefined
    const ordered = Array.from({ length: operation.total }, (_, index) => state.chunks.get(index))
    if (ordered.some(chunk => chunk === undefined)) return undefined
    state.completed = true
    const combined = new Uint8Array(state.byteLength)
    let offset = 0
    for (const chunk of ordered as Uint8Array[]) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { path: state.path, bytes: combined }
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
