// @vitest-environment jsdom
/**
 * Phone settings card: the six locked mockup states plus the copy-button
 * commands. Specs feed the card through its public props (enable flag,
 * environment view, callbacks) and assert user-visible copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { PhoneSettingsCard } from '../src/client/PhoneSettingsCard.tsx'
import { PhoneSettingsSection } from '../src/client/PhoneSettingsSection.tsx'
import type { PhoneSettingsSectionProps } from '../src/client/PhoneSettingsSection.tsx'
import type { PhoneEnvironmentView } from '../src/client/phone-environment.ts'
import { zh } from '../src/client/locales.ts'
import type { PhoneSettingsCardState } from '../src/client/phone-settings-controller.ts'
import {
  ANDROID_CREATE_AVD, ANDROID_INSTALL_PLATFORM_TOOLS, ANDROID_INSTALL_SYSTEM_IMAGE,
  ANDROID_LAUNCH_EMULATOR, IOS_CREATE_SIMULATOR, IOS_DOWNLOAD_PLATFORM,
} from '../src/client/phone-wizard-commands.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderCard(view: PhoneEnvironmentView, rest: {
  enabled?: boolean
  onEnabledChange?: (enabled: boolean) => void
  onRedetect?: () => void
  onCopy?: (command: string) => void
  onNextAction?: (kind: string) => void
} = {}) {
  render(
    <PhoneSettingsCard
      enabled={rest.enabled ?? view.kind !== 'off'}
      view={view}
      onEnabledChange={rest.onEnabledChange ?? (() => {})}
      onRedetect={rest.onRedetect ?? (() => {})}
      onCopy={rest.onCopy ?? (() => {})}
      onNextAction={rest.onNextAction ?? (() => {})}
    />,
  )
}

describe('PhoneSettingsCard six states', () => {
  it('fails loud if a future environment view reaches an unupdated renderer', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => { renderCard({ kind: 'future' } as never) })
      .toThrow(/unhandled phone environment view/)
  })

  it('renders the default-off chrome without a probe body', () => {
    renderCard({ kind: 'off' }, { enabled: false })
    expect(screen.getByRole('heading', { name: '手机设备' })).toBeTruthy()
    expect(screen.getByText(/把 Android \/ iOS 模拟器与 USB 真机接入会话/)).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: '启用手机设备' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText(/关闭时不注册任何 device_\* 工具/)).toBeTruthy()
    expect(screen.queryByText('正在探测 PATH、ANDROID_HOME 与 Xcode 组件…')).toBeNull()
  })

  it('renders the probing checklist with spinner copy', () => {
    renderCard({
      kind: 'probing',
      checks: [
        {
          id: 'adb',
          name: 'adb',
          caption: 'Android 平台工具',
          status: 'ok',
          detail: '已检测到 v35.0.1（ANDROID_HOME/platform-tools）',
        },
        {
          id: 'mobilecli',
          name: 'mobilecli',
          caption: '统一设备引擎（可选）',
          status: 'pending',
          detail: '正在确认 H264 流支持…',
        },
        {
          id: 'android-avd',
          name: 'Android 模拟器',
          caption: 'AVD / 系统镜像',
          status: 'missing',
          detail: '未找到任何 AVD —— 完成下方向导后重新检测',
        },
        {
          id: 'ios-runtime',
          name: 'Xcode iOS 运行时',
          caption: 'iOS 模拟器依赖',
          status: 'ok',
          detail: 'iOS 18.4 已就绪',
        },
      ],
    })
    expect(screen.getByText('正在探测 PATH、ANDROID_HOME 与 Xcode 组件…')).toBeTruthy()
    expect(screen.getByText('adb')).toBeTruthy()
    expect(screen.getByText('mobilecli')).toBeTruthy()
    expect(screen.getByText('Android 模拟器')).toBeTruthy()
    expect(screen.getByText('Xcode iOS 运行时')).toBeTruthy()
    expect(screen.getByText('正在确认 H264 流支持…')).toBeTruthy()
    expect(screen.getByText('未找到任何 AVD —— 完成下方向导后重新检测')).toBeTruthy()
  })

  it('renders the Android wizard with the unfinished platform-tools chip', () => {
    renderCard({ kind: 'android-wizard', platformToolsInstalled: false })
    expect(screen.getByText('platform-tools 已安装')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('renders the Android wizard with copyable install commands', () => {
    const onCopy = vi.fn()
    renderCard({ kind: 'android-wizard', platformToolsInstalled: true }, { onCopy })
    expect(screen.getByRole('heading', { name: '创建第一台 Android 模拟器' })).toBeTruthy()
    expect(screen.getByText(ANDROID_INSTALL_SYSTEM_IMAGE)).toBeTruthy()
    expect(screen.getByText(ANDROID_CREATE_AVD)).toBeTruthy()
    expect(screen.getByText(ANDROID_LAUNCH_EMULATOR)).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: '复制' })
    expect(buttons).toHaveLength(3)
    fireEvent.click(buttons[0]!)
    expect(onCopy).toHaveBeenCalledWith(ANDROID_INSTALL_SYSTEM_IMAGE)
    fireEvent.click(buttons[1]!)
    expect(onCopy).toHaveBeenCalledWith(ANDROID_CREATE_AVD)
    fireEvent.click(buttons[2]!)
    expect(onCopy).toHaveBeenCalledWith(ANDROID_LAUNCH_EMULATOR)
  })

  it('renders the iOS wizard with runtime commands and the WDA note', () => {
    const onCopy = vi.fn()
    renderCard({ kind: 'ios-wizard' }, { onCopy })
    expect(screen.getByRole('heading', { name: 'iOS 环境差两步' })).toBeTruthy()
    expect(screen.getByText('未找到 iOS 模拟器运行时')).toBeTruthy()
    expect(screen.getByText(IOS_DOWNLOAD_PLATFORM)).toBeTruthy()
    expect(screen.getByText(IOS_CREATE_SIMULATOR)).toBeTruthy()
    expect(screen.getByText(/USB 真机的前置条件：WebDriverAgent/)).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: '复制' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    expect(onCopy).toHaveBeenCalledWith(IOS_DOWNLOAD_PLATFORM)
    fireEvent.click(buttons[1]!)
    expect(onCopy).toHaveBeenCalledWith(IOS_CREATE_SIMULATOR)
  })

  it('renders the ready inventory grouped by platform', () => {
    renderCard({
      kind: 'ready',
      availableCount: 3,
      devices: [
        {
          id: 'emulator-5554',
          name: 'Pixel_6_API_35',
          group: 'android-emulator',
          online: true,
          meta: 'Android 15 · 运行中 · serial emulator-5554',
        },
        {
          id: 'Galaxy_A54_API_34',
          name: 'Galaxy_A54_API_34',
          group: 'android-emulator',
          online: false,
          meta: 'Android 14 · 已停止',
        },
        {
          id: 'iphone-16-pro',
          name: 'iPhone 16 Pro',
          group: 'ios-simulator',
          online: true,
          meta: 'iOS 18.4 · 运行中',
        },
        {
          id: 'R3CN30',
          name: 'SM-S9310（Galaxy S24）',
          group: 'usb',
          online: true,
          meta: '已授权 USB 调试 · WDA 未构建前仅 Android 动作可用',
        },
      ],
    })
    expect(screen.getByText('环境正常 · 3 台可用')).toBeTruthy()
    expect(screen.getByText('模拟器 · ANDROID')).toBeTruthy()
    expect(screen.getByText('模拟器 · IOS')).toBeTruthy()
    expect(screen.getByText('USB 真机')).toBeTruthy()
    expect(screen.getByText('Pixel_6_API_35')).toBeTruthy()
    expect(screen.getByText('iPhone 16 Pro')).toBeTruthy()
    expect(screen.getByText('SM-S9310（Galaxy S24）')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy()
  })

  it('omits empty device groups in the ready inventory', () => {
    renderCard({ kind: 'ready', availableCount: 0, devices: [] })
    expect(screen.queryByText('模拟器 · ANDROID')).toBeNull()
    expect(screen.queryByText('USB 真机')).toBeNull()
  })

  it('renders the three recoverable error rows with the unified next-action verb', () => {
    const onNextAction = vi.fn()
    renderCard({
      kind: 'errors',
      errors: [
        {
          kind: 'adb-missing',
          title: '未找到 adb',
          detail: 'PATH 与 ANDROID_HOME 下均无平台工具，无法发现任何 Android 设备。',
          nextAction: '下一步动作',
          command: ANDROID_INSTALL_PLATFORM_TOOLS,
        },
        {
          kind: 'no-devices',
          title: '当前没有可用设备',
          detail: '模拟器未启动、也没有连接真机；连接手机后需在设备上允许 USB 调试。',
          nextAction: '下一步动作',
        },
        {
          kind: 'wda-unbuilt',
          title: 'WebDriverAgent 尚未构建',
          detail: 'iPhone 通过 USB 已识别，但真机控制需要先构建并信任 WDA（免费证书 7 天有效）。',
          nextAction: '下一步动作',
        },
      ],
    }, { onNextAction })
    expect(screen.getByText('未找到 adb')).toBeTruthy()
    expect(screen.getByText('当前没有可用设备')).toBeTruthy()
    expect(screen.getByText('WebDriverAgent 尚未构建')).toBeTruthy()
    expect(screen.getByText(ANDROID_INSTALL_PLATFORM_TOOLS)).toBeTruthy()
    const actions = screen.getAllByRole('button', { name: '下一步动作' })
    expect(actions).toHaveLength(3)
    fireEvent.click(actions[0]!)
    expect(onNextAction).toHaveBeenCalledWith('adb-missing')
    fireEvent.click(actions[1]!)
    expect(onNextAction).toHaveBeenCalledWith('no-devices')
    fireEvent.click(actions[2]!)
    expect(onNextAction).toHaveBeenCalledWith('wda-unbuilt')
  })

  it('renders the mobilecli-missing row with the install command', () => {
    renderCard({
      kind: 'errors',
      errors: [{
        kind: 'mobilecli-missing',
        title: '未找到 mobilecli',
        detail: 'Host 已启动，但无法解析 mobilecli 可执行文件。安装后重新检测：',
        nextAction: '下一步动作',
        command: 'npm install -g mobilecli@latest',
      }],
    })
    expect(screen.getByText('未找到 mobilecli')).toBeTruthy()
    expect(screen.getByText('npm install -g mobilecli@latest')).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一步动作' })).toBeTruthy()
  })

  it('renders the missing-service probe-failed row with the same next-action verb', () => {
    renderCard({
      kind: 'errors',
      errors: [{
        kind: 'probe-failed',
        title: '未能探测本机环境',
        detail: '本部署没有挂载 phoneDevices 服务，无法检测 adb、模拟器运行时或已连接设备。',
        nextAction: '下一步动作',
      }],
    })
    expect(screen.getByText('未能探测本机环境')).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一步动作' })).toBeTruthy()
  })

  it('flips the enable switch and redetects from the ready chrome', () => {
    const onEnabledChange = vi.fn()
    const onRedetect = vi.fn()
    renderCard({
      kind: 'ready',
      availableCount: 1,
      devices: [{
        id: 'R3CN30',
        name: 'SM-S9310',
        group: 'usb',
        online: true,
        meta: '已授权 USB 调试',
      }],
    }, { onEnabledChange, onRedetect })
    fireEvent.click(screen.getByRole('switch', { name: '启用手机设备' }))
    expect(onEnabledChange).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    expect(onRedetect).toHaveBeenCalledTimes(1)
  })
})

describe('PhoneSettingsSection', () => {
  it('renders the page chrome around the six-state card', () => {
    const store = createSnapshotStore<PhoneSettingsCardState>({
      enabled: false,
      writable: true,
      view: { kind: 'off' },
      runtime: { kind: 'missing', targetVersion: '1.0.5' },
      platforms: {
        android: { kind: 'deferred' },
        ios: { kind: 'unsupported', reason: 'iOS simulators require macOS and Xcode.' },
      },
    })
    const props = {
      t: (key: keyof typeof zh) => zh[key],
      usePhoneSettingsCard: bindSnapshotSelector(store),
      setEnabled: vi.fn(),
      redetect: vi.fn(),
      copyCommand: vi.fn(),
      nextAction: vi.fn(),
      prepareRuntime: vi.fn(),
      cancelRuntime: vi.fn(),
      refreshRuntime: vi.fn(),
    } as unknown as PhoneSettingsSectionProps
    render(<PhoneSettingsSection {...props} />)
    expect(screen.getByRole('heading', { level: 2, name: '手机设备' })).toBeTruthy()
    expect(screen.getByText(/这与「移动伴侣」不同/)).toBeTruthy()
    expect(screen.getByRole('switch', { name: '启用手机设备' })).toBeTruthy()
    expect(screen.getByText('iOS 模拟器需要在安装 Xcode 的 macOS 上使用。')).toBeTruthy()
  })
})
