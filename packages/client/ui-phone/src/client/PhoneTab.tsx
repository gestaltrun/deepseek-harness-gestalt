/**
 * Phone tab body: the not-connected empty state of the locked design —
 * state with the platform selector, the grouped device list, and the
 * 重新检测环境 control that pulls the fleet listing. The same tab
 * instance renders the live view once a device occupies it; every fact
 * this component reads arrives through plain props (the enable gate, the
 * listing source, the in-place device switcher), never through a service
 * or context.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  PHONE_PLATFORMS, type PhoneDeviceSummary, type PhoneGateSource, type PhoneListingSource, type PhonePlatform,
} from './registry.ts'
import { PhoneStreamHttpError } from './phone-stream-client.ts'
import css from './PhoneTab.module.css'
import shared from './PhoneShared.module.css'

/** Props of the phone tab body, threaded from the descriptor closure. */
export interface PhoneTabProps {
  /** Reactive enable gate; the strip follows invalidations live. */
  readonly gate: PhoneGateSource
  /** Listing source backing the rows (starts empty until a pull commits). */
  readonly source: PhoneListingSource
  /** Switch the single tab onto one listed online device in place (U1). */
  readonly onOpenDevice: (serial: string, name: string) => void
}

/** Copy under each platform segment (the mockup fixes the Android→iOS one). */
const PLATFORM_HINTS: Record<PhonePlatform, string> = {
  android: '切换到 iOS 将列出 Xcode 模拟器与设备控制代理真机',
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
 * Row meta caption for a listed online device. Offline rows are omitted
 * (U2); unauthorized handsets render the warn arm instead of this caption.
 */
function runningStateOf(device: PhoneDeviceSummary): string {
  return device.channel === 'emulator' ? '运行中' : '在线'
}

/**
 * The meta line. The upstream wire carries no OS version field, so the
 * caption degrades to the running state alone (P5 leftover note).
 */
function rowMetaOf(device: PhoneDeviceSummary): string {
  return runningStateOf(device)
}

/** Copy the picker error arm shows for one listing-pull failure. */
function listingErrorCopy(error: unknown): { title: string; detail: string; command?: string } {
  if (error instanceof PhoneStreamHttpError && error.code === 'PHONE_UNRESOLVED') {
    return {
      title: '未找到 mobilecli',
      detail: 'Host 已启动，但无法解析 mobilecli 可执行文件。安装后重新检测。',
      command: 'npm install -g mobilecli@latest',
    }
  }
  return {
    title: '无法读取设备清单',
    detail: error instanceof Error && error.message.length > 0
      ? error.message
      : '设备清单请求失败；请重新检测。',
  }
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
  const [listingError, setListingError] = useState<unknown>()
  const refresh = useCallback((): void => {
    setRefreshing(true)
    // A failed pull keeps the committed listing on screen and lights the
    // error arm; the next click retries.
    source.refresh()
      .then(() => { setListingError(undefined) })
      .catch((error: unknown) => { setListingError(error) })
      .finally(() => { setRefreshing(false) })
  }, [source])
  useEffect(() => {
    if (!enabled) return
    refresh()
  }, [enabled, refresh])
  const devices = listing[platform]
  const listingFailure = listingError === undefined ? undefined : listingErrorCopy(listingError)
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
      {listingFailure !== undefined && (
        <div role="alert" className={css.listingFailedArm}>
          <p className={css.unauthorizedTitle}>{listingFailure.title}</p>
          <p className={css.unauthorizedDetail}>{listingFailure.detail}</p>
          {listingFailure.command !== undefined && (
            <code className={css.listingFailedCommand}>{listingFailure.command}</code>
          )}
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
      )}
      {GROUPS.map(({ channel }) => {
        const group = devices.filter(device => device.channel === channel)
        const visible = group.filter(device => device.online || device.state === 'unauthorized')
        return (
          <section key={channel} aria-label={GROUP_TITLES[channel]}>
            <div className={css.groupName}>{GROUP_TITLES[channel]}</div>
            {visible.map(device => (
              device.state === 'unauthorized' ? (
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
                    className={css.deviceDot}
                  />
                  <span className={css.deviceName}>{device.name}</span>
                  <span className={css.deviceMeta}>{rowMetaOf(device)}</span>
                  <button
                    type="button"
                    className={shared.minibtnPrimary}
                    onClick={() => { onOpenDevice(device.id, device.name) }}
                  >
                    打开
                  </button>
                </div>
              )
            ))}
            {channel === 'usb' && visible.length === 0 && (
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
