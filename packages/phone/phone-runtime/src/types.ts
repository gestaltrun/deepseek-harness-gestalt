/**
 * Type-only vocabulary for the phone device fleet Service. Runtime factories,
 * validators, and the service class live in their own modules.
 * @module @deepseek-ai/dsh-phone-runtime/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque mobilecli device identifier — an Android serial or an iOS UDID. */
export type DeviceId = Branded<'DeviceId'>

/** Device execution class as reported by the mobilecli `type` field. */
export type PhoneDeviceKind = 'emulator' | 'simulator' | 'real'

/** One addressable phone device snapshot entry. */
export interface PhoneDeviceRef {
  /** Branded Android serial or iOS UDID; addresses every operation for this device. */
  readonly id: DeviceId
  /** Human-readable device name from the upstream listing. */
  readonly name: string
  /** Emulator, iOS simulator, or physical handset class. */
  readonly kind: PhoneDeviceKind
  /** Upstream platform this entry was listed under. */
  readonly platform: 'ios' | 'android'
  /** Upstream state verbatim (`online`, `offline`, `unauthorized`, ...); the listing never folds distinct states together. */
  readonly state: string
  /** True only while the upstream reports the device online; every other state reads false. */
  readonly online: boolean
}

/** One grouped device listing answer. */
export interface PhoneDeviceList {
  /** Every Android device, emulators and handsets alike, classified per entry. */
  readonly android: readonly PhoneDeviceRef[]
  /** iOS devices split by simulator versus physical handset. */
  readonly ios: {
    readonly simulators: readonly PhoneDeviceRef[]
    readonly reals: readonly PhoneDeviceRef[]
  }
}

/**
 * One committed change notification: the complete new listing plus the id-level
 * membership delta against the previously published one.
 */
export interface PhoneDeviceChange {
  /** Complete committed listing after this change. */
  readonly list: PhoneDeviceList
  /** Ids present now and absent before; the first acquisition lists every id here. */
  readonly added: readonly DeviceId[]
  /** Ids absent now and present before. */
  readonly removed: readonly DeviceId[]
}

/** Upstream OpenRPC `device.io.*` verbs this Service forwards. */
export type PhoneIoMethod = 'tap' | 'gesture' | 'text' | 'button'

/** One JSON-RPC `device.io.*` request addressed by branded device id. */
export type PhoneIoRequest =
  | { readonly deviceId: DeviceId; readonly method: 'tap'; readonly x: number; readonly y: number }
  | { readonly deviceId: DeviceId; readonly method: 'gesture'; readonly actions: readonly Record<string, unknown>[] }
  | { readonly deviceId: DeviceId; readonly method: 'text'; readonly text: string }
  | { readonly deviceId: DeviceId; readonly method: 'button'; readonly button: string }

/** Screen-capture encoding the Host reverse-proxy may request. */
export type PhoneCaptureFormat = 'mjpeg' | 'h264'

/** Request that opens one upstream `device.screencapture` stream. */
export interface PhoneCaptureRequest {
  /** Branded Android serial or iOS UDID whose screen to stream. */
  readonly deviceId: DeviceId
  /** `mjpeg` for both platforms; `h264` maps onto upstream `avc` (Android). */
  readonly format: PhoneCaptureFormat
  /** Optional caller cancellation fused with the request ceiling until headers arrive. */
  readonly signal?: AbortSignal
}

/**
 * One live capture body owned by the caller. The Host must cancel `body` when
 * the browser disconnects so the upstream HTTP stream ends.
 */
export interface PhoneCaptureStream {
  /** Upstream `Content-Type`, including the MJPEG boundary parameter when present. */
  readonly contentType: string
  /** Byte stream of the capture; cancel it to abort the upstream request. */
  readonly body: ReadableStream<Uint8Array>
}

/** One still PNG captured from a listed device. */
export interface PhoneScreenshot {
  /** Always PNG; the still comes from `mobilecli screenshot --format png`. */
  readonly mediaType: 'image/png'
  /** Canonical base64 of the PNG file bytes. */
  readonly data: string
}

/** Closed error-code union carried by {@link PhoneDevicesError}. */
export type PhoneErrorCode =
  | 'PHONE_DISPOSED'
  | 'PHONE_ABORTED'
  | 'PHONE_TIMEOUT'
  | 'PHONE_UNAVAILABLE'
  | 'PHONE_UNRESOLVED'
  | 'PHONE_PROTOCOL'
  | 'PHONE_UPSTREAM'
  | 'PHONE_DEVICE_NOT_FOUND'
  | 'PHONE_AGENT_PROFILE_REQUIRED'
  | 'PHONE_REAL_DEVICE'
  | 'PHONE_REAL_DEVICE_ISSUE'

/**
 * Closed union of structured real-device failure arms. {@link classifyRealDeviceIssue}
 * names one arm from free-form mobilecli output; the matching
 * `PHONE_REAL_DEVICE_ISSUE` failure carries it on {@link PhoneDevicesError.issue}.
 */
export type PhoneRealDeviceIssue =
  | 'device-locked'
  | 'cert-untrusted'
  | 'profile-expired'
  | 'tunnel-failed'
  | 'device-unplugged'

/** On-device agent identity as the upstream agent commands report it. */
export interface PhoneAgentInfo {
  /** Agent version string, exactly as installed. */
  readonly version: string
  /** Installed agent bundle id; re-signed iOS installs carry a team suffix upstream matches by suffix. */
  readonly bundleId: string
}

/** One on-device agent status answer. */
export interface PhoneAgentStatus {
  /** Device the answer is about. */
  readonly deviceId: DeviceId
  /** True only when the upstream agent command answered `status: ok`. */
  readonly installed: boolean
  /** Installed agent version; absent while `installed` is false. */
  readonly version?: string
  /** Installed agent bundle id; absent while `installed` is false. */
  readonly bundleId?: string
  /** Free-signing expiry reminder for a re-signed real handset; see the Service's `FREE_SIGNING_PROFILE_REMINDER`. */
  readonly profileReminder?: string
}

/** Options for one on-device agent install. */
export interface PhoneAgentInstallOptions {
  /** Reinstall and re-sign even when the agent already answers as installed. */
  readonly force?: boolean
  /** Optional caller cancellation bounding the whole install. */
  readonly signal?: AbortSignal
}

/** One on-device agent install answer; `reinstalled` names a forced run this call performed. */
export interface PhoneAgentInstallResult extends PhoneAgentStatus {
  /** True when this call ran a forced reinstall; false for a first install or an already-installed answer. */
  readonly reinstalled: boolean
}
