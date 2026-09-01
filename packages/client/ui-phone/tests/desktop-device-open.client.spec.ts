// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { CHROME_OVERLAY_ID_MAX_LENGTH } from '@deepseek-ai/dsh-client-ui-desktop/protocol'
import {
  isDesktopOverlayDocument, phoneDesktopOverlayBridgeOf, phoneDeviceIdFromSelection, phoneDeviceSelectionId,
  PHONE_DESKTOP_OVERLAY_ID_MAX_LENGTH, selectPhoneDeviceFromOverlay, waitForPhoneGate,
} from '../src/client/desktop-device-open.ts'
import type { PhoneSettings } from '../src/phone-settings.ts'

describe('Desktop Settings phone-device projection', () => {
  afterEach(() => { document.documentElement.removeAttribute('data-dsh-desktop-overlay') })

  it('recognizes the Desktop overlay document attribute', () => {
    expect(isDesktopOverlayDocument()).toBe(false)
    document.documentElement.setAttribute('data-dsh-desktop-overlay', '')
    expect(isDesktopOverlayDocument()).toBe(true)
  })

  it('round-trips device ids and rejects unrelated or malformed selections', () => {
    expect(PHONE_DESKTOP_OVERLAY_ID_MAX_LENGTH).toBe(CHROME_OVERLAY_ID_MAX_LENGTH)
    const id = phoneDeviceSelectionId('device / 中文')
    expect(phoneDeviceIdFromSelection({ type: 'select', requestId: 'settings-1', id })).toBe('device / 中文')
    expect(phoneDeviceIdFromSelection({ type: 'close', requestId: 'settings-1', id })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', requestId: 'settings-1', id: 'other' })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', requestId: 'settings-1', id: 'phone-device:%ZZ' })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', requestId: 'settings-1', id: 'phone-device:' })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', id })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', requestId: 'x'.repeat(129), id })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', requestId: 'settings-1', id: 'x'.repeat(129) })).toBeUndefined()
    expect(() => phoneDeviceSelectionId('')).toThrow(RangeError)
    expect(() => phoneDeviceSelectionId('中'.repeat(39))).toThrow(RangeError)
    expect(phoneDeviceIdFromSelection(null)).toBeUndefined()
  })

  it('selects through the active Settings request only', async () => {
    const result = vi.fn()
    const bridge = {
      chromeOverlayGetState: vi.fn().mockResolvedValue({ kind: 'settings', requestId: 'settings-1' }),
      chromeOverlayResult: result,
      onChromeOverlayResult: () => () => {},
    }
    expect(phoneDesktopOverlayBridgeOf(bridge)).toBe(bridge)
    await selectPhoneDeviceFromOverlay(bridge, 'fbcd1d21')
    expect(result).toHaveBeenCalledWith({
      type: 'select', requestId: 'settings-1', id: 'phone-device:fbcd1d21',
    })
    bridge.chromeOverlayGetState.mockResolvedValue({ kind: 'menu', requestId: 'menu-1' })
    await selectPhoneDeviceFromOverlay(bridge, 'other')
    expect(result).toHaveBeenCalledOnce()
    expect(phoneDesktopOverlayBridgeOf(null)).toBeUndefined()
    expect(phoneDesktopOverlayBridgeOf({})).toBeUndefined()
    expect(phoneDesktopOverlayBridgeOf({ chromeOverlayGetState: () => null })).toBeUndefined()
    expect(phoneDesktopOverlayBridgeOf({
      chromeOverlayGetState: () => null,
      chromeOverlayResult: () => {},
    })).toBeUndefined()
  })

  it('waits for the durable gate and settles false when its renderer is cancelled', async () => {
    const ready = stubSettingsScope<PhoneSettings>()
    ready.publish({ status: 'ready' })
    await expect(waitForPhoneGate(ready.scope, () => true, new AbortController().signal)).resolves.toBe(true)

    const loading = stubSettingsScope<PhoneSettings>()
    const resolved = waitForPhoneGate(loading.scope, () => true, new AbortController().signal)
    expect(loading.listenerCount()).toBe(1)
    loading.publish({ writable: true })
    expect(loading.listenerCount()).toBe(1)
    loading.publish({ status: 'ready' })
    await expect(resolved).resolves.toBe(true)
    expect(loading.listenerCount()).toBe(0)

    const cancelled = stubSettingsScope<PhoneSettings>()
    const lifetime = new AbortController()
    const pending = waitForPhoneGate(cancelled.scope, () => true, lifetime.signal)
    lifetime.abort()
    await expect(pending).resolves.toBe(false)
    expect(cancelled.listenerCount()).toBe(0)
    await expect(waitForPhoneGate(cancelled.scope, () => true, lifetime.signal)).resolves.toBe(false)
  })
})
