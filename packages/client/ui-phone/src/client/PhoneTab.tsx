/**
 * Phone tab body: the not-connected empty state of the locked design —
 * state with the platform selector, the grouped device list, and the
 * 重新检测环境 control that pulls the fleet listing. Connected instances
 * of the same tab type render the live view instead; every fact this
 * component reads arrives through plain props (the enable gate, the
 * listing source, the device-tab opener), never through a service or
 * context.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  PHONE_PLATFORMS, type PhoneDeviceSummary, type PhoneGateSource, type PhoneListingSource, type PhonePlatform,
} from './registry.ts'
import css from './PhoneTab.module.css'
import shared from './PhoneShared.module.css'

/** Props of the phone tab body, threaded from the descriptor closure. */
export interface PhoneTabProps {
  /** Reactive enable gate; the strip follows invalidations live. */
  readonly gate: PhoneGateSource
  /** Listing source backing the rows (starts empty until a pull commits). */
  readonly source: PhoneListingSource
  /** Open (or focus) the per-device tab of one listed device. */
  readonly onOpenDevice: (serial: string, name: string) => void
}

/** Copy under each platform segment (the mockup fixes the Android→iOS one). */
const PLATFORM_HINTS: Record<PhonePlatform, string> = {
  android: '切换到 iOS 将列出 Xcode 模拟器与 WDA 真机',
  ios: '切换到 Android 将列出 ADB 模拟器与 USB 真机',
}

/** List order of the mockup's group headers. */
const GROUPS: readonly { readonly channel: PhoneDeviceSummary['channel'] }[] = [
  { channel: 'emulator' },
  { channel: 'usb' },
]

const GROUP_TITLES: Record<PhoneDeviceSummary['channel'], string> = {
  emulator: '模拟器',
  usb: 'USB 真机',
}

/** Row meta state caption per channel (the mockup fixes the emulator pair). */
function runningStateOf(device: PhoneDeviceSummary): string {
  if (device.unauthorized === true) return '未授权'
  if (device.channel === 'emulator') return device.online ? '运行中' : '已停止'
  return device.online ? '在线' : '离线'
}

/** The meta line: OS version when reported, then the running state. */
function rowMetaOf(device: PhoneDeviceSummary): string {
  const state = runningStateOf(device)
  return device.osVersion === undefined ? state : `${device.osVersion} · ${state}`
}

/**
 * Render the empty-state body for one tab.
 * @param props - enable-gate value, the injected listing source, and the opener.
 * @returns the not-connected empty state.
 */
export function PhoneTab({ gate, source, onOpenDevice }: PhoneTabProps): ReactNode {
  const [platform, setPlatform] = useState<PhonePlatform>('android')
  // The gate and the listing source are the owning observables; uSES is the
  // render-side adapter (better-sidebar tab hosts have no slot hook channel).
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const getSnapshot = useCallback(() => source.snapshot(), [source])
  const listing = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const gateSubscribe = useCallback((listener: () => void) => gate.subscribe(listener), [gate])
  const gateSnapshot = useCallback(() => gate.snapshot(), [gate])
  const enabled = useSyncExternalStore(gateSubscribe, gateSnapshot, gateSnapshot)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = (): void => {
    setRefreshing(true)
    // A failed pull keeps the committed listing on screen; the next click retries.
    source.refresh().catch(() => undefined).finally(() => { setRefreshing(false) })
  }
  useEffect(() => {
    if (!enabled) return
    source.refresh().catch(() => undefined)
  }, [enabled, source])
  const devices = listing[platform]
  return (
    <div className={css.phone}>
      {!enabled && (
        <div className={css.gateBanner} role="note" aria-label="手机连接未启用">
          <p className={css.gateTitle}>手机连接未启用</p>
          <p className={css.gateDesc}>该部署未开启设备检测；入口保持可用，启用后即可发现并连接设备。</p>
        </div>
      )}
      <div className={css.platformSeg} role="group" aria-label="平台选择">
        {PHONE_PLATFORMS.map(candidate => (
          <button
            key={candidate}
            type="button"
            className={
              candidate === platform ? `${css.platformOption} ${css.platformActive}` : css.platformOption
            }
            aria-pressed={candidate === platform}
            onClick={() => { setPlatform(candidate) }}
          >
            {candidate === 'android' ? 'Android' : 'iOS'}
          </button>
        ))}
      </div>
      <p className={css.platformHint}>{PLATFORM_HINTS[platform]}</p>
      {GROUPS.map(({ channel }) => {
        const group = devices.filter(device => device.channel === channel)
        return (
          <section key={channel} aria-label={GROUP_TITLES[channel]}>
            <div className={css.groupName}>{GROUP_TITLES[channel]}</div>
            {group.map(device => (
              device.unauthorized === true ? (
                <div key={device.id} role="alert" className={css.unauthorizedArm}>
                  <p className={css.unauthorizedTitle}>真机未授权调试</p>
                  <p className={css.unauthorizedDetail}>
                    {`${device.name} 已通过 USB 连接；请在手机上允许「USB 调试」后重新检测。`}
                  </p>
                  <div className={css.alertActions}>
                    <button
                      type="button"
                      className={css.redetectButton}
                      disabled={refreshing}
                      onClick={refresh}
                    >
                      重新检测
                    </button>
                  </div>
                </div>
              ) : (
                <div key={device.id} className={css.deviceRow}>
                  <span
                    aria-hidden="true"
                    className={
                      device.online ? css.deviceDot : `${css.deviceDot} ${css.deviceDotOffline}`
                    }
                  />
                  <span className={css.deviceName}>{device.name}</span>
                  <span className={css.deviceMeta}>{rowMetaOf(device)}</span>
                  {device.online && (
                    <button
                      type="button"
                      className={shared.minibtnPrimary}
                      onClick={() => { onOpenDevice(device.id, device.name) }}
                    >
                      打开
                    </button>
                  )}
                </div>
              )
            ))}
            {channel === 'usb' && group.length === 0 && (
              <div className={css.emptyRow}>用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。</div>
            )}
          </section>
        )
      })}
      <div className={css.redetectZone}>
        <button
          type="button"
          className={css.redetectButton}
          disabled={!enabled || refreshing}
          onClick={refresh}
        >
          重新检测环境
        </button>
      </div>
    </div>
  )
}
