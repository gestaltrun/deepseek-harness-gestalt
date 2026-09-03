/**
 * Listing-backed settings-card source: a mounted phoneDevices fleet
 * (GET /phone/devices) reaches probing, both wizards, and ready; only a
 * failed first pull falls back to the missing-service probe-failed row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createListingPhoneEnvironmentSource } from '../src/client/phone-environment-listing.ts'
import { MOBILECLI_MISSING_ERROR, PROBE_FAILED_ERROR } from '../src/client/phone-environment.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'
import { FakeListingSource, listingOf } from './phone-fakes.client.ts'
import type { PhoneDeviceSummary } from '../src/client/registry.ts'

afterEach(() => { vi.unstubAllGlobals() })

const ANDROID_EMULATOR: PhoneDeviceSummary = {
  id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true,
}
const ANDROID_USB: PhoneDeviceSummary = {
  id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'online', online: true,
}
const IOS_SIMULATOR: PhoneDeviceSummary = {
  id: 'iPhone-16', name: 'iPhone 16 Pro', channel: 'emulator', state: 'offline', online: false,
}
const IOS_USB: PhoneDeviceSummary = {
  id: 'UDID-9', name: 'iPhone', channel: 'usb', state: 'unauthorized', online: false,
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('createListingPhoneEnvironmentSource', () => {
  it('stays on the probe-failed row until the first pull starts', () => {
    const source = createListingPhoneEnvironmentSource(new FakeListingSource())
    expect(source.getView()).toEqual({ kind: 'errors', errors: [PROBE_FAILED_ERROR] })
  })

  it('renders probing while the first fleet pull is in flight', async () => {
    const listing = new FakeListingSource()
    const hold = deferred()
    listing.scriptNext(hold.promise)
    const source = createListingPhoneEnvironmentSource(listing)
    const pending = Promise.resolve(source.redetect())
    const view = source.getView()
    expect(view.kind).toBe('probing')
    if (view.kind === 'probing') {
      expect(view.checks.map(check => check.id)).toEqual(['adb', 'mobilecli', 'android-avd', 'ios-runtime'])
      expect(view.checks.find(check => check.id === 'mobilecli')?.status).toBe('pending')
    }
    hold.resolve()
    await pending
  })

  it('renders the ready inventory once the fleet lists devices', async () => {
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf([ANDROID_EMULATOR, ANDROID_USB], [IOS_SIMULATOR, IOS_USB]))
    const source = createListingPhoneEnvironmentSource(listing)
    await source.redetect()
    const view = source.getView()
    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') throw new Error('expected ready')
    expect(view.availableCount).toBe(2)
    expect(view.devices.map(device => device.group)).toEqual([
      'android-emulator', 'usb', 'ios-simulator', 'usb',
    ])
    expect(view.devices[0]?.name).toBe('Pixel_6_API_35')
    expect(view.devices[2]?.meta).toContain('已停止')
    expect(view.devices[3]?.meta).toBe('未授权 · UDID-9')
  })

  it('renders the Android wizard when a successful pull finds no Android emulator', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf())
    const source = createListingPhoneEnvironmentSource(listing)
    await source.redetect()
    expect(source.getView()).toEqual({ kind: 'android-wizard', platformToolsInstalled: true })
  })

  it('renders the iOS wizard when a successful pull finds no simulator on macOS', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf())
    const source = createListingPhoneEnvironmentSource(listing)
    await source.redetect()
    expect(source.getView()).toEqual({ kind: 'ios-wizard' })
  })

  it('falls back to probe-failed when the first fleet pull fails', async () => {
    const listing = new FakeListingSource()
    listing.scriptNext(Promise.reject(new Error('phoneDevices unavailable')))
    const source = createListingPhoneEnvironmentSource(listing)
    await source.redetect()
    expect(source.getView()).toEqual({ kind: 'errors', errors: [PROBE_FAILED_ERROR] })
  })

  it('renders the mobilecli-missing row when the Host reports PHONE_UNRESOLVED', async () => {
    const listing = new FakeListingSource()
    listing.scriptNext(Promise.reject(new PhoneStreamHttpError(
      502,
      'PHONE_UNRESOLVED',
      'phone-runtime: cannot resolve the mobilecli executable.\n  npm install -g mobilecli@latest',
    )))
    const source = createListingPhoneEnvironmentSource(listing)
    await source.redetect()
    expect(source.getView()).toEqual({ kind: 'errors', errors: [MOBILECLI_MISSING_ERROR] })
    expect(MOBILECLI_MISSING_ERROR.command).toBe('npm install -g mobilecli@latest')
  })

  it('notifies subscribers when a pull settles', async () => {
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf([ANDROID_EMULATOR]))
    const source = createListingPhoneEnvironmentSource(listing)
    const seen: string[] = []
    const stop = source.subscribe(() => { seen.push(source.getView().kind) })
    await source.redetect()
    expect(seen).toContain('ready')
    stop()
  })
})
