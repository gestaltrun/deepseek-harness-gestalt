/**
 * Pairing-scoped encrypted attachment blob store and one-time capabilities.
 * @module @deepseek-ai/dsh-remote-attachments
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  REMOTE_PROTOCOL_LIMITS,
  type AttachmentCapability,
} from '@deepseek-ai/dsh-remote-protocol'
import z from '@deepseek-ai/schemastery'

/** Stable attachment blob store failure categories; none carry application data. */
export type RemoteAttachmentErrorCode =
  | 'ATTACHMENT_CAPABILITY_INVALID'
  | 'ATTACHMENT_EMPTY'
  | 'ATTACHMENT_EXPIRED'
  | 'ATTACHMENT_PAIRING_MISMATCH'
  | 'ATTACHMENT_LIMIT_EXCEEDED'
  | 'ATTACHMENT_CAPACITY'

/** Attachment blob store failure. */
export class RemoteAttachmentError extends Error {
  /** @param code - failure category. @param message - operator-facing diagnosis. */
  constructor(readonly code: RemoteAttachmentErrorCode, message: string) {
    super(message)
    this.name = 'RemoteAttachmentError'
  }
}

/** Capability, ciphertext, and pairing scope retained for one not-yet-consumed blob. */
export interface RemoteAttachmentBlob {
  /** SHA-256 digest of the bearer capability; the retained state never exposes the bearer itself. */
  capabilityDigest: Uint8Array
  pairingId: PersonalPairingId
  ciphertext: Uint8Array
  expiresAt: number
}

/** Capability grant returned to Mobile after one ciphertext upload. */
export interface RemoteAttachmentGrant {
  capability: AttachmentCapability
  byteLength: number
  expiresAt: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteAttachments: RemoteAttachmentStoreService
  }
}

/**
 * Platform attachment blob store: retains ciphertext and metadata only, bounded per blob
 * and in total, scoped to exactly one Personal Pairing, single-use, and expiring.
 */
export abstract class RemoteAttachmentStoreService extends Service {
  /** @param ctx - Platform composition context receiving the store capability. */
  constructor(ctx: Context) { super(ctx, 'remoteAttachments') }

  /** Per-blob ciphertext ceiling this deployment enforces; never above the protocol ceiling. */
  abstract readonly maxBlobBytes: number

  /** Capability and blob lifetime this deployment enforces; never above the protocol default. */
  abstract readonly capabilityLifetimeMs: number

  /**
   * Retain one pairing-scoped ciphertext blob and issue its one-time capability.
   * @param input - owning Personal Pairing, endpoint-encrypted ciphertext, and current time.
   * @returns the capability grant Mobile forwards to Desktop.
   */
  abstract publish(input: { pairingId: PersonalPairingId; ciphertext: Uint8Array; now: number }): Promise<RemoteAttachmentGrant>

  /**
   * Return a copy of one retained ciphertext without consuming the capability.
   * @param input - requesting Personal Pairing, one-time capability, and current time.
   * @returns a copy of the retained ciphertext bytes.
   */
  abstract inspect(input: { pairingId: PersonalPairingId; capability: AttachmentCapability; now: number }): Promise<Uint8Array>

  /**
   * Exchange one capability for its ciphertext exactly once, then remove both.
   * @param input - requesting Personal Pairing, one-time capability, and current time.
   * @returns a copy of the retained ciphertext bytes.
   */
  abstract consume(input: { pairingId: PersonalPairingId; capability: AttachmentCapability; now: number }): Promise<Uint8Array>

  /**
   * Remove one blob and its capability regardless of remaining lifetime.
   * @param input - owning Personal Pairing and the capability whose blob is revoked.
   * A pairing mismatch fails explicitly; an unknown capability is a no-op.
   */
  abstract revoke(input: { pairingId: PersonalPairingId; capability: AttachmentCapability }): Promise<void>

  /**
   * Project every retained blob for Platform-side operations.
   * @returns copies of ciphertext and metadata only; no plaintext exists on this side of the boundary.
   */
  abstract observe(): readonly RemoteAttachmentBlob[] | Promise<readonly RemoteAttachmentBlob[]>
}

