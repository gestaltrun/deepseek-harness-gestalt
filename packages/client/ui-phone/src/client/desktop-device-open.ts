/** Desktop overlay projection for opening a Settings device on the Session Surface. */

const PHONE_DEVICE_SELECTION_PREFIX = 'phone-device:'

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

/** Desktop bridge verbs used by Phone Settings without importing Desktop chrome. */
export interface PhoneDesktopOverlayBridge {
  chromeOverlayGetState(): Promise<{ readonly kind: string; readonly requestId: string } | null>
  chromeOverlayResult(result: { readonly type: 'select'; readonly requestId: string; readonly id: string }): void
  onChromeOverlayResult(listener: (result: unknown) => void): () => void
}

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
 * Serialize one device identity through the bounded overlay selection id.
 * @param deviceId - Android serial or iOS UDID.
 * @returns encoded overlay selection id.
 */
export function phoneDeviceSelectionId(deviceId: string): string {
  return `${PHONE_DEVICE_SELECTION_PREFIX}${encodeURIComponent(deviceId)}`
}

/**
 * Parse a device-open selection received from the untrusted overlay IPC edge.
 * @param value - Candidate overlay result.
 * @returns decoded device identity, or undefined for another result.
 */
export function phoneDeviceIdFromSelection(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'select' || typeof record.id !== 'string'
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
  const state = await bridge.chromeOverlayGetState()
  if (state?.kind !== 'settings') return
  bridge.chromeOverlayResult({
    type: 'select',
    requestId: state.requestId,
    id: phoneDeviceSelectionId(deviceId),
  })
}
