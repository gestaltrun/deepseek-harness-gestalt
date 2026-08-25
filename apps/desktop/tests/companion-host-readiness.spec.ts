import { describe, expect, it, vi } from 'vitest'
import { startDesktopPairingWhenHostReady } from '../src/companion-host-readiness.ts'

describe('Desktop Companion Host readiness', () => {
  it.each([
    { accountSignedIn: false, hostReady: false },
    { accountSignedIn: true, hostReady: false },
    { accountSignedIn: false, hostReady: true },
  ])('keeps Relay pairing stopped for $accountSignedIn/$hostReady', async (state) => {
    const start = vi.fn(async () => {})
    const stopStaleStart = vi.fn(async () => {})

    await expect(startDesktopPairingWhenHostReady({
      ...state, start, stopStaleStart, authorityIsCurrent: () => false,
    })).resolves.toBe(false)
    expect(start).not.toHaveBeenCalled()
    expect(stopStaleStart).not.toHaveBeenCalled()
  })

  it('starts Relay pairing after Account and Host authority are both ready', async () => {
    const start = vi.fn(async () => {})

    await expect(startDesktopPairingWhenHostReady({
      accountSignedIn: true,
      hostReady: true,
      start,
      authorityIsCurrent: () => true,
      stopStaleStart: vi.fn(),
    })).resolves.toBe(true)
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps resume stopped until replacement Host authority becomes ready', async () => {
    const start = vi.fn(async () => {})
    const stopStaleStart = vi.fn(async () => {})
    let hostReady = false
    const state = {
      accountSignedIn: true,
      get hostReady() { return hostReady },
      start,
      authorityIsCurrent: () => hostReady,
      stopStaleStart,
    }

    await expect(startDesktopPairingWhenHostReady(state)).resolves.toBe(false)
    hostReady = true
    await expect(startDesktopPairingWhenHostReady(state)).resolves.toBe(true)
    expect(start).toHaveBeenCalledOnce()
    expect(stopStaleStart).not.toHaveBeenCalled()
  })

  it('stops a delayed start when its Host generation exits before readiness settles', async () => {
    let finishStart = (): void => {}
    const start = vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve }))
    const stopStaleStart = vi.fn(async () => {})
    let current = true
    const starting = startDesktopPairingWhenHostReady({
      accountSignedIn: true,
      hostReady: true,
      start,
      authorityIsCurrent: () => current,
      stopStaleStart,
    })
    await vi.waitFor(() => { expect(start).toHaveBeenCalledOnce() })
    current = false
    finishStart()

    await expect(starting).resolves.toBe(false)
    expect(stopStaleStart).toHaveBeenCalledOnce()
  })
})