interface StoredEntry {
  pairingId: PersonalPairingId
  ciphertext: Uint8Array
  expiresAt: number
}

/** Deployment bounds for the in-process store, reachable from cordis.yml. */
export interface Config {
  /** Per-blob ciphertext ceiling; defaults to the accepted protocol ceiling. */
  maxBlobBytes?: number
  /** Capability lifetime; defaults to the accepted fifteen-minute default. */
  capabilityLifetimeMs?: number
  /** Maximum simultaneously retained blobs; capacity failures are explicit. */
  maxRetainedBlobs: number
  /** Interval removing expired blobs in the background. */
  sweepIntervalMs: number
}

/** Validated in-process store configuration. */
export const Config: z<Config> = z.object({
  maxBlobBytes: z.natural().min(1).max(REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes)
    .default(REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes),
  capabilityLifetimeMs: z.natural().min(1).max(REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs)
    .default(REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs),
  maxRetainedBlobs: z.natural().min(1).required(),
  sweepIntervalMs: z.natural().min(1).required(),
})

/** In-process provider construction inputs, including the test schedule hook. */
export interface RemoteAttachmentStoreOptions extends Config {
  /** Schedule backend for the re-arming sweep timer; defaults to `setTimeout`. */
  schedule?: (handler: () => void, ms: number) => { unref(): void; cancel(): void }
}

/** Cordis plugin name. */
export const name = 'remote-attachments'

/**
 * Mount the in-process attachment blob store from validated deployment bounds.
 * @param ctx - Platform composition context.
 * @param config - per-blob ceiling, lifetime, retained-blob capacity, and sweep interval.
 */
export function apply(ctx: Context, config: Config): void {
  new RemoteAttachmentStoreProvider(ctx, config)
}

/**
 * In-process bounded store matching the single-process Platform deployment.
 * Expiry is enforced lazily at every access and by a background sweep.
 */
export class RemoteAttachmentStoreProvider extends RemoteAttachmentStoreService {
  readonly maxBlobBytes: number
  readonly capabilityLifetimeMs: number
  private readonly maxRetainedBlobs: number
  private readonly entries = new Map<string, StoredEntry>()
  private sweepTimer: { unref(): void; cancel(): void } | undefined
  private disposed = false

