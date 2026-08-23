/** End-to-end encrypted Companion attachment transfer, scoped to one Personal Pairing. */

import {
  COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES,
  deriveCompanionAttachmentKey,
  parseAttachmentCapability,
  REMOTE_PROTOCOL_LIMITS,
  sealCompanionAttachment as sealEndpointAttachment,
  type AttachmentCapability,
  type CompanionOfferAttachmentOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import type { CompanionMutationPermit } from './companion-mutation.ts'

/** Accepted per-blob ciphertext ceiling. */
export const COMPANION_ATTACHMENT_MAX_BYTES = REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes
/** AES-256-GCM seal overhead applied before comparing plaintext against the ciphertext ceiling. */
export { COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES }

/**
 * The sender failed, or resolved after the owning connection generation became invalid.
 * Callers must reconcile `operationId` through `query-operation-status`; they must not resend it.
 */
export class CompanionAttachmentDeliveryUncertainError extends Error {
  readonly code = 'COMPANION_ATTACHMENT_DELIVERY_UNCERTAIN'

  /** @param operationId - transmitted id that requires Desktop reconciliation. @param cause - generation refusal after send. */
  constructor(
    readonly operationId: CompanionOfferAttachmentOperation['operationId'],
    cause: unknown,
  ) {
    super(`Companion attachment ${operationId} delivery is uncertain`, { cause })
    this.name = 'CompanionAttachmentDeliveryUncertainError'
  }
}

/** One sealed blob plus the values Mobile sends in the bounded control message. */
export interface CompanionAttachmentTransfer {
  capability: AttachmentCapability
  ciphertextSha256: string
  byteLength: number
  expiresAt: number
  fileName: string
  mediaType: string
}

/** Browser file values required by the Companion transfer controller. */
export interface SelectedCompanionFile {
  /** Exact user-selected file name. */
  readonly name: string
  /** Browser-declared media type. */
  readonly type: string
  /** @returns a fresh copy of the selected file bytes. */
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Product dependencies for one selected-file transfer. */
export interface SelectedCompanionAttachmentOptions {
  /** Independent Personal Pairing attachment key retained on Mobile. */
  attachmentKey: Uint8Array
  /** Operated HTTPS Platform origin that owns the pairing-scoped blob capability. */
  origin: string
  /** Current-installation proof interpreted by Platform as one Personal Pairing. */
  authorizationHeaders: Record<string, string>
  /** Correlation identity for Desktop confirmation or rejection. */
  operationId: CompanionOfferAttachmentOperation['operationId']
  /** Desktop-owned Session target. */
  sessionId: CompanionOfferAttachmentOperation['sessionId']
  /** Dynamic authority bound to the current physical connection generation. */
  permit: CompanionMutationPermit
  /**
   * Encrypted Companion sender; receives only the bounded capability message.
   * Once invoked, rejection or generation loss is an uncertain outcome that must be reconciled, never retried.
   */
  send(offer: CompanionOfferAttachmentOperation): Promise<void>
  /** Browser HTTP adapter; defaults to global fetch. */
  fetch?: typeof fetch
}

/**
 * Encrypt attachment bytes on Mobile before upload.
 * @param attachmentKey - secret bytes supplied by the Personal Pairing layer.
 * @param plaintext - caller-held plaintext; never leaves Mobile unencrypted.
 * @param permit - dynamic foreground synchronization authority.
 * @param ciphertextLimit - ciphertext ceiling compared against `plaintext + seal overhead`; defaults to the protocol ceiling.
 * @returns sealed transfer values for upload and the bounded control message.
 */
export async function sealCompanionAttachment(
  attachmentKey: Uint8Array,
  plaintext: Uint8Array,
  permit: CompanionMutationPermit,
  ciphertextLimit: number = COMPANION_ATTACHMENT_MAX_BYTES,
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; ciphertextSha256: string }> {
  permit.requireCurrent()
  if (plaintext.byteLength + COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES > ciphertextLimit) {
    throw new Error('Companion attachment exceeds the ciphertext blob ceiling')
  }
  const key = await deriveCompanionAttachmentKey(attachmentKey)
  permit.requireCurrent()
  const sealed = await sealEndpointAttachment(key, plaintext)
  permit.requireCurrent()
  return sealed
}

/**
 * Build the bounded WSS control message that points Desktop at one uploaded blob.
 * @param transfer - values returned by the Platform blob store after upload.
 * @param operationId - idempotency key for the Desktop mutation.
 * @param sessionId - Companion Session that will receive the attachment.
 * @param permit - dynamic foreground synchronization authority.
 */
export function buildCompanionAttachmentOffer(
  transfer: CompanionAttachmentTransfer,
  operationId: CompanionOfferAttachmentOperation['operationId'],
  sessionId: CompanionOfferAttachmentOperation['sessionId'],
  permit: CompanionMutationPermit,
): CompanionOfferAttachmentOperation {
  permit.requireCurrent()
  return {
    type: 'offer-attachment',
    operationId,
    sessionId,
    capability: transfer.capability,
    ciphertextSha256: transfer.ciphertextSha256,
    byteLength: transfer.byteLength,
    expiresAt: transfer.expiresAt,
    fileName: transfer.fileName,
    mediaType: transfer.mediaType,
  }
}

/**
 * Read one real browser-selected file, upload only its ciphertext, and send only its capability.
 * @param file - user-selected browser File values.
 * @param options - attachment key, operated Platform authority, target Session, and encrypted sender.
 * @returns the exact control message accepted by the encrypted sender.
 */
export async function transferSelectedCompanionAttachment(
  file: SelectedCompanionFile,
  options: SelectedCompanionAttachmentOptions,
): Promise<CompanionOfferAttachmentOperation> {
  options.permit.requireCurrent()
  if (file.name === '' || new TextEncoder().encode(file.name).byteLength > REMOTE_PROTOCOL_LIMITS.attachmentFileNameBytes) {
    throw new TypeError('Companion attachment file name must be non-empty and within its byte ceiling')
  }
  const origin = new URL(options.origin)
  if (origin.protocol !== 'https:') throw new TypeError('Companion attachment Platform origin must use HTTPS')
  if (Object.keys(options.authorizationHeaders).length === 0) {
    throw new TypeError('Companion attachment upload requires current pairing-scoped authorization')
  }
  const plaintext = new Uint8Array(await file.arrayBuffer())
  let sealed: Awaited<ReturnType<typeof sealCompanionAttachment>>
  try {
    options.permit.requireCurrent()
    sealed = await sealCompanionAttachment(options.attachmentKey, plaintext, options.permit)
  } finally {
    plaintext.fill(0)
  }
  const headers = new Headers(options.authorizationHeaders)
  headers.set('content-type', 'application/octet-stream')
  options.permit.requireCurrent()
  const response = await (options.fetch ?? fetch)(new URL('/v1/remote-attachments', origin).href, {
    method: 'POST',
    headers,
    body: sealed.ciphertext,
  })
  options.permit.requireCurrent()
  if (response.status !== 201) {
    throw new Error(`Companion attachment upload failed with HTTP ${String(response.status)}`)
  }
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error('Companion attachment upload returned invalid JSON')
  }
  options.permit.requireCurrent()
  if (!isRecord(value) || value.byteLength !== sealed.ciphertext.byteLength
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= 0) {
    throw new Error('Companion attachment upload returned an invalid capability grant')
  }
  const offer = buildCompanionAttachmentOffer({
    capability: parseAttachmentCapability(value.capability),
    ciphertextSha256: sealed.ciphertextSha256,
    byteLength: sealed.ciphertext.byteLength,
    expiresAt: value.expiresAt as number,
    fileName: file.name,
    mediaType: file.type === '' ? 'application/octet-stream' : file.type,
  }, options.operationId, options.sessionId, options.permit)
  options.permit.requireCurrent()
  try {
    await options.send(offer)
    options.permit.requireCurrent()
  } catch (cause) {
    throw new CompanionAttachmentDeliveryUncertainError(options.operationId, cause)
  }
  return offer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
