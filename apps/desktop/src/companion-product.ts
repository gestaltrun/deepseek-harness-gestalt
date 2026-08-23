/** Desktop authority for product Companion attachments and Session search. */

import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  parseCompanionSessionId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionAttachmentRejectedResult,
  type CompanionHostFailure,
  type CompanionOfferAttachmentOperation,
  type CompanionOperationFailedResult,
  type CompanionResult,
  type CompanionSearchSessionsOperation,
  type CompanionSessionSearchResult,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  CompanionAttachmentReceiveError,
  receiveCompanionAttachment,
} from './companion-attachments.ts'
import {
  createDesktopHostRpc,
  type DesktopHostRpc,
  type DesktopHostRpcOptions,
  type DesktopHostRpcResult,
} from './host-rpc.ts'

/** Operations owned by the attachment and authoritative-search product bridge. */
export type CompanionProductOperation = CompanionOfferAttachmentOperation | CompanionSearchSessionsOperation

/** Desktop product dependencies scoped to one authenticated Personal Pairing. */
export interface CompanionProductOperationDependencies {
  /** Current Web Host unary RPC. */
  host: DesktopHostRpc
  /** Personal Pairing authenticated by the reviewed Companion channel. */
  pairingId: PersonalPairingId
  /** Independent key material for that exact Personal Pairing. */
  attachmentKey: Uint8Array
  /** Product clock used for capability expiry and confirmations. */
  now(): number
  /** Download ciphertext through the pairing-scoped remote-attachments capability. */
  downloadAttachment(
    offer: CompanionOfferAttachmentOperation,
    pairingId: PersonalPairingId,
  ): Promise<Uint8Array>
  /** Submit decrypted bytes into the Desktop-owned Session attachment path. */
  submitAttachment(input: {
    sessionId: CompanionOfferAttachmentOperation['sessionId']
    operationId: CompanionOfferAttachmentOperation['operationId']
    fileName: string
    mediaType: string
    plaintext: Uint8Array
  }): Promise<DesktopHostRpcResult>
}

/** Per-pairing dependencies supplied by the reviewed Desktop channel owner. */
export type DesktopCompanionPairingDependencies = Omit<CompanionProductOperationDependencies, 'host'>

/** Shipped Desktop owner that follows Web Host replacement and executes decoded product operations. */
export class DesktopCompanionProductOwner {
  private installed: { readonly rpc: DesktopHostRpc } | undefined

  /** @param hostOptions - response bound and request deadline for every Web Host generation. */
  constructor(private readonly hostOptions: DesktopHostRpcOptions) {}

  /**
   * Install the current Web Host loopback RPC.
   * @param baseUrl - loopback origin emitted by the shipped Web Host.
   * @returns disposer that cannot remove a replacement installation.
   */
  installHost(baseUrl: string): () => void {
    const installed = { rpc: createDesktopHostRpc(baseUrl, this.hostOptions) }
    this.installed = installed
    return () => {
      if (this.installed === installed) this.installed = undefined
    }
  }

  /**
   * Execute one operation decoded by the reviewed channel against the current Web Host.
   * @param operation - validated Companion operation.
   * @param dependencies - exact Personal Pairing identity, key, and attachment adapters.
   * @returns correlated product result; absent Web Host becomes a stable wire failure.
   */
  async handle(
    operation: CompanionProductOperation,
    dependencies: DesktopCompanionPairingDependencies,
  ): Promise<CompanionResult> {
    const host = this.installed?.rpc
    if (host === undefined) {
      return operationFailed(operation, {
        kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Web Host is not available',
      })
    }
    return await handleCompanionProductOperation(operation, { ...dependencies, host })
  }

  /**
   * Submit decrypted bytes through the Desktop Web Host's Session attachment admission.
   * @param input - target Session, exact file name, and endpoint-decrypted bytes.
   * @returns Host result preserving HTTP, wire, business, and timeout failures.
   */
  async submitAttachment(input: {
    sessionId: CompanionOfferAttachmentOperation['sessionId']
    operationId: CompanionOfferAttachmentOperation['operationId']
    fileName: string
    mediaType: string
    plaintext: Uint8Array
  }): Promise<DesktopHostRpcResult> {
    const host = this.installed?.rpc
    if (host === undefined) {
      return { ok: false, failure: {
        kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Web Host is not available',
      } }
    }
    return await host.call('session.admitAttachment', {
      sessionId: input.sessionId,
      operationId: input.operationId,
      name: input.fileName,
      mediaType: input.mediaType,
      data: Buffer.from(input.plaintext).toString('base64'),
    }, this.hostOptions.attachmentTimeoutMs === undefined
      ? undefined
      : { timeoutMs: this.hostOptions.attachmentTimeoutMs })
  }
}