  /** @param ctx - Platform composition context. @param options - validated deployment bounds. */
  constructor(ctx: Context, options: RemoteAttachmentStoreOptions) {
    super(ctx)
    this.maxBlobBytes = options.maxBlobBytes ?? REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes
    this.capabilityLifetimeMs = options.capabilityLifetimeMs ?? REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs
    this.maxRetainedBlobs = options.maxRetainedBlobs
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes <= 0
      || this.maxBlobBytes > REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes) {
      throw new TypeError('Remote attachment maxBlobBytes must be a positive integer within the protocol ceiling')
    }
    if (!Number.isSafeInteger(this.capabilityLifetimeMs) || this.capabilityLifetimeMs <= 0
      || this.capabilityLifetimeMs > REMOTE_PROTOCOL_LIMITS.attachmentCapabilityLifetimeMs) {
      throw new TypeError('Remote attachment capabilityLifetimeMs must be a positive integer within the protocol default')
    }
    if (!Number.isSafeInteger(this.maxRetainedBlobs) || this.maxRetainedBlobs <= 0) {
      throw new TypeError('Remote attachment maxRetainedBlobs must be a positive integer')
    }
    if (!Number.isSafeInteger(options.sweepIntervalMs) || options.sweepIntervalMs <= 0) {
      throw new TypeError('Remote attachment sweepIntervalMs must be a positive integer')
    }
    const schedule = options.schedule ?? ((handler: () => void, ms: number) => {
      const timer = setTimeout(handler, ms)
      return {
        unref() { timer.unref() },
        cancel() { clearTimeout(timer) },
      }
    })
    this.sweepTimer = this.armSweep(schedule, options.sweepIntervalMs)
    ctx.effect(() => () => { this.dispose() }, 'remote-attachments: retained blobs')
  }

  /** Arm the next sweep tick; the timer re-arms itself until disposal cancels it. */
  private armSweep(schedule: NonNullable<RemoteAttachmentStoreOptions['schedule']>, ms: number): { unref(): void; cancel(): void } {
    const timer = schedule(() => {
      this.sweep(Date.now())
      if (!this.disposed) this.sweepTimer = this.armSweep(schedule, ms)
    }, ms)
    timer.unref()
    return timer
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps the failure a rejection, not a synchronous throw
  override async publish(input: {
    pairingId: PersonalPairingId
    ciphertext: Uint8Array
    now: number
  }): Promise<RemoteAttachmentGrant> {
    if (input.ciphertext.byteLength === 0) {
      throw new RemoteAttachmentError('ATTACHMENT_EMPTY', 'Remote attachment ciphertext must not be empty')
    }
    if (input.ciphertext.byteLength > this.maxBlobBytes) {
      throw new RemoteAttachmentError('ATTACHMENT_LIMIT_EXCEEDED', 'Remote attachment exceeds the per-blob byte ceiling')
    }
    this.sweep(input.now)
    if (this.entries.size >= this.maxRetainedBlobs) {
      throw new RemoteAttachmentError('ATTACHMENT_CAPACITY', 'Remote attachment store is at capacity')
    }
    const capability = randomBytes(32).toString('base64url') as AttachmentCapability
    const entry: StoredEntry = {
      pairingId: input.pairingId,
      ciphertext: input.ciphertext.slice(),
      expiresAt: input.now + this.capabilityLifetimeMs,
    }
    this.entries.set(capability, entry)
    return { capability, byteLength: entry.ciphertext.byteLength, expiresAt: entry.expiresAt }
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps the failure a rejection, not a synchronous throw
  override async inspect(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<Uint8Array> {
    return this.requireEntry(input).ciphertext.slice()
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps the failure a rejection, not a synchronous throw
  override async consume(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): Promise<Uint8Array> {
    const entry = this.requireEntry(input)
    this.entries.delete(input.capability)
    return entry.ciphertext.slice()
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps the failure a rejection, not a synchronous throw
  override async revoke(input: { pairingId: PersonalPairingId; capability: AttachmentCapability }): Promise<void> {
    const entry = this.entries.get(input.capability)
    if (entry === undefined) return
    if (entry.pairingId !== input.pairingId) {
      throw new RemoteAttachmentError('ATTACHMENT_PAIRING_MISMATCH', 'Remote attachment capability belongs to another Personal Pairing')
    }
    this.entries.delete(input.capability)
  }

  override observe(): readonly RemoteAttachmentBlob[] {
    return [...this.entries].map(([capability, entry]) => ({
      capabilityDigest: new Uint8Array(createHash('sha256').update(capability).digest()),
      pairingId: entry.pairingId,
      ciphertext: entry.ciphertext.slice(),
      expiresAt: entry.expiresAt,
    }))
  }

  /** Remove every retained blob and capability, and cancel the background sweep. */
  dispose(): void {
    this.disposed = true
    this.sweepTimer?.cancel()
    this.sweepTimer = undefined
    this.sweep(Number.MAX_SAFE_INTEGER)
  }

  private requireEntry(input: {
    pairingId: PersonalPairingId
    capability: AttachmentCapability
    now: number
  }): StoredEntry {
    const entry = this.entries.get(input.capability)
    if (entry === undefined) {
      throw new RemoteAttachmentError('ATTACHMENT_CAPABILITY_INVALID', 'Remote attachment capability is unknown, consumed, or revoked')
    }
    if (input.now >= entry.expiresAt) {
      this.entries.delete(input.capability)
      throw new RemoteAttachmentError('ATTACHMENT_EXPIRED', 'Remote attachment capability has expired')
    }
    if (entry.pairingId !== input.pairingId) {
      throw new RemoteAttachmentError('ATTACHMENT_PAIRING_MISMATCH', 'Remote attachment capability belongs to another Personal Pairing')
    }
    return entry
  }

  private sweep(now: number): void {
    for (const [capability, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(capability)
    }
  }
}
