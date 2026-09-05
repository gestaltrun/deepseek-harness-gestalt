import type { PhoneCaptureId } from '@deepseek-ai/dsh-phone-runtime'

/** Package-private single-use capture grant ownership. */
export class CaptureGrantLedger {
  private readonly spent = new Map<PhoneCaptureId, number>()

  /** Consume one grant after pruning entries strictly older than now.
   * @param id - Signed capture identity.
   * @param expiresAt - Inclusive grant expiry.
   * @param now - Current epoch milliseconds.
   * @returns false when this still-live grant was already spent.
   */
  consume(id: PhoneCaptureId, expiresAt: number, now: number): boolean {
    this.prune(now)
    if (this.spent.has(id)) return false
    this.spent.set(id, expiresAt)
    return true
  }

  /** Return retained live spent grants.
   * @returns retained entry count.
   */
  ownershipSnapshot(): number {
    return this.spent.size
  }

  private prune(now: number): void {
    for (const [id, expiresAt] of this.spent) if (expiresAt < now) this.spent.delete(id)
  }
}
