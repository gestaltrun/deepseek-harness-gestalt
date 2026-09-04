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

/** One validated upstream device; the platform rides the public ref. */
export interface MobilecliDevice extends PhoneDeviceRef {}

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
 * Validate and map one raw `devices.list` result onto device snapshots. Both
 * shipped wire shapes are accepted: the bare device array and mobilecli
 * 1.0.5's `{ devices: [...] }` envelope. Every row is validated before the
 * first row for each platform/id pair is retained. An id reported for both
 * platforms is rejected because every upstream operation accepts only an id.
 * @param result - JSON-RPC result value as received from the HTTP transport.
 * @returns the first entry for each id when every id belongs to one platform, in upstream order.
 * @throws {@link PhoneDevicesError} with `PHONE_PROTOCOL` when the value is
 * neither an array nor a devices envelope, or any element misses required
 * fields, names an unknown platform, reports an unknown `type`, or shares an
 * id across both platforms.
 */
export function parseDeviceInfos(result: unknown): readonly MobilecliDevice[] {
  const entries = unwrapDeviceEntries(result)
  const devices = entries.map((entry, index) => {
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
  const unique = new Map<string, MobilecliDevice>()
  for (const device of devices) {
    const key = `${device.platform}\u0000${device.id}`
    if (!unique.has(key)) unique.set(key, device)
  }
  const uniqueDevices = [...unique.values()]
  const platforms = new Map<DeviceId, 'ios' | 'android'>()
  for (const device of uniqueDevices) {
    const platform = platforms.get(device.id)
    if (platform !== undefined && platform !== device.platform) {
      throw protocolError(`device id ${JSON.stringify(device.id)} is ambiguous across ${platform} and ${device.platform}`)
    }
    platforms.set(device.id, device.platform)
  }
  return uniqueDevices
}

/**
 * Unwrap one `devices.list` result onto its device entries.
 * @param result - JSON-RPC result value as received from the HTTP transport.
 * @returns the device entries, whatever envelope shape carried them.
 * @throws {@link PhoneDevicesError} with `PHONE_PROTOCOL` when the value is
 * neither a bare array nor an envelope carrying a devices array.
 */
function unwrapDeviceEntries(result: unknown): readonly unknown[] {
  if (Array.isArray(result)) return result
  if (typeof result === 'object' && result !== null && Array.isArray((result as { devices?: unknown }).devices)) {
    return (result as { devices: readonly unknown[] }).devices
  }
  throw protocolError('result must be a device array or a { devices: [...] } envelope')
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
 * @returns whether any id set, name, kind, online, or logicalDisplay fact differs, plus the added/removed id arrays.
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

function logicalSignature(ref: PhoneDeviceRef): string {
  const display = ref.logicalDisplay
  return display === undefined ? '' : `${String(display.width)}x${String(display.height)}`
}

function signaturesOf(list: PhoneDeviceList | undefined): Map<DeviceId, string> {
  const signatures = new Map<DeviceId, string>()
  if (list === undefined) return signatures
  for (const ref of allRefs(list)) {
    signatures.set(
      ref.id,
      `${ref.kind}\u0000${ref.state}\u0000${ref.online ? 1 : 0}\u0000${ref.name}\u0000${logicalSignature(ref)}`,
    )
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
