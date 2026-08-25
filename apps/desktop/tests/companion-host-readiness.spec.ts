import { describe, expect, it, vi } from 'vitest'
import { startDesktopPairingWhenHostReady } from '../src/companion-host-readiness.ts'

describe('Desktop Companion Host readiness', () => {
  it.each([
    { accountSignedIn: false, hostReady: false },
    { accountSignedIn: true, hostReady: false },
    { accountSignedIn: false, hostReady: true },
  ])('keeps Relay pairing stopped for $accountSignedIn/$hostReady', async (state) => {
    const start = vi.fn(async () => true)

    await expect(startDesktopPairingWhenHostReady({
      ...state, start, authorityIsCurrent: () => false,
    })).resolves.toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('starts Relay pairing after Account and Host authority are both ready', async () => {
    const start = vi.fn(async (authorityIsCurrent: () => boolean) => authorityIsCurrent())

    await expect(startDesktopPairingWhenHostReady({
      accountSignedIn: true,
      hostReady: true,
      start,
      authorityIsCurrent: () => true,
    })).resolves.toBe(true)
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps resume stopped until replacement Host authority becomes ready', async () => {
    const start = vi.fn(async (authorityIsCurrent: () => boolean) => authorityIsCurrent())
    let hostReady = false
    const state = {
      accountSignedIn: true,
      get hostReady() { return hostReady },
      start,
      authorityIsCurrent: () => hostReady,
    }

    await expect(startDesktopPairingWhenHostReady(state)).resolves.toBe(false)
    hostReady = true
    await expect(startDesktopPairingWhenHostReady(state)).resolves.toBe(true)
    expect(start).toHaveBeenCalledOnce()
  })

  it('delegates a delayed authority decision to the pairing lifecycle owner', async () => {
    let finishStart = (): void => {}
    const start = vi.fn(async (authorityIsCurrent: () => boolean) => {
      await new Promise<void>((resolve) => { finishStart = resolve })
      return authorityIsCurrent()
    })
    let current = true
    const starting = startDesktopPairingWhenHostReady({
      accountSignedIn: true,
      hostReady: true,
      start,
      authorityIsCurrent: () => current,
    })
    await vi.waitFor(() => { expect(start).toHaveBeenCalledOnce() })
    current = false
    finishStart()

    await expect(starting).resolves.toBe(false)
  })
})
