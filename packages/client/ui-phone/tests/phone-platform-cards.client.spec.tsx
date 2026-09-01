// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhonePlatformCards } from '../src/client/PhonePlatformCards.tsx'
import type {
  AndroidPreparationPlanView, PhoneAndroidView, PhoneIosView,
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

const IOS_PLAN = {
  developerDir: '/Applications/Xcode.app/Contents/Developer',
  xcodeVersion: '17.0',
  simulatorName: 'DSH Gestalt iPhone',
  runtime: { identifier: 'runtime-26', name: 'iOS 26.0', version: '26.0', available: true as const },
  deviceType: { identifier: 'type-iphone-17', name: 'iPhone 17' },
}

function props(
  android: PhoneAndroidView,
  ios: PhoneIosView = { kind: 'deferred' },
  iosUnsupportedMessage = 'iOS simulators require macOS and Xcode.',
) {
  return {
    android,
    ios,
    iosUnsupportedMessage,
    onPrepareAndroid: vi.fn(),
    onCancelAndroid: vi.fn(),
    onRefreshAndroid: vi.fn(),
    onStartAndroid: vi.fn(),
    onPrepareIos: vi.fn(),
    onCancelIos: vi.fn(),
    onRefreshIos: vi.fn(),
    onStartIos: vi.fn(),
  }
}

describe('PhonePlatformCards', () => {
  it('requires license consent, prepares the disclosed plan, and lets the user return', () => {
    const card = props({ kind: 'missing', plan: plan() }, {
      kind: 'unsupported', reason: 'macOS required',
    })
    render(<PhonePlatformCards {...card} />)
    expect(screen.getByText('iOS 设备控制需要 macOS + Xcode')).toBeTruthy()
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

  it('renders dedicated unsupported iOS content without preparation claims', () => {
    const message = 'iOS Simulator 和 iPhone 真机控制均需要安装完整 Xcode 的 macOS。Windows 与 Linux 不支持这些功能。'
    render(<PhonePlatformCards {...props(
      { kind: 'deferred' }, { kind: 'unsupported', reason: 'unsupported host' }, message,
    )} />)
    const card = document.querySelector<HTMLElement>('[data-phone-platform-ios="unsupported"]')
    if (card === null) throw new Error('unsupported iOS card did not render')
    expect(within(card).getByText('iOS 设备控制需要 macOS + Xcode')).toBeTruthy()
    expect(within(card).getByText(message)).toBeTruthy()
    expect(within(card).queryByText('iOS Simulator Runtime')).toBeNull()
    expect(within(card).queryByText('DSH Gestalt iPhone')).toBeNull()
    expect(within(card).queryByRole('button')).toBeNull()
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

  it.each([
    [{ kind: 'deferred' }, '等待 iOS 环境 Provider…'],
    [{ kind: 'checking' }, '正在检测 Xcode、Apple 授权、iOS Runtime 与模拟器…'],
    [{ kind: 'xcode-missing', message: 'install full Xcode' }, 'install full Xcode'],
    [{ kind: 'license-required', developerDir: IOS_PLAN.developerDir, message: 'license pending' }, 'license pending'],
    [{ kind: 'manual-required', code: 'first-launch', message: 'finish first launch' }, 'finish first launch'],
    [{ kind: 'manual-required', code: 'xcode-update', message: 'update Xcode', developerDir: IOS_PLAN.developerDir }, 'update Xcode'],
    [{ kind: 'runtime-missing', plan: {
      developerDir: IOS_PLAN.developerDir,
      xcodeVersion: IOS_PLAN.xcodeVersion,
      simulatorName: IOS_PLAN.simulatorName,
      deviceType: IOS_PLAN.deviceType,
    } }, '可由 Xcode 下载 iOS Simulator Runtime'],
    [{ kind: 'no-simulator', plan: IOS_PLAN }, 'iOS Runtime 已就绪'],
    [{ kind: 'preparing', plan: IOS_PLAN, step: 'downloading-runtime' }, '正在通过 Xcode 下载 iOS Simulator Runtime…'],
    [{ kind: 'preparing', plan: IOS_PLAN, step: 'creating-simulator' }, '正在创建 DSH Gestalt iPhone…'],
    [{ kind: 'preparing', plan: IOS_PLAN, step: 'booting' }, '正在启动模拟器，并由设备控制代理验证 mobilecli MJPEG 真实画面…'],
    [{ kind: 'failed', code: 'BROKEN', message: 'iOS preparation failed', retryable: false }, 'iOS preparation failed'],
  ] satisfies Array<[PhoneIosView, string]>)('renders iOS state %#', (ios, text) => {
    render(<PhonePlatformCards {...props({ kind: 'deferred' }, ios)} />)
    expect(screen.getByText(text, { exact: false })).toBeTruthy()
  })

  it('runs each iOS preparation, cancellation, refresh, and start action', () => {
    const missing = props({ kind: 'deferred' }, { kind: 'runtime-missing', plan: IOS_PLAN })
    const rendered = render(<PhonePlatformCards {...missing} />)
    fireEvent.click(screen.getByRole('button', { name: '一键准备 iOS' }))
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    expect(missing.onPrepareIos).toHaveBeenCalledOnce()
    expect(missing.onRefreshIos).toHaveBeenCalledOnce()

    const preparing = props({ kind: 'deferred' }, { kind: 'preparing', plan: IOS_PLAN, step: 'booting' })
    rendered.rerender(<PhonePlatformCards {...preparing} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(preparing.onCancelIos).toHaveBeenCalledOnce()

    const stopped = props({ kind: 'deferred' }, {
      kind: 'ready', plan: IOS_PLAN, deviceId: 'ios-simulator-1', running: false,
    })
    rendered.rerender(<PhonePlatformCards {...stopped} />)
    fireEvent.click(screen.getByRole('button', { name: '启动默认模拟器' }))
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    expect(stopped.onStartIos).toHaveBeenCalledOnce()
    expect(stopped.onRefreshIos).toHaveBeenCalledOnce()

    const running = props({ kind: 'deferred' }, {
      kind: 'ready', plan: IOS_PLAN, deviceId: 'ios-simulator-1', running: true,
    })
    rendered.rerender(<PhonePlatformCards {...running} />)
    expect(screen.getByText('已启动 · MJPEG 实时画面 · ios-simulator-1')).toBeTruthy()

    const manual = props({ kind: 'deferred' }, { kind: 'xcode-missing', message: 'install Xcode' })
    rendered.rerender(<PhonePlatformCards {...manual} />)
    fireEvent.click(screen.getByRole('button', { name: '完成手动步骤后重新检测' }))
    expect(manual.onRefreshIos).toHaveBeenCalledOnce()

    const retryable = props({ kind: 'deferred' }, {
      kind: 'failed', plan: IOS_PLAN, code: 'RETRY', message: 'retry preparation', retryable: true,
    })
    rendered.rerender(<PhonePlatformCards {...retryable} />)
    fireEvent.click(screen.getByRole('button', { name: '一键准备 iOS' }))
    expect(retryable.onPrepareIos).toHaveBeenCalledOnce()
  })

  it('offers cancellation only for Host-owned iOS preparation checking', () => {
    const active = props({ kind: 'deferred' }, { kind: 'checking', operation: 'prepare' })
    const rendered = render(<PhonePlatformCards {...active} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(active.onCancelIos).toHaveBeenCalledOnce()

    rendered.rerender(<PhonePlatformCards {...props({ kind: 'deferred' }, { kind: 'checking' })} />)
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
  })

  it('uses the Provider reason when the deployment has no platform-specific copy', () => {
    render(<PhonePlatformCards {...props(
      { kind: 'deferred' }, { kind: 'unsupported', reason: 'Linux host' }, '',
    )} />)
    expect(screen.getByText('Linux host')).toBeTruthy()
  })
})
