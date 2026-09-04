/**
 * Session Surface listing poll: GET /phone/devices on the Host interval,
 * last committed listing on failure, disposer stops later ticks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PHONE_LISTING_POLL_INTERVAL_MS, startPhoneListingPoll } from '../src/client/phone-listing-poll.ts'
import { FakeListingSource, listingOf } from './phone-fakes.client.ts'

afterEach(() => { vi.useRealTimers() })

describe('startPhoneListingPoll', () => {
  it('commits a later USB real and keeps it when the next tick fails', async () => {
    vi.useFakeTimers()
    const listing = new FakeListingSource()
    const stop = startPhoneListingPoll(listing)
    listing.scriptNext(listingOf([], [{
      id: '00008150-0008545C2608401C',
      name: '贝贝猫的iPhone',
      channel: 'usb',
      state: 'online',
      online: true,
    }]))
    await vi.advanceTimersByTimeAsync(PHONE_LISTING_POLL_INTERVAL_MS)
    expect(listing.snapshot().ios[0]?.name).toBe('贝贝猫的iPhone')
    listing.scriptNext(new Error('host down'))
    await vi.advanceTimersByTimeAsync(PHONE_LISTING_POLL_INTERVAL_MS)
    expect(listing.snapshot().ios[0]?.name).toBe('贝贝猫的iPhone')
    stop()
    listing.scriptNext(listingOf())
    await vi.advanceTimersByTimeAsync(PHONE_LISTING_POLL_INTERVAL_MS)
    expect(listing.refreshCount).toBe(2)
    expect(listing.snapshot().ios[0]?.name).toBe('贝贝猫的iPhone')
  })
})
