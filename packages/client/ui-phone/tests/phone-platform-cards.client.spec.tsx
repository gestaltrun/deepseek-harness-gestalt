// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhonePlatformCards } from '../src/client/PhonePlatformCards.tsx'
import type {
  AndroidPreparationPlanView, PhoneAndroidView, PhonePlatformView,
} from '../src/client/phone-runtime-source.ts'

afterEach(cleanup)

function plan(components: Partial<AndroidPreparationPlanView['components']> = {}): AndroidPreparationPlanView {
  return {
    sdkRoot: '/dsh/phone/android/sdk',
    sdkSource: 'managed',
    avdHome: '/dsh/phone/android/avd',
    avdName: 'Pixel_6_API_35_Gestalt',
    abi: 'arm64-v8a',
    commandLineToolsVersion: '15859902',
    commandLineToolsBytes: 156_083_281,
    packageIds: ['platform-tools', 'emulator', 'system-images;android-35;google_apis;arm64-v8a'],
    minimumFreeBytes: 16 * 1024 ** 3,
    licenseUrl: 'https://developer.android.com/studio/terms',
    components: {
      commandLineTools: false,
      platformTools: false,
      emulator: false,
      systemImage: false,
      avd: false,
      ...components,
    },
  }
}

function props(android: PhoneAndroidView, ios: PhonePlatformView = { kind: 'deferred' }) {
  return {
    android,
    ios,
    iosUnsupportedMessage: 'iOS simulators require macOS and Xcode.',
    onPrepareAndroid: vi.fn(),
    onCancelAndroid: vi.fn(),
    onRefreshAndroid: vi.fn(),
    onStartAndroid: vi.fn(),
  }
}

describe('PhonePlatformCards', () => {
  it('requires license consent, prepares the disclosed plan, and lets the user return', () => {
    const card = props({ kind: 'missing', plan: plan() }, {
      kind: 'unsupported', reason: 'macOS required',
    })
    render(<PhonePlatformCards {...card} />)
    expect(screen.getByText('iOS 设备需要 Mac')).toBeTruthy()
    expect(screen.getAllByText('需要下载')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '一键准备 Android' }))
    const confirm = screen.getByRole('button', { name: '接受并准备' })
    expect(confirm).toHaveProperty('disabled', true)
    fireEvent.click(confirm)
    expect(card.onPrepareAndroid).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(confirm)
    expect(card.onPrepareAndroid).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '一键准备 Android' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByText('最低可用空间')).toBeNull()
  })

  it('renders component detection, zero-download disclosure, and both ready operations', () => {
    const zeroPlan = { ...plan({
      commandLineTools: true,
      platformTools: true,
      emulator: true,
      systemImage: true,
      avd: true,
    }), commandLineToolsBytes: 0 }
    const stopped = props({ kind: 'ready', plan: zeroPlan, running: false })
    const { rerender } = render(<PhonePlatformCards {...stopped} />)
    expect(screen.getAllByText('已检测')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '启动默认模拟器' }))
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    expect(stopped.onStartAndroid).toHaveBeenCalledOnce()
    expect(stopped.onRefreshAndroid).toHaveBeenCalledOnce()

    const running = props({ kind: 'ready', plan: zeroPlan, running: true })
    rerender(<PhonePlatformCards {...running} />)
    expect(screen.getByText('已启动')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '启动默认模拟器' })).toBeNull()

    rerender(<PhonePlatformCards {...props({
      kind: 'ready', plan: { ...zeroPlan, components: { ...zeroPlan.components, avd: false } },
      running: true, deviceId: 'emulator-5554',
    })} />)
    expect(screen.getByText('已启动 · emulator-5554')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))

    const missing = props({ kind: 'missing', plan: zeroPlan })
    rerender(<PhonePlatformCards {...missing} />)
    fireEvent.click(screen.getByRole('button', { name: '一键准备 Android' }))
    expect(screen.getByText('无需下载 · 15859902')).toBeTruthy()
  })

  it.each([
    [{ kind: 'deferred' }, '等待 Android 环境 Provider…'],
    [{ kind: 'unsupported', reason: 'host unsupported' }, 'host unsupported'],
    [{ kind: 'checking' }, '正在检测 Android SDK、模拟器和默认 AVD…'],
    [{ kind: 'awaiting-license', plan: plan() }, '缺失项会安装到上方列出的 SDK 根目录，不修改系统 PATH。'],
    [{ kind: 'installing', plan: plan(), step: 'licenses' }, '正在登记 Android SDK License…'],
    [{ kind: 'installing', plan: plan(), step: 'packages' }, '正在安装 platform-tools、Emulator 与 API 35 镜像…'],
    [{ kind: 'creating-avd', plan: plan() }, '正在创建 Pixel 6 · API 35 默认 AVD…'],
    [{ kind: 'checking-acceleration', plan: plan() }, '正在检查硬件虚拟化…'],
    [{ kind: 'booting', plan: plan() }, '正在启动模拟器并验证 mobilecli H264 画面…'],
    [{ kind: 'manual-required', plan: plan(), code: 'virtualization', message: 'enable virtualization' }, 'enable virtualization'],
    [{ kind: 'failed', plan: plan(), code: 'BROKEN', message: 'prepare failed', retryable: true }, 'prepare failed'],
  ] satisfies Array<[PhoneAndroidView, string]>)('renders Android state %#', (android, text) => {
    const card = props(android)
    render(<PhonePlatformCards {...card} />)
    expect(screen.getByText(text)).toBeTruthy()
    const cancel = screen.queryByRole('button', { name: '取消' })
    if (cancel !== null) fireEvent.click(cancel)
    if (android.kind === 'installing' || android.kind === 'creating-avd'
      || android.kind === 'checking-acceleration' || android.kind === 'booting') {
      expect(card.onCancelAndroid).toHaveBeenCalledOnce()
    }
  })

  it('renders download progress and cancels the active transfer', () => {
    const card = props({ kind: 'downloading', plan: plan(), receivedBytes: 1024 ** 2, totalBytes: 2 * 1024 ** 2 })
    render(<PhonePlatformCards {...card} />)
    expect(screen.getByText('正在下载 Android 命令行工具 · 1.0 MB / 2.0 MB')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '正在下载 Android 命令行工具' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(card.onCancelAndroid).toHaveBeenCalledOnce()
  })
})
