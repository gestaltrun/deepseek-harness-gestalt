// @vitest-environment jsdom
/**
 * Phone tab body behavior on realistic props: the enable gate strips, the
 * platform selector drives the hint and list, device rows render from the
 * injected source with their 打开 action, the USB placeholder follows its
 * group, and re-detect stays a disabled placeholder in this skeleton.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PhoneTab } from '../src/client/PhoneTab.tsx'
import type { PhoneBadgeSource, PhoneDeviceSummary } from '../src/client/registry.ts'

afterEach(cleanup)

function sourceWith(devices: readonly PhoneDeviceSummary[], onlineCount = devices.filter(d => d.online).length)
  : PhoneBadgeSource {
  return { getBadge: () => ({ onlineCount }), listDevices: () => devices }
}

const openDevice = vi.fn()

function renderTab(props: { readonly enabled: boolean; readonly source: PhoneBadgeSource }): void {
  render(<PhoneTab {...props} onOpenDevice={openDevice} />)
}

describe('PhoneTab empty state', () => {
  it('renders the gated empty state when disabled', () => {
    renderTab({ enabled: false, source: sourceWith([]) })
    expect(screen.getByRole('note', { name: '手机连接未启用' })).toBeTruthy()
    expect(screen.getByText('该部署未开启设备检测；入口保持可用，启用后即可发现并连接设备。')).toBeTruthy()
    // The full empty-state surface rides below the strip.
    expect(screen.getByRole('group', { name: '平台选择' })).toBeTruthy()
    expect(screen.getByText('模拟器')).toBeTruthy()
    expect(screen.getByText('USB 真机')).toBeTruthy()
    expect(screen.getByText('用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。')).toBeTruthy()
    const redetect = screen.getByRole('button', { name: '重新检测环境' }) as HTMLButtonElement
    expect(redetect.disabled).toBe(true)
  })

  it('omits the gate strip once enabled', () => {
    renderTab({ enabled: true, source: sourceWith([]) })
    expect(screen.queryByRole('note', { name: '手机连接未启用' })).toBeNull()
  })

  it('switches the active segment and its guidance copy', () => {
    renderTab({ enabled: false, source: sourceWith([]) })
    const android = screen.getByRole('button', { name: 'Android' })
    const ios = screen.getByRole('button', { name: 'iOS' })
    expect(android.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('切换到 iOS 将列出 Xcode 模拟器与 WDA 真机')).toBeTruthy()
    fireEvent.click(ios)
    expect(ios.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('切换到 Android 将列出 ADB 模拟器与 USB 真机')).toBeTruthy()
    expect((android as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false')
  })

  it('lists devices of both groups straight from the injected source', () => {
    const devices = [
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator' as const, online: true },
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb' as const, online: false },
    ]
    renderTab({ enabled: true, source: sourceWith(devices) })
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    expect(screen.getByText('在线')).toBeTruthy()
    expect(screen.getByText('SM-S9310')).toBeTruthy()
    expect(screen.getByText('离线')).toBeTruthy()
    // Rows replace the USB placeholder once a device answers.
    expect(screen.queryByText('用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。')).toBeNull()
  })

  it('opens the per-device tab only from online rows', () => {
    const devices = [
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator' as const, online: true },
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb' as const, online: false },
    ]
    renderTab({ enabled: true, source: sourceWith(devices) })
    expect(screen.getAllByRole('button', { name: '打开' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(openDevice).toHaveBeenCalledWith('emulator-5554', 'Pixel_6_API_35')
  })

  it('keeps the USB placeholder while only simulators answer', () => {
    const devices = [
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator' as const, online: false },
    ]
    renderTab({ enabled: true, source: sourceWith(devices) })
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    expect(screen.getByText('用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。')).toBeTruthy()
  })

  it('relists devices when the platform switches', () => {
    const listed: string[] = []
    const source: PhoneBadgeSource = {
      getBadge: () => ({ onlineCount: 0 }),
      listDevices(platform) {
        listed.push(platform)
        return []
      },
    }
    renderTab({ enabled: true, source })
    fireEvent.click(screen.getByRole('button', { name: 'iOS' }))
    expect(listed).toEqual(['android', 'ios'])
  })
})
