/**
 * Narrow environment snapshot the phone settings card renders. The Host
 * `phoneDevices` service is the production source; this package injects a
 * JSON-compatible face so the card can still render when that service is
 * absent (the missing-service arm is the probe-failed state).
 */
import { PhoneStreamHttpError } from './phone-stream-client.ts'

/** One checklist row the probing / ready states display. */
export interface PhoneEnvironmentCheck {
  /** Stable id used as the React key and as the next-action target. */
  readonly id: 'adb' | 'mobilecli' | 'android-avd' | 'ios-runtime'
  /** Display name (adb / mobilecli / Android 模拟器 / Xcode iOS 运行时). */
  readonly name: string
  /** One-line caption under the name. */
  readonly caption: string
  /** Probe outcome for this check. */
  readonly status: 'ok' | 'pending' | 'missing'
  /** Detail line shown beside the name. */
  readonly detail: string
}

/** One device row in the ready-state inventory. */
export interface PhoneReadyDevice {
  /** Stable device identity (Android serial or iOS UDID). */
  readonly id: string
  /** Display name shown in the row. */
  readonly name: string
  /** Inventory group matching the locked mockup. */
  readonly group: 'android-emulator' | 'ios-simulator' | 'usb'
  /** Whether the device currently reports an open connection. */
  readonly online: boolean
  /** Caption after the name (OS, serial, authorization). */
  readonly meta: string
}

/** Recoverable error row with a single next-action verb. */
export interface PhoneEnvironmentError {
  /** Closed error kind matching the mockup rows plus the unresolvable-binary arm. */
  readonly kind: 'adb-missing' | 'no-devices' | 'wda-unbuilt' | 'probe-failed' | 'mobilecli-missing'
  /** Primary line. */
  readonly title: string
  /** Secondary explanation. */
  readonly detail: string
  /** Unified next-action verb shown on the row. */
  readonly nextAction: string
  /** Optional command copied from the row (adb-missing). */
  readonly command?: string
}

/** Closed view-state union the card switches on. */
export type PhoneEnvironmentView =
  | { readonly kind: 'off' }
  | { readonly kind: 'probing'; readonly checks: readonly PhoneEnvironmentCheck[] }
  | {
    readonly kind: 'android-wizard'
    readonly platformToolsInstalled: boolean
  }
  | { readonly kind: 'ios-wizard' }
  | {
    readonly kind: 'ready'
    readonly devices: readonly PhoneReadyDevice[]
    readonly availableCount: number
  }
  | { readonly kind: 'errors'; readonly errors: readonly PhoneEnvironmentError[] }

/** Consumer-supplied environment abstraction backing the settings card. */
export interface PhoneEnvironmentSource {
  /** Current view the card should render. */
  getView(): PhoneEnvironmentView
  /**
   * Re-run detection. A listing-backed source starts a fleet pull; the
   * missing-service source resolves immediately and stays on probe-failed.
   */
  redetect(): Promise<void>
  /**
   * Trigger the first detection when the source has not run one; a no-op
   * once probing, ready, or failed. Publishers that cannot detect leave
   * it undefined.
   */
  ensureDetected?(): void
  /** Subscribe to view replacements; returns the disposer. */
  subscribe(listener: () => void): () => void
}

/** Error row shown when the Host has not published a phoneDevices face. */
export const PROBE_FAILED_ERROR: PhoneEnvironmentError = {
  kind: 'probe-failed',
  title: '未能探测本机环境',
  detail: '本部署没有挂载 phoneDevices 服务，无法检测 adb、模拟器运行时或已连接设备。',
  nextAction: '下一步动作',
}

/** Error row shown when Host `GET /phone/devices` reports an unresolvable mobilecli. */
export const MOBILECLI_MISSING_ERROR: PhoneEnvironmentError = {
  kind: 'mobilecli-missing',
  title: '未找到 mobilecli',
  detail: 'Host 已启动，但无法解析 mobilecli 可执行文件。使用本页的「准备 mobilecli」完成一键准备。',
  nextAction: '准备 mobilecli',
}

/**
 * Map one fleet-listing failure onto a settings-card error row.
 * @param error - Thrown listing failure.
 * @returns the mobilecli-missing row when the Host named `PHONE_UNRESOLVED`; otherwise the probe-failed row.
 */
export function environmentErrorOf(error: unknown): PhoneEnvironmentError {
  if (error instanceof PhoneStreamHttpError && error.code === 'PHONE_UNRESOLVED') return MOBILECLI_MISSING_ERROR
  return PROBE_FAILED_ERROR
}

/** Shipped source while `phoneDevices` is not composed: probe-failed. */
export const MISSING_PHONE_ENVIRONMENT_SOURCE: PhoneEnvironmentSource = {
  getView: () => ({ kind: 'errors', errors: [PROBE_FAILED_ERROR] }),
  redetect: () => Promise.resolve(),
  subscribe: () => () => {},
}

/**
 * Card view for one enable-flag plus environment source pair. A closed
 * plugin always renders the off chrome; an enabled plugin renders whatever
 * the source currently reports.
 * @param enabled - Durable `ui-phone.enabled` (false keeps tools unregistered).
 * @param source - Environment snapshot backing probing / wizard / ready / errors.
 * @returns the view the settings card switches on.
 */
export function resolvePhoneCardView(
  enabled: boolean,
  source: PhoneEnvironmentSource,
): PhoneEnvironmentView {
  if (!enabled) return { kind: 'off' }
  return source.getView()
}
