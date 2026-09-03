/**
 * Settings-card environment source over the same Host fleet listing the
 * picker already consumes. A successful `GET /phone/devices` pull reaches
 * probing, platform-neutral no-device recovery, and ready; a `PHONE_UNRESOLVED` pull stays on the
 * mobilecli-missing row only while the runtime snapshot is not ready — a ready
 * runtime means the fleet is active, so the pull falls to no-device recovery;
 * any other failed first pull stays on the
 * missing-service probe-failed row. After ready, the source follows later
 * listing commits and refreshes on the Host `pollIntervalMs` default so the
 * card does not wait for 「重新检测」.
 */
import {
  environmentErrorOf, PROBE_FAILED_ERROR,
  type PhoneEnvironmentCheck, type PhoneEnvironmentError, type PhoneEnvironmentSource, type PhoneEnvironmentView,
  type PhoneReadyDevice,
} from './phone-environment.ts'
import { PhoneStreamHttpError } from './phone-stream-client.ts'
import type { PhoneDeviceSummary, PhoneListingSnapshot, PhoneListingSource } from './registry.ts'

/**
 * Browser listing poll cadence. Matches Host `phone-runtime` `pollIntervalMs`
 * default 5000 ms; the browser has no Host change stream for `GET /phone/devices`.
 */
export const PHONE_LISTING_POLL_INTERVAL_MS = 5_000

/** Checklist shown while the first (or a later) fleet pull is in flight. */
const PROBING_CHECKS: readonly PhoneEnvironmentCheck[] = Object.freeze([
  {
    id: 'adb',
    name: 'adb',
    caption: 'Android 平台工具',
    status: 'ok',
    detail: '正在读取 Host 设备清单…',
  },
  {
    id: 'mobilecli',
    name: 'mobilecli',
    caption: '统一设备引擎（可选）',
    status: 'pending',
    detail: '正在确认设备清单…',
  },
  {
    id: 'android-avd',
    name: 'Android 模拟器',
    caption: 'AVD / 系统镜像',
    status: 'pending',
    detail: '正在确认 AVD…',
  },
  {
    id: 'ios-runtime',
    name: 'Xcode iOS 运行时',
    caption: 'iOS 模拟器依赖',
    status: 'pending',
    detail: '正在确认模拟器运行时…',
  },
])

const PROBING_VIEW: PhoneEnvironmentView = Object.freeze({
  kind: 'probing',
  checks: PROBING_CHECKS,
})

const NO_DEVICES_ERROR: PhoneEnvironmentError = Object.freeze({
  kind: 'no-devices',
  title: '当前没有可用设备',
  detail: '上方 Android / iOS 分栏显示本机可准备的模拟器环境；USB 真机完成授权后也会出现在这里。',
  nextAction: '重新检测',
})

const NO_DEVICES_VIEW: PhoneEnvironmentView = Object.freeze({
  kind: 'errors', errors: Object.freeze([NO_DEVICES_ERROR]),
})

type DetectPhase = 'idle' | 'probing' | 'ready' | 'failed'

function readyDevicesOf(listing: PhoneListingSnapshot): readonly PhoneReadyDevice[] {
  const android = listing.android.map((device): PhoneReadyDevice => ({
    id: device.id,
    name: device.name,
    group: device.channel === 'usb' ? 'usb' : 'android-emulator',
    online: device.online,
    meta: metaOf(device),
  }))
  const ios = listing.ios.map((device): PhoneReadyDevice => ({
    id: device.id,
    name: device.name,
    group: device.channel === 'usb' ? 'usb' : 'ios-simulator',
    online: device.online,
    meta: metaOf(device),
  }))
  return Object.freeze([...android, ...ios])
}

function metaOf(device: PhoneDeviceSummary): string {
  if (device.state === 'unauthorized') return `未授权 · ${device.id}`
  const run = device.online ? '运行中' : '已停止'
  return `${run} · ${device.id}`
}

function viewFromListing(listing: PhoneListingSnapshot): PhoneEnvironmentView {
  const devices = readyDevicesOf(listing)
  if (devices.length > 0) {
    return {
      kind: 'ready',
      devices,
      availableCount: devices.filter(device => device.online).length,
    }
  }
  return NO_DEVICES_VIEW
}

/** Optional Host runtime readiness face consulted when a fleet pull fails. */
export interface ListingPhoneEnvironmentOptions {
  /**
   * Whether the Host runtime snapshot currently reports ready. A
   * `PHONE_UNRESOLVED` pull may only render mobilecli-missing while this is
   * false; a ready runtime proves the fleet is active.
   */
  readonly runtimeReady?: () => boolean
}

/**
 * Wrap one fleet listing source as the settings-card environment snapshot.
 * First detection still goes through {@link PhoneEnvironmentSource.redetect}
 * / `ensureDetected`. After ready, listing commits notify card subscribers and
 * a 5000 ms `GET /phone/devices` poll keeps the inventory current; a failed
 * poll keeps the last committed listing.
 * @param listing - Host `GET /phone/devices` source already used by the picker.
 * @param options - optional Host runtime readiness face.
 * @returns the environment source the Plugins-tab card injects.
 */
export function createListingPhoneEnvironmentSource(
  listing: PhoneListingSource,
  options: ListingPhoneEnvironmentOptions = {},
): PhoneEnvironmentSource {
  let phase: DetectPhase = 'idle'
  let lastError: PhoneEnvironmentError = PROBE_FAILED_ERROR
  const listeners = new Set<() => void>()
  let stopListing: (() => void) | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const syncPolling = (): void => {
    const shouldPoll = phase === 'ready' && listeners.size > 0
    if (shouldPoll) {
      if (pollTimer !== undefined) return
      pollTimer = setInterval(() => {
        void listing.refresh().catch(() => {
          // A refused or malformed GET keeps the last committed snapshot;
          // the next interval retries.
        })
      }, PHONE_LISTING_POLL_INTERVAL_MS)
      return
    }
    if (pollTimer === undefined) return
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  const attachListing = (): void => {
    if (stopListing !== undefined) return
    stopListing = listing.subscribe(() => {
      if (phase === 'ready') notify()
    })
  }
  const detachListing = (): void => {
    stopListing?.()
    stopListing = undefined
  }

  const source: PhoneEnvironmentSource = {
    getView: () => {
      if (phase === 'probing') return PROBING_VIEW
      if (phase === 'ready') return viewFromListing(listing.snapshot())
      return { kind: 'errors', errors: [lastError] }
    },
    redetect: async () => {
      phase = 'probing'
      syncPolling()
      notify()
      try {
        await listing.refresh()
        phase = 'ready'
      } catch (error) {
        // A refused or unreachable fleet route is the missing-service arm;
        // PHONE_UNRESOLVED is the unresolvable-binary arm with install copy.
        // A ready runtime snapshot proves the fleet is active, so a stale
        // PHONE_UNRESOLVED falls to the platform-neutral no-device recovery.
        if (options.runtimeReady?.() === true
          && error instanceof PhoneStreamHttpError && error.code === 'PHONE_UNRESOLVED') {
          phase = 'ready'
        } else {
          lastError = environmentErrorOf(error)
          phase = 'failed'
        }
      }
      syncPolling()
      notify()
    },
    ensureDetected: () => {
      if (phase !== 'idle') return
      phase = 'probing'
      notify()
      void source.redetect()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      attachListing()
      syncPolling()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        detachListing()
        syncPolling()
      }
    },
  }
  return source
}
