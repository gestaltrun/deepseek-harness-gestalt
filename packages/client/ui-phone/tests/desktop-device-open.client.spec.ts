// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isDesktopOverlayDocument, phoneDesktopOverlayBridgeOf, phoneDeviceIdFromSelection, phoneDeviceSelectionId,
  selectPhoneDeviceFromOverlay,
} from '../src/client/desktop-device-open.ts'

describe('Desktop Settings phone-device projection', () => {
  afterEach(() => { document.documentElement.removeAttribute('data-dsh-desktop-overlay') })

  it('recognizes the Desktop overlay document attribute', () => {
    expect(isDesktopOverlayDocument()).toBe(false)
    document.documentElement.setAttribute('data-dsh-desktop-overlay', '')
    expect(isDesktopOverlayDocument()).toBe(true)
  })

  it('round-trips device ids and rejects unrelated or malformed selections', () => {
    const id = phoneDeviceSelectionId('device / 中文')
    expect(phoneDeviceIdFromSelection({ type: 'select', id })).toBe('device / 中文')
    expect(phoneDeviceIdFromSelection({ type: 'close', id })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', id: 'other' })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', id: 'phone-device:%ZZ' })).toBeUndefined()
    expect(phoneDeviceIdFromSelection({ type: 'select', id: 'phone-device:' })).toBeUndefined()
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
    expect(phoneDesktopOverlayBridgeOf({})).toBeUndefined()
  })
})
