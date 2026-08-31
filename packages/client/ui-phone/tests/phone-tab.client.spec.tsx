// @vitest-environment jsdom
/**
 * Phone tab body behavior on realistic props: the enable gate strips, the
 * platform selector drives the hint and list, device rows render from the
 * committed listing with their 打开 action, the USB placeholder follows its
 * group, and 重新检测环境 pulls the fleet listing from the source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PhoneTab } from '../src/client/PhoneTab.tsx'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'
import type { PhoneDeviceSummary } from '../src/client/registry.ts'
import { FakeGate, FakeListingSource, flush, listingOf } from './phone-fakes.client.ts'

afterEach(cleanup)

const EMULATOR: readonly PhoneDeviceSummary[] = [
  { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true },
]

const openDevice = vi.fn()

async function renderTab(enabled: boolean, source: FakeListingSource): Promise<{ gate: FakeGate }> {
  const gate = new FakeGate(enabled)
  render(<PhoneTab gate={gate} source={source} onOpenDevice={openDevice} />)
  await act(async () => { await flush() })
  return { gate }
}

function redetect(): HTMLButtonElement {
  return screen.getByRole('button', { name: '重新检测环境' }) as HTMLButtonElement
}

describe('PhoneTab empty state', () => {
  it('renders the gated empty state when disabled and never pulls the fleet', async () => {
    const source = new FakeListingSource()
    await renderTab(false, source)
    expect(screen.getByRole('note', { name: '手机连接未启用' })).toBeTruthy()
    expect(screen.getByText('该部署未开启设备检测；入口保持可用，启用后即可发现并连接设备。')).toBeTruthy()
    // The full empty-state surface rides below the strip.
    expect(screen.getByRole('group', { name: '平台选择' })).toBeTruthy()
    expect(screen.getByText('模拟器')).toBeTruthy()
    expect(screen.getByText('USB 真机')).toBeTruthy()
    expect(screen.getByText('用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。')).toBeTruthy()
    expect(redetect().disabled).toBe(true)
    expect(source.refreshCount).toBe(0)
  })

  it('omits the gate strip once enabled', async () => {
    await renderTab(true, new FakeListingSource())
    expect(screen.queryByRole('note', { name: '手机连接未启用' })).toBeNull()
  })

  it('refreshes the gate strip the moment the enable switch flips', async () => {
    const source = new FakeListingSource()
    const { gate } = await renderTab(false, source)
    expect(screen.getByRole('note', { name: '手机连接未启用' })).toBeTruthy()
    expect(source.refreshCount).toBe(0)
    // The mounted body follows the gate source: enabling the deployment in
    // the settings card refreshes this tab without remounting it.
    source.scriptNext(listingOf(EMULATOR))
    await act(async () => {
      gate.set(true)
      await flush()
    })
    expect(screen.queryByRole('note', { name: '手机连接未启用' })).toBeNull()
    expect(source.refreshCount).toBe(1)
    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy()
  })

  it('switches the active segment, its guidance copy, and its rows', async () => {
    const source = new FakeListingSource().seed(listingOf(EMULATOR, [
      { id: 'iPhone-16', name: 'iPhone 16', channel: 'emulator', state: 'online', online: true },
    ]))
    await renderTab(true, source)
    const android = screen.getByRole('button', { name: 'Android' })
    const ios = screen.getByRole('button', { name: 'iOS' })
    expect(android.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    fireEvent.click(ios)
    expect(ios.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('切换到 Android 将列出 ADB 模拟器与 USB 真机')).toBeTruthy()
    expect(screen.getByText('iPhone 16')).toBeTruthy()
    expect(screen.queryByText('Pixel_6_API_35')).toBeNull()
  })

  it('lists only online devices and keeps the USB placeholder when no handset is available', async () => {
    const source = new FakeListingSource().seed(listingOf([
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true },
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'offline', online: false },
    ]))
    await renderTab(true, source)
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(screen.queryByText('SM-S9310')).toBeNull()
    expect(screen.queryByText('离线')).toBeNull()
    expect(screen.getByText('用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。')).toBeTruthy()
  })

  it('opens the occupying device only from listed online rows', async () => {
    const source = new FakeListingSource().seed(listingOf([
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true },
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'offline', online: false },
    ]))
    await renderTab(true, source)
    expect(screen.getAllByRole('button', { name: '打开' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(openDevice).toHaveBeenCalledWith('emulator-5554', 'Pixel_6_API_35')
  })

  it('renders the design error arm for an unauthorized handset instead of 离线', async () => {
    const source = new FakeListingSource().seed(listingOf([
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'unauthorized', online: false },
    ]))
    await renderTab(true, source)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('真机未授权调试')).toBeTruthy()
    expect(screen.getByText(/已通过 USB 连接；请在手机上允许「USB 调试」后重新检测/)).toBeTruthy()
    // The offline copy and the open action never coexist with the arm.
    expect(screen.queryByText('离线')).toBeNull()
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull()
  })

  it('re-pulls the listing from the 重新检测 action of the unauthorized arm', async () => {
    const source = new FakeListingSource().seed(listingOf([
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'unauthorized', online: false },
    ]))
    await renderTab(true, source)
    const pulls = source.refreshCount
    source.scriptNext(listingOf([
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'online', online: true },
    ]))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
      await flush()
    })
    expect(source.refreshCount).toBe(pulls + 1)
    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the per-channel running state in the row meta of listed devices', async () => {
    const source = new FakeListingSource().seed(listingOf([
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true },
      { id: 'emulator-9999', name: 'Galaxy_A54_API_34', channel: 'emulator', state: 'offline', online: false },
      { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'online', online: true },
    ]))
    await renderTab(true, source)
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(screen.getByText('在线')).toBeTruthy()
    expect(screen.queryByText('已停止')).toBeNull()
    expect(screen.queryByText('Galaxy_A54_API_34')).toBeNull()
  })

  it('keeps the USB placeholder while only simulators answer', async () => {
    const source = new FakeListingSource().seed(listingOf([
      { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'offline', online: false },
    ]))
    await renderTab(true, source)
    expect(screen.queryByText('Pixel_6_API_35')).toBeNull()
    expect(screen.getByText('用数据线连接手机并在设备上允许 USB 调试后，会出现在这里。')).toBeTruthy()
  })

  it('pulls the fleet on mount when enabled and renders the committed rows', async () => {
    const source = new FakeListingSource()
    source.scriptNext(listingOf(EMULATOR))
    await renderTab(true, source)
    expect(source.refreshCount).toBe(1)
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy()
  })

  it('keeps the empty listing on screen when the mount pull fails', async () => {
    const source = new FakeListingSource()
    source.scriptNext(Promise.reject(new Error('host down')))
    await renderTab(true, source)
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull()
    expect(redetect().disabled).toBe(false)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('无法读取设备清单')).toBeTruthy()
  })

  it('uses the generic recovery copy when a listing failure has no message', async () => {
    const source = new FakeListingSource()
    source.scriptNext(Promise.reject(new Error()))
    await renderTab(true, source)
    expect(screen.getByText('设备清单请求失败；请重新检测。')).toBeTruthy()
  })

  it('renders the install command when the Host reports PHONE_UNRESOLVED', async () => {
    const source = new FakeListingSource()
    source.scriptNext(Promise.reject(new PhoneStreamHttpError(
      502,
      'PHONE_UNRESOLVED',
      'phone-runtime: cannot resolve the mobilecli executable.\n  npm install -g mobilecli@latest',
    )))
    await renderTab(true, source)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('未找到 mobilecli')).toBeTruthy()
    expect(screen.getByText('npm install -g mobilecli@latest')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy()
  })
})

describe('PhoneTab re-detect', () => {
  it('relists devices when 重新检测环境 runs', async () => {
    const source = new FakeListingSource()
    await renderTab(true, source)
    expect(redetect().disabled).toBe(false)
    expect(source.refreshCount).toBe(1)
    source.scriptNext(listingOf(EMULATOR))
    await act(async () => {
      fireEvent.click(redetect())
      await flush()
    })
    expect(source.refreshCount).toBe(2)
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    expect(redetect().disabled).toBe(false)
  })

  it('disables the control while a refresh is in flight', async () => {
    const source = new FakeListingSource()
    await renderTab(true, source)
    let release: (() => void) | undefined
    source.scriptNext(new Promise<void>((resolve) => { release = resolve }))
    await act(async () => {
      fireEvent.click(redetect())
      await flush()
    })
    expect(redetect().disabled).toBe(true)
    await act(async () => {
      release?.()
      await flush()
    })
    expect(redetect().disabled).toBe(false)
  })

  it('keeps the committed listing on screen when a refresh fails', async () => {
    const source = new FakeListingSource().seed(listingOf(EMULATOR))
    await renderTab(true, source)
    source.scriptNext(Promise.reject(new Error('host down')))
    await act(async () => {
      fireEvent.click(redetect())
      await flush()
    })
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    expect(redetect().disabled).toBe(false)
  })
})
