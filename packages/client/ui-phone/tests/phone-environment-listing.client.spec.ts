/**
 * Listing-backed settings-card source: a mounted phoneDevices fleet
 * (GET /phone/devices) reaches probing, no-device recovery, and ready; only a
 * failed first pull falls back to the missing-service probe-failed row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createListingPhoneEnvironmentSource, PHONE_LISTING_POLL_INTERVAL_MS,
} from '../src/client/phone-environment-listing.ts'
import { MOBILECLI_MISSING_ERROR, PROBE_FAILED_ERROR } from '../src/client/phone-environment.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'
import { FakeListingSource, listingOf } from './phone-fakes.client.ts'
import type { PhoneDeviceSummary } from '../src/client/registry.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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

  it('renders platform-neutral recovery without reading browser platform', async () => {
    const navigator = Object.defineProperty({}, 'platform', {
      get() { throw new Error('browser platform must not decide Host capability') },
    })
    vi.stubGlobal('navigator', navigator)
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf())
    const source = createListingPhoneEnvironmentSource(listing)
    await source.redetect()
    expect(source.getView()).toEqual({
      kind: 'errors',
      errors: [{
        kind: 'no-devices',
        title: '当前没有可用设备',
        detail: '上方 Android / iOS 分栏显示本机可准备的模拟器环境；USB 真机完成授权后也会出现在这里。',
        nextAction: '重新检测',
      }],
    })
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
    expect(MOBILECLI_MISSING_ERROR).toMatchObject({ nextAction: '准备 mobilecli' })
    expect(MOBILECLI_MISSING_ERROR.command).toBeUndefined()
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

  it('shows 已停止 after a later listing commit without calling redetect', async () => {
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf([], [{
      id: 'CB65BAB1-E388-4C27-B9AB-81CFB37920C3',
      name: 'DSH Gestalt iPhone',
      channel: 'emulator',
      state: 'online',
      online: true,
    }]))
    const source = createListingPhoneEnvironmentSource(listing)
    const kinds: string[] = []
    const stop = source.subscribe(() => { kinds.push(source.getView().kind) })
    await source.redetect()
    const online = source.getView()
    expect(online.kind).toBe('ready')
    if (online.kind !== 'ready') throw new Error('expected ready')
    expect(online.devices[0]?.online).toBe(true)
    expect(online.devices[0]?.meta).toContain('运行中')
    expect(listing.refreshCount).toBe(1)

    listing.scriptNext(listingOf([], [{
      id: 'CB65BAB1-E388-4C27-B9AB-81CFB37920C3',
      name: 'DSH Gestalt iPhone',
      channel: 'emulator',
      state: 'offline',
      online: false,
    }]))
    await listing.refresh()
    const offline = source.getView()
    expect(offline.kind).toBe('ready')
    if (offline.kind !== 'ready') throw new Error('expected ready')
    expect(offline.devices[0]?.online).toBe(false)
    expect(offline.devices[0]?.meta).toContain('已停止')
    expect(kinds).toEqual(['probing', 'ready', 'ready'])
    expect(listing.refreshCount).toBe(2)
    stop()
  })

  it('polls the listing on the Host interval and notifies a second refresh', async () => {
    vi.useFakeTimers()
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf([], [{
      id: 'CB65BAB1-E388-4C27-B9AB-81CFB37920C3',
      name: 'DSH Gestalt iPhone',
      channel: 'emulator',
      state: 'online',
      online: true,
    }]))
    const source = createListingPhoneEnvironmentSource(listing)
    const onlineFlags: boolean[] = []
    const stop = source.subscribe(() => {
      const view = source.getView()
      if (view.kind === 'ready') onlineFlags.push(view.devices[0]?.online === true)
    })
    await source.redetect()
    expect(listing.refreshCount).toBe(1)
    const extra = source.subscribe(() => {})
    extra()
    listing.scriptNext(listingOf([], [{
      id: 'CB65BAB1-E388-4C27-B9AB-81CFB37920C3',
      name: 'DSH Gestalt iPhone',
      channel: 'emulator',
      state: 'offline',
      online: false,
    }]))
    await vi.advanceTimersByTimeAsync(PHONE_LISTING_POLL_INTERVAL_MS)
    expect(listing.refreshCount).toBe(2)
    expect(onlineFlags).toEqual([true, false])
    const view = source.getView()
    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') throw new Error('expected ready')
    expect(view.devices[0]?.online).toBe(false)
    expect(view.devices[0]?.meta).toContain('已停止')
    stop()
    listing.scriptNext(listingOf([ANDROID_EMULATOR]))
    await vi.advanceTimersByTimeAsync(PHONE_LISTING_POLL_INTERVAL_MS)
    expect(listing.refreshCount).toBe(2)
  })

  it('keeps the last ready inventory when a poll refresh fails', async () => {
    vi.useFakeTimers()
    const listing = new FakeListingSource()
    listing.scriptNext(listingOf([ANDROID_EMULATOR]))
    const source = createListingPhoneEnvironmentSource(listing)
    const stop = source.subscribe(() => {})
    await source.redetect()
    listing.scriptNext(new Error('host down'))
    await vi.advanceTimersByTimeAsync(PHONE_LISTING_POLL_INTERVAL_MS)
    const view = source.getView()
    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') throw new Error('expected ready')
    expect(view.devices[0]?.online).toBe(true)
    expect(view.devices[0]?.meta).toContain('运行中')
    stop()
  })
})
