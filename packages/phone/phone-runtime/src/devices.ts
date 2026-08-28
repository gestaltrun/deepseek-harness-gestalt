/**
 * Pure mapping of the mobilecli `devices.list` wire result onto the Service
 * vocabulary, and snapshot change computation. The upstream wire shape is
 * pinned by the mobilecli OpenRPC specification (`DeviceInfo`), so every field
 * is validated here — the one wire boundary this package owns.
 * @module @deepseek-ai/dsh-phone-runtime/devices
 */

import { PhoneDevicesError } from './errors.ts'
import { deviceId } from './ids.ts'
import type {
  DeviceId,
  PhoneDeviceChange,
  PhoneDeviceKind,
  PhoneDeviceList,
  PhoneDeviceRef,
} from './types.ts'

/** One validated upstream device, keeping its platform for grouping. */
export interface MobilecliDevice extends PhoneDeviceRef {
  /** Upstream platform this entry was listed under. */
  readonly platform: 'ios' | 'android'
}

/** Upstream `type` values this Service accepts; anything else breaks protocol. */
const KINDS: readonly string[] = ['emulator', 'simulator', 'real']

function isPlatform(value: string): value is 'ios' | 'android' {
  return value === 'ios' || value === 'android'
}

function protocolError(message: string): PhoneDevicesError {
  return new PhoneDevicesError('PHONE_PROTOCOL', `mobilecli devices.list response breaks its contract: ${message}`)
}

function stringField(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw protocolError(`device ${String(index)} field ${JSON.stringify(key)} must be a non-empty string`)
  }
  return value
}

/**
 * Validate and map one raw `devices.list` result onto device snapshots.
 * @param result - JSON-RPC result value as received from the HTTP transport.
 * @returns one entry per reported device, in upstream order.
 * @throws {@link PhoneDevicesError} with `PHONE_PROTOCOL` when the value is not
 * an array or any element misses required fields, names an unknown platform,
 * or reports an unknown `type`.
 */
export function parseDeviceInfos(result: unknown): readonly MobilecliDevice[] {
  if (!Array.isArray(result)) throw protocolError('result must be a device array')
  return result.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw protocolError(`device ${String(index)} must be an object`)
    }
    const record = entry as Record<string, unknown>
    const platform = stringField(record, 'platform', index)
    if (!isPlatform(platform)) {
      throw protocolError(`device ${String(index)} platform ${JSON.stringify(platform)} is unknown`)
    }
    const id = deviceId(stringField(record, 'id', index))
    const name = stringField(record, 'name', index)
    const state = stringField(record, 'state', index)
    const kind = phoneDeviceKind(stringField(record, 'type', index))
    const device: MobilecliDevice = Object.freeze({ id, name, kind, state, online: state === 'online', platform })
    return device
  })
}

/**
 * Translate the upstream free-form `type` string.
 * @param type - Upstream device type value.
 * @returns the matching closed kind union member.
 * @throws {@link PhoneDevicesError} with `PHONE_PROTOCOL` for unknown values.
 */
export function phoneDeviceKind(type: string): PhoneDeviceKind {
  if (!KINDS.includes(type)) {
    throw protocolError(`device type ${JSON.stringify(type)} is unknown`)
  }
  return type as PhoneDeviceKind
}

/**
 * Group validated devices into the public Android/iOS answer. The public refs
 * drop the platform field; group membership already carries it.
 * @param devices - Validated device snapshots, upstream order preserved inside groups.
 * @returns the frozen grouped listing.
 */
export function groupEntries(devices: readonly MobilecliDevice[]): PhoneDeviceList {
  const ios = devices.filter(device => device.platform === 'ios')
  return Object.freeze({
    android: Object.freeze(devices.filter(device => device.platform === 'android')),
    ios: Object.freeze({
      simulators: Object.freeze(ios.filter(device => device.kind === 'simulator')),
      reals: Object.freeze(ios.filter(device => device.kind !== 'simulator')),
    }),
  })
}

/**
 * Compute the committed change payload fields between two listings.
 * @param previous - Listing published before, or `undefined` before the first acquisition.
 * @param next - Candidate listing.
 * @returns whether any id set, name, kind, or online fact differs, plus the added/removed id arrays.
 */
export function changeSets(
  previous: PhoneDeviceList | undefined,
  next: PhoneDeviceList,
): Pick<PhoneDeviceChange, 'added' | 'removed'> & { changed: boolean } {
  const before = signaturesOf(previous)
  const after = signaturesOf(next)
  let changed = before.size !== after.size
  if (!changed) {
    for (const [id, signature] of after) {
      if (before.get(id) !== signature) {
        changed = true
        break
      }
    }
  }
  const added = [...after.keys()].filter(id => !before.has(id))
  const removed = [...before.keys()].filter(id => !after.has(id))
  return { changed, added, removed }
}

function signaturesOf(list: PhoneDeviceList | undefined): Map<DeviceId, string> {
  const signatures = new Map<DeviceId, string>()
  if (list === undefined) return signatures
  for (const ref of allRefs(list)) {
    signatures.set(ref.id, `${ref.kind}\u0000${ref.state}\u0000${ref.online ? 1 : 0}\u0000${ref.name}`)
  }
  return signatures
}

/**
 * Flatten one grouped listing in android, then iOS simulator, then iOS real order.
 * @param list - Grouped listing to flatten.
 * @returns every entry of the listing in that order.
 */
export function allRefs(list: PhoneDeviceList): readonly PhoneDeviceRef[] {
  return [...list.android, ...list.ios.simulators, ...list.ios.reals]
}
