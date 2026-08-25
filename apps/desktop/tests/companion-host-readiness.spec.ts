import { describe, expect, it, vi } from 'vitest'
import { startDesktopPairingWhenHostReady } from '../src/companion-host-readiness.ts'

describe('Desktop Companion Host readiness', () => {
  it.each([
    { accountSignedIn: false, hostReady: false },
    { accountSignedIn: true, hostReady: false },
    { accountSignedIn: false, hostReady: true },
  ])('keeps Relay pairing stopped for $accountSignedIn/$hostReady', async (state) => {
    const start = vi.fn(async () => {})

    await expect(startDesktopPairingWhenHostReady({ ...state, start })).resolves.toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('starts Relay pairing after Account and Host authority are both ready', async () => {
    const start = vi.fn(async () => {})

    await expect(startDesktopPairingWhenHostReady({
      accountSignedIn: true,
      hostReady: true,
      start,
    })).resolves.toBe(true)
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps resume stopped until replacement Host authority becomes ready', async () => {
    const start = vi.fn(async () => {})
    const state = { accountSignedIn: true, hostReady: false, start }

    await expect(startDesktopPairingWhenHostReady(state)).resolves.toBe(false)
    state.hostReady = true
    await expect(startDesktopPairingWhenHostReady(state)).resolves.toBe(true)
    expect(start).toHaveBeenCalledOnce()
  })
})
