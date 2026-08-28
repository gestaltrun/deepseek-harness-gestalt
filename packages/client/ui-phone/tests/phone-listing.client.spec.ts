/**
 * The listing source that consumes the Host `GET /phone/devices` route:
 * wire validation, kind→channel mapping, commit-only-on-success with
 * subscriber notification, snapshot identity between commits, and the
 * badge online count — against stubbed browser globals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPhoneListingSource, PHONE_DEVICES_PATH } from '../src/client/phone-listing.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'

afterEach(() => { vi.unstubAllGlobals() })

const WIRE_LISTING = {
  android: [
    { id: 'emulator-5554', name: 'Pixel_6_API_35', kind: 'emulator', online: true },
    { id: 'R3CN30', name: 'SM-S9310', kind: 'real', online: false },
  ],
  ios: {
    simulators: [{ id: 'iPhone-16', name: 'iPhone 16', kind: 'simulator', online: true }],
    reals: [{ id: 'UDID-9', name: 'iPhone', kind: 'real', online: false }],
  },
}

function stubFetch(status: number, body: unknown): { input: RequestInfo | URL; init: RequestInit } {
  const seen: { input: RequestInfo | URL; init: RequestInit } = {} as never
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.input = input
    seen.init = init ?? {}
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }))
  return seen
}

describe('phone listing source', () => {
  it('starts empty and quiet before the first commit', () => {
    const source = createHttpPhoneListingSource()
    expect(source.snapshot()).toEqual({ android: [], ios: [] })
    expect(source.getBadge()).toEqual({ onlineCount: 0 })
  })

  it('pulls the grouped listing, maps kinds onto channels, and counts online devices', async () => {
    const seen = stubFetch(200, WIRE_LISTING)
    const source = createHttpPhoneListingSource()
    await source.refresh()
    expect(seen.input).toBe(PHONE_DEVICES_PATH)
    expect(seen.init.method).toBe('GET')
    expect(source.snapshot()).toEqual({
      android: [
        { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', online: true },
        { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', online: false },
      ],
      ios: [
        { id: 'iPhone-16', name: 'iPhone 16', channel: 'emulator', online: true },
        { id: 'UDID-9', name: 'iPhone', channel: 'usb', online: false },
      ],
    })
    expect(source.getBadge()).toEqual({ onlineCount: 2 })
  })

  it('notifies subscribers only when a refresh commits', async () => {
    stubFetch(200, WIRE_LISTING)
    const source = createHttpPhoneListingSource()
    const commits: number[] = []
    source.subscribe(() => { commits.push(commits.length + 1) })
    await source.refresh()
    expect(commits).toEqual([1])
    stubFetch(500, 'upstream down')
    await expect(source.refresh()).rejects.toBeInstanceOf(PhoneStreamHttpError)
    expect(commits).toEqual([1])
  })

  it('keeps the committed listing when the Host refuses or sends a malformed body', async () => {
    stubFetch(200, WIRE_LISTING)
    const source = createHttpPhoneListingSource()
    await source.refresh()
    const committed = source.snapshot()

    stubFetch(403, { error: { code: 'forbidden', message: 'forbidden' } })
    const refused = await source.refresh().catch(error => error)
    expect(refused).toBeInstanceOf(PhoneStreamHttpError)
    expect(refused.status).toBe(403)

    stubFetch(200, { android: 'nope', ios: {} })
    const malformed = await source.refresh().catch(error => error)
    expect(malformed).toBeInstanceOf(PhoneStreamHttpError)
    expect(malformed.code).toBe('http')

    stubFetch(200, WIRE_LISTING)
    expect(source.snapshot()).toBe(committed)
  })

  it.each([
    ['the body is not JSON', 'not json'],
    ['the body is not an object', [42]],
    ['the ios section is missing', { android: [] }],
    ['an android entry is not an object', { android: [42], ios: { simulators: [], reals: [] } }],
    ['a ref id is missing', { android: [{ name: 'x', kind: 'real', online: true }], ios: { simulators: [], reals: [] } }],
    ['a ref name is missing', { android: [{ id: 'x', kind: 'real', online: true }], ios: { simulators: [], reals: [] } }],
    ['a ref online flag is missing', { android: [{ id: 'x', name: 'x', kind: 'real' }], ios: { simulators: [], reals: [] } }],
    ['an ios group is missing', { android: [], ios: { reals: [] } }],
    ['an ios ref is broken', { android: [], ios: { simulators: [], reals: [{ id: 'x' }] } }],
  ])('classifies a listing where %s as a wire error', async (_label, body) => {
    stubFetch(200, body)
    const source = createHttpPhoneListingSource()
    await expect(source.refresh()).rejects.toBeInstanceOf(PhoneStreamHttpError)
    expect(source.snapshot()).toEqual({ android: [], ios: [] })
  })

  it('classifies an unknown device kind as a wire error', async () => {
    stubFetch(200, {
      android: [{ id: 'x', name: 'x', kind: 'tv', online: true }],
      ios: { simulators: [], reals: [] },
    })
    const source = createHttpPhoneListingSource()
    await expect(source.refresh()).rejects.toBeInstanceOf(PhoneStreamHttpError)
    expect(source.snapshot()).toEqual({ android: [], ios: [] })
  })

  it('carries the unauthorized flag and OS version through the wire contract', async () => {
    stubFetch(200, {
      android: [
        { id: 'R3CN30', name: 'SM-S9310', kind: 'real', online: true, unauthorized: true },
        { id: 'emulator-5554', name: 'Pixel_6_API_35', kind: 'emulator', online: true, osVersion: 'Android 15' },
      ],
      ios: { simulators: [], reals: [] },
    })
    const source = createHttpPhoneListingSource()
    await source.refresh()
    expect(source.snapshot().android).toEqual([
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', online: true, unauthorized: true },
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', online: true, osVersion: 'Android 15' },
    ])
    // Absent optional fields stay absent rather than materializing defaults.
    stubFetch(200, WIRE_LISTING)
    await source.refresh()
    expect(source.snapshot().android[0]).not.toHaveProperty('unauthorized')
    expect(source.snapshot().android[0]).not.toHaveProperty('osVersion')
  })

  it('rejects a non-boolean unauthorized flag or blank OS version as a wire error', async () => {
    stubFetch(200, {
      android: [{ id: 'x', name: 'x', kind: 'real', online: true, unauthorized: 'yes' }],
      ios: { simulators: [], reals: [] },
    })
    const source = createHttpPhoneListingSource()
    await expect(source.refresh()).rejects.toBeInstanceOf(PhoneStreamHttpError)
    stubFetch(200, {
      android: [{ id: 'x', name: 'x', kind: 'real', online: true, osVersion: '' }],
      ios: { simulators: [], reals: [] },
    })
    await expect(source.refresh()).rejects.toBeInstanceOf(PhoneStreamHttpError)
  })

  it('stops notifying after the subscription is disposed', async () => {
    stubFetch(200, WIRE_LISTING)
    const source = createHttpPhoneListingSource()
    const commits: number[] = []
    const dispose = source.subscribe(() => { commits.push(commits.length + 1) })
    dispose()
    await source.refresh()
    expect(commits).toEqual([])
  })

  it('wraps network refusals as status-0 wire errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('load failed')
    }))
    const source = createHttpPhoneListingSource()
    const network = await source.refresh().catch(error => error)
    expect(network).toBeInstanceOf(PhoneStreamHttpError)
    expect(network.status).toBe(0)
  })

  it('keeps the snapshot reference stable between commits', async () => {
    stubFetch(200, WIRE_LISTING)
    const source = createHttpPhoneListingSource()
    const before = source.snapshot()
    await source.refresh()
    expect(source.snapshot()).not.toBe(before)
    expect(source.snapshot()).toBe(source.snapshot())
  })
})
