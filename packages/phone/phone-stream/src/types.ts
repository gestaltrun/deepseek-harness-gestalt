/**
 * Type-only vocabulary for same-origin phone stream URLs minted by the Host.
 * @module @deepseek-ai/dsh-phone-stream/types
 */

import type { DeviceId, PhoneCaptureFormat } from '@deepseek-ai/dsh-phone-runtime'

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
  /** Signed MJPEG capture URL. */
  readonly mjpeg: PhoneStreamUrl
  /** Signed H264 (`avc`) capture URL. */
  readonly h264: PhoneStreamUrl
}

export type { PhoneCaptureFormat }
