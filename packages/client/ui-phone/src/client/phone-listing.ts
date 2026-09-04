/**
 * Listing source consuming the Host `GET /phone/devices` fleet route: one
 * fetch per refresh, wire validation at the response edge, and a
 * commit-only-on-success snapshot store with subscriber notification. The
 * strip badge and both tab bodies read the committed snapshot. PhoneTab
 * and PhoneConnectedView poll this source on the Host interval while
 * mounted; a failed refresh keeps the last committed listing.
 * @module @deepseek-ai/dsh-client-ui-phone/client/phone-listing
 */
import type { PhoneListingSnapshot, PhoneListingSource, PhoneDeviceSummary } from './registry.ts'
import { PhoneStreamHttpError } from './phone-stream-client.ts'

/** Fleet-listing endpoint on the same Host origin. */
export const PHONE_DEVICES_PATH = '/phone/devices'

/**
 * One device entry of the `GET /phone/devices` body — a local mirror of
 * `PhoneDeviceRefWire` from `@deepseek-ai/dsh-phone-stream` types.ts
 * (#421 wire): the upstream `state` rides verbatim and `online` is the
 * derived value. Mirrored (not imported) because this package consumes
 * the route over HTTP without a dependency on the Host package.
 */
interface PhoneDeviceRefWireMirror {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly state: string
  readonly online: boolean
  readonly logicalDisplay?: { readonly width: number; readonly height: number }
}

/** Wire kinds the Host listing reports; maps onto the picker group headers. */
const WIRE_KINDS = ['emulator', 'simulator', 'real'] as const

type WireKind = typeof WIRE_KINDS[number]

/** Picker group header a device kind belongs under. */
function channelOf(kind: WireKind): PhoneDeviceSummary['channel'] {
  return kind === 'real' ? 'usb' : 'emulator'
}

function wireError(status: number, message: string): PhoneStreamHttpError {
  return new PhoneStreamHttpError(status, 'http', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function summaryOf(value: unknown, group: string, index: number): PhoneDeviceSummary {
  if (!isRecord(value)) throw wireError(200, `phone device listing ${group}[${String(index)}] is not an object`)
  const { id, name, kind, online, state, logicalDisplay } = value as Partial<PhoneDeviceRefWireMirror>
  if (typeof id !== 'string' || id.length === 0) throw wireError(200, `phone device listing ${group}[${String(index)}] id is missing`)
  if (typeof name !== 'string' || name.length === 0) throw wireError(200, `phone device listing ${group}[${String(index)}] name is missing`)
  if (!WIRE_KINDS.includes(kind as WireKind)) throw wireError(200, `phone device listing ${group}[${String(index)}] kind is unknown`)
  if (typeof online !== 'boolean') throw wireError(200, `phone device listing ${group}[${String(index)}] online is missing`)
  if (typeof state !== 'string' || state.length === 0) throw wireError(200, `phone device listing ${group}[${String(index)}] state is missing`)
  const display = logicalDisplayOf(logicalDisplay, group, index)
  return {
    id,
    name,
    channel: channelOf(kind as WireKind),
    online,
    state,
    ...(display === undefined ? {} : { logicalDisplay: display }),
  }
}

function logicalDisplayOf(
  value: unknown,
  group: string,
  index: number,
): { readonly width: number; readonly height: number } | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw wireError(200, `phone device listing ${group}[${String(index)}] logicalDisplay is not an object`)
  }
  const width = value.width
  const height = value.height
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
    throw wireError(200, `phone device listing ${group}[${String(index)}] logicalDisplay is invalid`)
  }
  return { width, height }
}

function summariesOf(value: unknown, group: string): readonly PhoneDeviceSummary[] {
  if (!Array.isArray(value)) throw wireError(200, `phone device listing ${group} is not an array`)
  return Object.freeze(value.map((entry, index) => summaryOf(entry, group, index)))
}

/**
 * Validate one `GET /phone/devices` response body and map it onto picker
 * summaries (emulator/simulator kinds under 模拟器, real handsets under
 * USB 真机).
 * @param body - parsed JSON the listing endpoint answered with.
 * @returns the frozen per-platform summary groups.
 */
function parseListing(body: unknown): PhoneListingSnapshot {
  if (!isRecord(body)) throw wireError(200, 'phone device listing body is not an object')
  const ios = body.ios
  if (!isRecord(ios)) throw wireError(200, 'phone device listing ios section is missing')
  return Object.freeze({
    android: summariesOf(body.android, 'android'),
    ios: Object.freeze([
      ...summariesOf(ios.simulators, 'ios.simulators'),
      ...summariesOf(ios.reals, 'ios.reals'),
    ]),
  })
}

/**
 * Pull the fleet listing from the Host.
 * @param signal - Optional owner cancellation for a selection-local pull.
 * @returns the parsed per-platform summary groups.
 * @throws {@link PhoneStreamHttpError} when the Host refuses or the body breaks the wire contract.
 * @throws the network error wrapped as a status-0 {@link PhoneStreamHttpError} when the Host is unreachable.
 */
export async function fetchPhoneListing(signal?: AbortSignal): Promise<PhoneListingSnapshot> {
  let response: Response
  try {
    response = await fetch(PHONE_DEVICES_PATH, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new PhoneStreamHttpError(0, 'network', error instanceof Error ? error.message : String(error))
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const record = isRecord(body) ? body : {}
    const error = isRecord(record.error) ? record.error : {}
    throw new PhoneStreamHttpError(
      response.status,
      typeof error.code === 'string' ? error.code : 'http',
      typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : `phone device listing failed with HTTP ${String(response.status)}`,
    )
  }
  return parseListing(body)
}

/**
 * Wire the Host fleet route onto the listing seam the tab registration
 * consumes. The source starts empty and quiet; every successful refresh
 * publishes the next snapshot to its subscribers and failures leave the
 * committed listing untouched.
 * @returns the production listing source backed by `fetch`.
 */
export function createHttpPhoneListingSource(): PhoneListingSource {
  let committed: PhoneListingSnapshot = Object.freeze({ android: Object.freeze([]), ios: Object.freeze([]) })
  const listeners = new Set<() => void>()
  return {
    getBadge: () => ({
      onlineCount: [...committed.android, ...committed.ios].filter(device => device.online).length,
    }),
    snapshot: () => committed,
    refresh: async () => {
      const next = await fetchPhoneListing()
      committed = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
