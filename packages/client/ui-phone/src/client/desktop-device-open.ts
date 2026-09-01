/** Desktop overlay projection for opening a Settings device on the Session Surface. */

import type {
  ChromeOverlayResult, ChromeOverlayShowRequest, DesktopBridge,
} from '@deepseek-ai/dsh-client-ui-desktop/protocol'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { PhoneSettings } from '../phone-settings.ts'

const PHONE_DEVICE_SELECTION_PREFIX = 'phone-device:'
/** Desktop overlay id limit mirrored from the typed Host protocol. */
export const PHONE_DESKTOP_OVERLAY_ID_MAX_LENGTH = 128

/**
 * Whether this renderer is the Desktop settings overlay document.
 * @returns true for the isolated Desktop overlay renderer.
 */
export function isDesktopOverlayDocument(): boolean {
  if (typeof document !== 'undefined'
    && document.documentElement.hasAttribute('data-dsh-desktop-overlay')) return true
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search.replace(/^\?/, '')).get('dsh-desktop-overlay') === '1'
}

/** Desktop bridge verbs used by Phone Settings without depending on Desktop chrome components. */
export type PhoneDesktopOverlayBridge = Pick<
  DesktopBridge,
  'chromeOverlayGetState' | 'chromeOverlayResult' | 'onChromeOverlayResult'
>

/**
 * Return the Desktop bridge only when every required overlay verb exists.
 * @param value - Candidate global Desktop bridge.
 * @returns the narrowed bridge, or undefined outside Desktop.
 */
export function phoneDesktopOverlayBridgeOf(value: unknown): PhoneDesktopOverlayBridge | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.chromeOverlayGetState !== 'function'
    || typeof record.chromeOverlayResult !== 'function'
    || typeof record.onChromeOverlayResult !== 'function'
  ) return undefined
  return record as unknown as PhoneDesktopOverlayBridge
}

/**
 * Wait until the main renderer's durable Phone gate leaves its initial loading state.
 * @param scope - Main-renderer Phone settings scope.
 * @param read - Current resolved gate projection.
 * @param signal - Renderer lifetime cancelling an in-flight selection.
 * @returns the current gate, or false after cancellation.
 */
export function waitForPhoneGate(
  scope: Pick<SettingsScope<PhoneSettings>, 'getSnapshot' | 'subscribe'>,
  read: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (scope.getSnapshot().status !== 'loading') return Promise.resolve(read())
  return new Promise((resolve) => {
    const settle = (): void => {
      if (!signal.aborted && scope.getSnapshot().status === 'loading') return
      unsubscribe()
      signal.removeEventListener('abort', settle)
      resolve(signal.aborted ? false : read())
    }
    const unsubscribe = scope.subscribe(settle)
    signal.addEventListener('abort', settle, { once: true })
  })
}

/**
 * Serialize one device identity through the bounded overlay selection id.
 * @param deviceId - Android serial or iOS UDID.
 * @returns encoded overlay selection id.
 */
export function phoneDeviceSelectionId(deviceId: string): string {
  const id = `${PHONE_DEVICE_SELECTION_PREFIX}${encodeURIComponent(deviceId)}`
  if (deviceId.length === 0 || id.length > PHONE_DESKTOP_OVERLAY_ID_MAX_LENGTH) {
    throw new RangeError('Phone device id cannot fit the Desktop overlay selection protocol')
  }
  return id
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PHONE_DESKTOP_OVERLAY_ID_MAX_LENGTH
}

/**
 * Parse a device-open selection received from the untrusted overlay IPC edge.
 * @param value - Candidate overlay result.
 * @returns decoded device identity, or undefined for another result.
 */
export function phoneDeviceIdFromSelection(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'select'
    || !boundedIdentity(record.requestId)
    || !boundedIdentity(record.id)
    || !record.id.startsWith(PHONE_DEVICE_SELECTION_PREFIX)) return undefined
  try {
    const deviceId = decodeURIComponent(record.id.slice(PHONE_DEVICE_SELECTION_PREFIX.length))
    return deviceId.length > 0 ? deviceId : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask Desktop Host to close Settings and forward one device selection to the Session Surface.
 * @param bridge - Valid Desktop overlay bridge.
 * @param deviceId - Online device selected in Settings.
 * @returns completion after the selection is sent, or ignored outside Settings.
 */
export async function selectPhoneDeviceFromOverlay(
  bridge: PhoneDesktopOverlayBridge,
  deviceId: string,
): Promise<void> {
  const state: ChromeOverlayShowRequest | null = await bridge.chromeOverlayGetState()
  if (state?.kind !== 'settings') return
  const result: ChromeOverlayResult = {
    type: 'select',
    requestId: state.requestId,
    id: phoneDeviceSelectionId(deviceId),
  }
  bridge.chromeOverlayResult(result)
}
