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
  /** True only while the upstream reports the device online; shutdown or unauthorized states read false. */
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
  | 'PHONE_REAL_DEVICE'
