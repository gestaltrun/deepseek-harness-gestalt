/**
 * Phone tab body: the not-connected empty state of the locked design —
 * state with the platform selector, the grouped device list, and the inert
 * re-detect placeholder. Connected instances of the same tab type render
 * the live view instead; every fact this component reads arrives through
 * plain props (the enable gate, the device source, the device-tab opener),
 * never through a service or context.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  PHONE_PLATFORMS, type PhoneBadgeSource, type PhoneDeviceSummary, type PhonePlatform,
} from './registry.ts'
import css from './PhoneTab.module.css'

/** Props of the phone tab body, threaded from the descriptor closure. */
export interface PhoneTabProps {
  /** Validated Config.enabled; false renders the top gate strip. */
  readonly enabled: boolean
  /** Device abstraction backing the list rows (default reports none). */
  readonly source: PhoneBadgeSource
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

/**
 * Render the empty-state body for one tab.
 * @param props - enable-gate value, the injected device source, and the opener.
 * @returns the not-connected empty state.
 */
export function PhoneTab({ enabled, source, onOpenDevice }: PhoneTabProps): ReactNode {
  const [platform, setPlatform] = useState<PhonePlatform>('android')
  const devices = useMemo(() => source.listDevices(platform), [source, platform])
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
              <div key={device.id} className={css.deviceRow}>
                <span
                  aria-hidden="true"
                  className={
                    device.online ? css.deviceDot : `${css.deviceDot} ${css.deviceDotOffline}`
                  }
                />
                <span className={css.deviceName}>{device.name}</span>
                <span className={css.deviceMeta}>{device.online ? '在线' : '离线'}</span>
                {device.online && (
                  <button
                    type="button"
                    className={css.openButton}
                    onClick={() => { onOpenDevice(device.id, device.name) }}
                  >
                    打开
                  </button>
                )}
              </div>
            ))}
            {channel === 'usb' && group.length === 0 && (
              <div className={css.emptyRow}>用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。</div>
            )}
          </section>
        )
      })}
      <div className={css.redetectZone}>
        {/* Detection wiring arrives with the mobilecli ticket; the control is
            a disabled placeholder until that source exists. */}
        <button type="button" className={css.redetectButton} disabled>重新检测环境</button>
      </div>
    </div>
  )
}
