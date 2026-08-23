/** Desktop-only mapping from Host pending requests to pairing-private Companion identities. */

import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  encodeProtocolBase64Url,
  parseCompanionInteractionId,
  parseCompanionSessionId,
  type CompanionInteractionId,
  type CompanionSessionId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { DesktopPendingCompanionInteraction } from './companion-product.ts'

interface PendingApproval extends DesktopPendingCompanionInteraction {
  kind: 'approval'
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

interface PendingQuestion extends DesktopPendingCompanionInteraction {
  kind: 'question'
  questions: readonly unknown[]
}

type PendingInteraction = PendingApproval | PendingQuestion

/** Pairing-neutral Host pending registry; ids are derived only when projected to one pairing. */
export class DesktopCompanionInteractionRegistry {
  private readonly pending = new Map<string, PendingInteraction>()

  /** @param envelope - validated-shape Host mux envelope from the current Web Host generation. */
  accept(envelope: { rpcId: string; payload: unknown }): void {
    if (!isRecord(envelope.payload) || typeof envelope.payload.type !== 'string') return
    const payload = envelope.payload
    if (payload.type === 'approval/requested') {
      if (typeof payload.sessionId !== 'string' || typeof payload.approvalId !== 'string'
        || typeof payload.toolName !== 'string') return
      this.pending.set(envelope.rpcId, {
        rpcId: envelope.rpcId, kind: 'approval', sessionId: parseCompanionSessionId(payload.sessionId),
        approvalId: payload.approvalId, toolName: payload.toolName,
        ...(typeof payload.callId === 'string' ? { callId: payload.callId } : {}),
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      })
      return
    }
    if (payload.type === 'question/requested') {
      if (typeof payload.sessionId !== 'string' || !Array.isArray(payload.questions)) return
      this.pending.set(envelope.rpcId, {
        rpcId: envelope.rpcId, kind: 'question', sessionId: parseCompanionSessionId(payload.sessionId),
        questions: structuredClone(payload.questions),
      })
      return
    }
    if (payload.type === 'approval/resolved' && typeof payload.approvalId === 'string') {
      for (const [rpcId, pending] of this.pending) {
        if (pending.kind === 'approval' && pending.approvalId === payload.approvalId) this.pending.delete(rpcId)
      }
    } else if (payload.type === 'question/resolved' && typeof payload.questionRpcId === 'string') {
      this.pending.delete(payload.questionRpcId)
    }
  }

  /** @param interactionId - pairing-private id. @param key - exact pairing application key. */
  resolve(interactionId: CompanionInteractionId, key: Uint8Array): DesktopPendingCompanionInteraction | undefined {
    const expected = Buffer.from(interactionId, 'base64url')
    for (const pending of this.pending.values()) {
      const candidate = Buffer.from(deriveInteractionId(pending, key), 'base64url')
      if (candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected)) return { ...pending }
    }
    return undefined
  }

  /** Project current waits for one Session without exposing Host rpc ids. */
  project(sessionId: CompanionSessionId, key: Uint8Array): ReadonlyArray<{
    kind: 'approval' | 'question'
    interactionId: CompanionInteractionId
    sessionId: CompanionSessionId
    payload: Record<string, unknown>
  }> {
    return [...this.pending.values()].filter(pending => pending.sessionId === sessionId).map(pending => ({
      kind: pending.kind,
      interactionId: deriveInteractionId(pending, key),
      sessionId: pending.sessionId,
      payload: pending.kind === 'approval'
        ? {
          approvalId: pending.approvalId, toolName: pending.toolName,
          ...(pending.callId === undefined ? {} : { callId: pending.callId }),
          ...(pending.reason === undefined ? {} : { reason: pending.reason }),
        }
        : { questions: structuredClone(pending.questions) },
    }))
  }

  /** Drop every Host-generation request before a replacement stream begins. */
  clear(): void { this.pending.clear() }
}

function deriveInteractionId(pending: PendingInteraction, key: Uint8Array): CompanionInteractionId {
  const digest = createHmac('sha256', key)
    .update('dsh-companion-interaction-v1\0')
    .update(pending.kind).update('\0')
    .update(pending.sessionId).update('\0')
    .update(pending.rpcId)
    .digest()
  return parseCompanionInteractionId(encodeProtocolBase64Url(digest))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
