/**
 * Type-only vocabulary for same-origin phone stream URLs minted by the Host.
 * @module @deepseek-ai/dsh-phone-stream/types
 */

import type { DeviceId, PhoneCaptureFormat, PhoneDeviceKind } from '@deepseek-ai/dsh-phone-runtime'

/** One signed same-origin capture URL plus its expiry. */
export interface PhoneStreamUrl {
  /** Path and query the browser loads on this Host; never a `:12000` origin. */
  readonly url: string
  /** Unix epoch milliseconds after which the Host refuses this URL. */
  readonly expiresAt: number
}

/** Same-origin IO socket path and signed MJPEG/H264 URLs for one device. */
export interface PhoneStreamSession {
  /** Branded device these URLs address. */
  readonly deviceId: DeviceId
  /** Exact-path WebSocket upgrade that forwards `device.io.*` JSON-RPC. */
  readonly ioPath: string
  /** Whether this session addresses an iOS real device whose on-device agent is product-managed. */
  readonly agentManaged: boolean
  /** Encoding the browser should open first for this device class. */
  readonly preferredFormat: PhoneCaptureFormat
  /** Signed MJPEG capture URL. */
  readonly mjpeg: PhoneStreamUrl
  /** Signed H264 (`avc`) capture URL. */
  readonly h264: PhoneStreamUrl
}

/** One device entry of the `GET /phone/devices` listing body. */
export interface PhoneDeviceRefWire {
  /** Branded Android serial or iOS UDID as a JSON string. */
  readonly id: string
  /** Human-readable device name from the upstream listing. */
  readonly name: string
  /** Emulator, iOS simulator, or physical handset class. */
  readonly kind: PhoneDeviceKind
  /** Upstream state verbatim (`online`, `offline`, `unauthorized`, ...). */
  readonly state: string
  /** True only while the upstream reports the device online. */
  readonly online: boolean
}

/** Grouped fleet listing body served by `GET /phone/devices`. */
export interface PhoneDeviceListWire {
  /** Every Android device, emulators and handsets alike. */
  readonly android: readonly PhoneDeviceRefWire[]
  /** iOS devices split by simulator versus physical handset. */
  readonly ios: {
    readonly simulators: readonly PhoneDeviceRefWire[]
    readonly reals: readonly PhoneDeviceRefWire[]
  }
}

export type { PhoneCaptureFormat }
