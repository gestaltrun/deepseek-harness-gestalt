/**
 * Browser listing poll over `GET /phone/devices`. Matches Host
 * `phone-runtime` `pollIntervalMs` default 5000 ms; the browser has no Host
 * change stream for the fleet route. A failed refresh keeps the last
 * committed listing.
 */
import type { PhoneListingSource } from './registry.ts'

/**
 * Browser listing poll cadence. Matches Host `phone-runtime` `pollIntervalMs`
 * default 5000 ms; the browser has no Host change stream for `GET /phone/devices`.
 */
export const PHONE_LISTING_POLL_INTERVAL_MS = 5_000

/**
 * Start a `GET /phone/devices` poll against one listing source.
 * @param listing - Host fleet listing the picker, connected dropdown, or
 *   settings card already consume.
 * @returns disposer that stops the interval.
 */
export function startPhoneListingPoll(listing: PhoneListingSource): () => void {
  const handle = setInterval(() => {
    void listing.refresh().catch(() => {
      // A refused or malformed GET keeps the last committed snapshot;
      // the next interval retries.
    })
  }, PHONE_LISTING_POLL_INTERVAL_MS)
  return () => { clearInterval(handle) }
}