/**
 * Execute one attachment or search operation against the Paired Desktop authority.
 * @param operation - validated Encrypted Companion operation.
 * @param dependencies - pairing identity, attachment key, Web Host, and Session attachment path.
 * @returns correlated result that the encrypted channel can encode without loss.
 */
export async function handleCompanionProductOperation(
  operation: CompanionProductOperation,
  dependencies: CompanionProductOperationDependencies,
): Promise<CompanionResult> {
  switch (operation.type) {
    case 'offer-attachment':
      return await receiveAttachment(operation, dependencies)
    case 'search-sessions':
      return await searchSessions(operation, dependencies.host)
    default: {
      const never: never = operation
      return never
    }
  }
}

class HostSubmissionFailure extends Error {
  constructor(readonly failure: CompanionHostFailure) {
    super(failure.message)
    this.name = 'HostSubmissionFailure'
  }
}

async function receiveAttachment(
  operation: CompanionOfferAttachmentOperation,
  dependencies: CompanionProductOperationDependencies,
): Promise<CompanionResult> {
  try {
    await receiveCompanionAttachment(operation, {
      pairingId: dependencies.pairingId,
      attachmentKey: dependencies.attachmentKey,
      now: dependencies.now(),
      download: async (offer, pairingId) => await dependencies.downloadAttachment(offer, pairingId),
      submit: async ({ fileName, plaintext }) => {
        const submitted = await dependencies.submitAttachment({
          sessionId: operation.sessionId,
          operationId: operation.operationId,
          fileName,
          mediaType: operation.mediaType,
          plaintext,
        })
        if (!submitted.ok) throw new HostSubmissionFailure(normalizeFailure(submitted.failure))
      },
    })
    return {
      type: 'confirmed',
      operationId: operation.operationId,
      committedAt: dependencies.now(),
      outcome: 'accepted',
    }
  } catch (error) {
    if (error instanceof CompanionAttachmentReceiveError) {
      return attachmentRejected(operation, error.reason)
    }
    if (error instanceof HostSubmissionFailure) return operationFailed(operation, error.failure)
    return operationFailed(operation, {
      kind: 'business',
      code: 'host-error',
      message: 'Desktop Session attachment submission failed',
    })
  }
}

async function searchSessions(
  operation: CompanionSearchSessionsOperation,
  host: DesktopHostRpc,
): Promise<CompanionSessionSearchResult | CompanionOperationFailedResult> {
  const response = await host.call('session.search', { query: operation.query })
  if (!response.ok) return operationFailed(operation, normalizeFailure(response.failure))
  const parsed = parseSearchValue(response.value)
  if (parsed === undefined) {
    return operationFailed(operation, {
      kind: 'wire',
      code: 'HOST_WIRE_INVALID',
      message: 'Desktop Host session.search returned an invalid value',
    })
  }
  return { type: 'session-search', operationId: operation.operationId, ...parsed }
}

function parseSearchValue(value: unknown): Omit<CompanionSessionSearchResult, 'type' | 'operationId'> | undefined {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.hasMore !== 'boolean'
    || value.items.length > REMOTE_PROTOCOL_LIMITS.sessionSearchResults) return undefined
  const items: CompanionSessionSearchResult['items'][number][] = []
  const sessionIds = new Set<string>()
  for (const valueItem of value.items) {
    if (!isRecord(valueItem) || typeof valueItem.sessionId !== 'string' || typeof valueItem.snippet !== 'string'
      || codePointCount(valueItem.snippet) > REMOTE_PROTOCOL_LIMITS.sessionSearchSnippetCodePoints) return undefined
    let sessionId
    try {
      sessionId = parseCompanionSessionId(valueItem.sessionId)
    } catch {
      return undefined
    }
    if (sessionIds.has(sessionId)) return undefined
    sessionIds.add(sessionId)
    items.push({ sessionId, snippet: valueItem.snippet })
  }
  return { items, hasMore: value.hasMore }
}

function attachmentRejected(
  operation: CompanionOfferAttachmentOperation,
  reason: CompanionAttachmentRejectedResult['reason'],
): CompanionAttachmentRejectedResult {
  return { type: 'attachment-rejected', operationId: operation.operationId, reason }
}

function operationFailed(
  operation: CompanionProductOperation,
  failure: CompanionHostFailure,
): CompanionOperationFailedResult {
  return { type: 'operation-failed', operationId: operation.operationId, failure }
}

function normalizeFailure(failure: CompanionHostFailure): CompanionHostFailure {
  const messageBytes = new TextEncoder().encode(failure.message).byteLength
  if (messageBytes === 0 || messageBytes > REMOTE_PROTOCOL_LIMITS.hostFailureMessageBytes) {
    return { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host failure exceeded its wire contract' }
  }
  if (failure.kind !== 'business') return failure
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(failure.code)) {
    return { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host business error code was invalid' }
  }
  return failure
}

function codePointCount(value: string): number {
  let count = 0
  for (const _codePoint of value) count++
  return count
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
