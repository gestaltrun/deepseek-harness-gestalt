/** Open-registration quotas and capacity shedding for Personal Pairing Platform. */

import {
  ACCOUNT_OPEN_REGISTRATION_QUOTAS,
  OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  type PlatformCapacityState,
} from '@deepseek-ai/dsh-platform-account'

/** Stable error code for capacity watermarks. */
export const PLATFORM_CAPACITY = 'PLATFORM_CAPACITY'
/** Sliding pairing-challenge window. */
export const PAIRING_CHALLENGE_QUOTA_WINDOW_MS = 60 * 60 * 1000
/** Sliding blob-upload window. */
export const ACCOUNT_DAILY_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000

export { OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS }

/** Open-registration ceilings. */
export const OPEN_REGISTRATION_QUOTAS = {
  ...ACCOUNT_OPEN_REGISTRATION_QUOTAS,
  personalPairings: 50,
  pairingChallengesPerAccountPerHour: 10,
  pairingChallengesPerIpPerHour: 30,
  concurrentBlobs: 5,
  blobBytes: 100 * 1024 * 1024,
  blobBytesPerAccountPerDay: 1024 * 1024 * 1024,
} as const

/** Shared capacity watermark that sheds new acquisitions while live attachments remain. */
export class MemoryPlatformCapacityGate implements PlatformCapacityState {
  private attachments = 0

  /**
   * @param maxAttachments - deployment-varying live WSS watermark.
   * @param retryAfterMs - deployment-varying retry delay returned on shed.
   */
  constructor(readonly maxAttachments: number, readonly retryAfterMs: number) {
    if (!Number.isSafeInteger(maxAttachments) || maxAttachments < 1) {
      throw new TypeError('Platform capacity maxAttachments must be a positive integer')
    }
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1) {
      throw new TypeError('Platform capacity retryAfterMs must be a positive integer')
    }
  }

  /** Whether new login, pairing, blob, or WSS attach must be shed. */
  get shedding(): boolean {
    return this.attachments >= this.maxAttachments
  }

  /** HTTP retry delay in seconds. */
  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1_000))
  }

  /**
   * Reserve one live attachment slot.
   * @returns false when the watermark is already full.
   */
  tryAcquire(): boolean {
    if (this.shedding) return false
    this.attachments += 1
    return true
  }

  /** Release one live attachment slot after close. */
  release(): void {
    if (this.attachments > 0) this.attachments -= 1
  }
}

/**
 * Remaining seconds until `timestamp` plus `windowMs`.
 * @param timestamp - oldest event in the window.
 * @param windowMs - sliding window length.
 * @param now - current epoch milliseconds.
 * @returns at least one second.
 */
export function retryAfterSecondsUntil(timestamp: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((timestamp + windowMs - now) / 1_000))
}
