/**
 * Settings-card environment source over the same Host fleet listing the
 * picker already consumes. A successful `GET /phone/devices` pull reaches
 * probing, both wizards, and ready; only a failed first pull stays on the
 * missing-service probe-failed row.
 */
import {
  PROBE_FAILED_ERROR,
  type PhoneEnvironmentCheck, type PhoneEnvironmentSource, type PhoneEnvironmentView,
  type PhoneReadyDevice,
} from './phone-environment.ts'
import type { PhoneDeviceSummary, PhoneListingSnapshot, PhoneListingSource } from './registry.ts'

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

type DetectPhase = 'idle' | 'probing' | 'ready' | 'failed'

function isMacPlatform(platform: string): boolean {
  return /mac/i.test(platform)
}

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

function viewFromListing(listing: PhoneListingSnapshot, platform: string): PhoneEnvironmentView {
  const devices = readyDevicesOf(listing)
  if (devices.length > 0) {
    return {
      kind: 'ready',
      devices,
      availableCount: devices.filter(device => device.online).length,
    }
  }
  if (isMacPlatform(platform)) return { kind: 'ios-wizard' }
  return { kind: 'android-wizard', platformToolsInstalled: true }
}

/**
 * Wrap one fleet listing source as the settings-card environment snapshot.
 * @param listing - Host `GET /phone/devices` source already used by the picker.
 * @param platform - `navigator.platform` stand-in; defaults to the browser value.
 * @returns the environment source the Plugins-tab card injects.
 */
export function createListingPhoneEnvironmentSource(
  listing: PhoneListingSource,
  platform: string = globalThis.navigator?.platform ?? '',
): PhoneEnvironmentSource {
  let phase: DetectPhase = 'idle'
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const source: PhoneEnvironmentSource = {
    getView: () => {
      if (phase === 'probing') return PROBING_VIEW
      if (phase === 'ready') return viewFromListing(listing.snapshot(), platform)
      return { kind: 'errors', errors: [PROBE_FAILED_ERROR] }
    },
    redetect: async () => {
      phase = 'probing'
      notify()
      try {
        await listing.refresh()
        phase = 'ready'
      } catch {
        // A refused or unreachable fleet route is the missing-service arm.
        phase = 'failed'
      }
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
      return () => { listeners.delete(listener) }
    },
  }
  return source
}
