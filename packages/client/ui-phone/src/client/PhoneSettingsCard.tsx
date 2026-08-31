/**
 * Phone plugin settings card: the six locked mockup states of
 * design/device-dock/settings-card.html. Every fact arrives through props
 * (enable flag, environment view, callbacks); the component never reaches ctx.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type {
  PhoneEnvironmentCheck, PhoneEnvironmentError, PhoneEnvironmentView, PhoneReadyDevice,
} from './phone-environment.ts'
import {
  ANDROID_CREATE_AVD, ANDROID_INSTALL_SYSTEM_IMAGE, ANDROID_LAUNCH_EMULATOR,
  IOS_CREATE_SIMULATOR, IOS_DOWNLOAD_PLATFORM,
} from './phone-wizard-commands.ts'
import { PhoneTabIcon } from './phone-icon.tsx'
import css from './PhoneSettingsCard.module.css'

/** Props of the phone settings card, threaded from the slot inject face. */
export interface PhoneSettingsCardProps {
  /** Durable `ui-phone.enabled`; false keeps the off chrome. */
  readonly enabled: boolean
  /** Environment view the card switches on. */
  readonly view: PhoneEnvironmentView
  /** Persist the enable switch. */
  readonly onEnabledChange: (enabled: boolean) => void
  /** Re-run detection after the user finishes a wizard step. */
  readonly onRedetect: () => void
  /** Copy one command-level install line to the clipboard. */
  readonly onCopy: (command: string) => void
  /** Fire the unified next-action verb for one error row. */
  readonly onNextAction: (kind: string) => void
}

const ANDROID_WIZARD_ROWS = [
  { comment: '# 下载 Android 系统镜像（API 35，Google APIs ARM64）', command: ANDROID_INSTALL_SYSTEM_IMAGE },
  { comment: '# 创建名为 Pixel_6_API_35 的 AVD（机型 pixel_6）', command: ANDROID_CREATE_AVD },
  { comment: '# 启动模拟器（也可以留到会话里让 Agent 启动）', command: ANDROID_LAUNCH_EMULATOR },
] as const

const IOS_WIZARD_ROWS = [
  { comment: '# 下载 iOS 模拟器运行时', command: IOS_DOWNLOAD_PLATFORM },
  { comment: '# 创建一台 iPhone 16 Pro 模拟器', command: IOS_CREATE_SIMULATOR },
] as const

const DEVICE_GROUPS: readonly {
  readonly id: PhoneReadyDevice['group']
  readonly title: string
}[] = [
  { id: 'android-emulator', title: '模拟器 · ANDROID' },
  { id: 'ios-simulator', title: '模拟器 · IOS' },
  { id: 'usb', title: 'USB 真机' },
]

/**
 * Render the phone settings card for one environment view.
 * @param props - enable flag, environment view, and the card's callbacks.
 * @returns the card.
 */
export function PhoneSettingsCard(props: PhoneSettingsCardProps): ReactNode {
  const { enabled, view, onEnabledChange, onRedetect, onCopy, onNextAction } = props
  return (
    <article className={css.card}>
      <header className={css.head}>
        <div className={css.icon} aria-hidden="true">
          <PhoneTabIcon size={20} />
        </div>
        <div className={css.titleBlock}>
          <h3 className={css.title}>{titleOf(view)}</h3>
          <p className={css.description}>{descriptionOf(view)}</p>
        </div>
        {view.kind === 'ready' && (
          <span className={css.summary}>
            <span className={clsx(css.dot, css.dotOn)} />
            {`环境正常 · ${String(view.availableCount)} 台可用`}
          </span>
        )}
        {view.kind === 'ready' && (
          <button type="button" className={css.ghost} onClick={onRedetect}>重新检测</button>
        )}
        <label className={css.switch}>
          <input
            type="checkbox"
            role="switch"
            aria-label="启用手机设备"
            checked={enabled}
            onChange={(event) => { onEnabledChange(event.target.checked) }}
          />
          <span className={css.track} />
          <span className={css.knob} />
        </label>
      </header>
      {bodyOf(view, { onCopy, onNextAction })}
      {footerOf(view)}
    </article>
  )
}

function titleOf(view: PhoneEnvironmentView): string {
  switch (view.kind) {
    case 'android-wizard': return '创建第一台 Android 模拟器'
    case 'ios-wizard': return 'iOS 环境差两步'
    case 'off':
    case 'probing':
    case 'ready':
    case 'errors':
      return '手机设备'
  }
}

function descriptionOf(view: PhoneEnvironmentView): string {
  switch (view.kind) {
    case 'off':
      return '把 Android / iOS 模拟器与 USB 真机接入会话。启用后 Agent 获得设备工具，你可以在右侧面板实时观看画面并随时接管。'
    case 'probing':
      return '正在检测本机的调试工具与模拟器运行时，检测完成后按缺失项给出指引。'
    case 'android-wizard':
      return '需要 Android SDK 命令行工具；插件不会替你下载 SDK 二进制。依次执行以下命令（macOS / Linux）：'
    case 'ios-wizard':
      return '仅 macOS 可用；需要完整 Xcode。先补齐模拟器运行时，再创建一台 iPhone 模拟器。'
    case 'ready':
      return '环境就绪。点击任一设备的「打开面板」在右侧查看实时画面，Agent 的 device_* 工具同时生效。'
    case 'errors':
      return '启用后发现的问题列在这里，每条都带下一步动作；处理完条目自动消失。'
  }
}

function bodyOf(
  view: PhoneEnvironmentView,
  actions: { onCopy: (command: string) => void; onNextAction: (kind: string) => void },
): ReactNode {
  switch (view.kind) {
    case 'off':
      return null
    case 'probing':
      return <ProbingBody checks={view.checks} />
    case 'android-wizard':
      return <AndroidWizardBody platformToolsInstalled={view.platformToolsInstalled} onCopy={actions.onCopy} />
    case 'ios-wizard':
      return <IosWizardBody onCopy={actions.onCopy} />
    case 'ready':
      return <ReadyBody devices={view.devices} />
    case 'errors':
      return <ErrorsBody errors={view.errors} onNextAction={actions.onNextAction} />
  }
}

function footerOf(view: PhoneEnvironmentView): ReactNode {
  switch (view.kind) {
    case 'off':
      return <p className={css.foot}>关闭时不注册任何 device_* 工具，也不监听 adb / mobilecli 进程；本机环境不受影响。</p>
    case 'android-wizard':
      return <p className={css.foot}>完成后点右上角「重新检测」，AVD 出现在清单即可打开面板。USB 真机无需此步，打开 USB 调试并授权即可。</p>
    case 'ios-wizard':
      return <p className={css.foot}>模拟器不需要 WDA；真机上的每次点击都有真实后果，涉及登录与支付的步骤请人工接管。</p>
    case 'ready':
      return <p className={css.foot}>停止的设备先用「启动」拉起再打开面板；清单变化会实时刷新，无需重启会话。</p>
    case 'probing':
    case 'errors':
      return null
  }
}

function ProbingBody({ checks }: { checks: readonly PhoneEnvironmentCheck[] }): ReactNode {
  return (
    <div className={css.body}>
      <div className={css.probeLine}>
        <span className={css.spinner} aria-hidden="true" />
        正在探测 PATH、ANDROID_HOME 与 Xcode 组件…
      </div>
      <div className={css.checklist}>
        {checks.map(check => (
          <div key={check.id} className={css.checkRow}>
            <CheckMark status={check.status} />
            <span className={css.checkName}>
              {check.name}
              <small>{check.caption}</small>
            </span>
            <span className={css.checkDetail}>{check.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CheckMark({ status }: { status: PhoneEnvironmentCheck['status'] }): ReactNode {
  if (status === 'pending') return <span className={css.spinner} aria-hidden="true" />
  return (
    <span className={clsx(css.iconDot, status === 'ok' ? css.ok : css.bad)} aria-hidden="true">
      {status === 'ok' ? '✓' : '✕'}
    </span>
  )
}

function AndroidWizardBody(props: {
  platformToolsInstalled: boolean
  onCopy: (command: string) => void
}): ReactNode {
  return (
    <div className={css.body}>
      <div className={css.steps}>
        <span className={clsx(css.stepchip, props.platformToolsInstalled && css.stepDone)}>
          <i>{props.platformToolsInstalled ? '✓' : '1'}</i>
          platform-tools 已安装
        </span>
        <span className={css.stepchip}><i>2</i>下载系统镜像</span>
        <span className={css.stepchip}><i>3</i>创建 AVD</span>
        <span className={css.stepchip}><i>4</i>启动模拟器</span>
      </div>
      <CommandList rows={ANDROID_WIZARD_ROWS} onCopy={props.onCopy} />
    </div>
  )
}

function IosWizardBody({ onCopy }: { onCopy: (command: string) => void }): ReactNode {
  return (
    <div className={css.body}>
      <div className={clsx(css.alert, css.warn)}>
        <span className={clsx(css.iconDot, css.warnDot)} aria-hidden="true">!</span>
        <p>
          未找到 iOS 模拟器运行时
          <small>Xcode → Settings → Components 中下载 iOS 平台，或执行以下命令（约数 GB）：</small>
        </p>
      </div>
      <CommandList rows={IOS_WIZARD_ROWS} onCopy={onCopy} />
      <div className={clsx(css.alert, css.info)}>
        <span className={clsx(css.iconDot, css.infoDot)} aria-hidden="true">W</span>
        <p>
          USB 真机的前置条件：WebDriverAgent
          <small>控制真机需自备 WDA checkout 并完成签名与设备信任；免费开发者证书 7 天过期，过期后需重新构建。就绪后面板内会出现「构建 WDA」入口。</small>
        </p>
      </div>
    </div>
  )
}

function ReadyBody({ devices }: { devices: readonly PhoneReadyDevice[] }): ReactNode {
  return (
    <div className={css.body}>
      {DEVICE_GROUPS.map((group) => {
        const rows = devices.filter(device => device.group === group.id)
        if (rows.length === 0) return null
        return (
          <section key={group.id} className={css.devGroup} aria-label={group.title}>
            <div className={css.gname}>{group.title}</div>
            {rows.map(device => (
              <div key={device.id} className={css.devRow}>
                <span
                  aria-hidden="true"
                  className={clsx(css.dot, device.online ? css.dotOn : css.dotOff)}
                />
                <span className={css.devName}>{device.name}</span>
                <span className={css.devMeta}>{device.meta}</span>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

function ErrorsBody(props: {
  errors: readonly PhoneEnvironmentError[]
  onNextAction: (kind: string) => void
}): ReactNode {
  return (
    <div className={css.body}>
      {props.errors.map(error => (
        <div
          key={error.kind}
          className={clsx(css.alert, error.kind === 'no-devices' ? css.warn : css.err)}
        >
          <span
            className={clsx(css.iconDot, error.kind === 'no-devices' ? css.warnDot : css.bad)}
            aria-hidden="true"
          >
            {error.kind === 'no-devices' ? '!' : '✕'}
          </span>
          <p>
            {error.title}
            <small>{error.detail}</small>
          </p>
          {error.command !== undefined && <code className={css.alertCmd}>{error.command}</code>}
          <button
            type="button"
            className={css.ghost}
            onClick={() => { props.onNextAction(error.kind) }}
          >
            {error.nextAction}
          </button>
        </div>
      ))}
    </div>
  )
}

function CommandList(props: {
  rows: readonly { readonly comment: string; readonly command: string }[]
  onCopy: (command: string) => void
}): ReactNode {
  return (
    <div className={css.cmdlist}>
      {props.rows.map(row => (
        <div key={row.command} className={css.cmd}>
          <span className={css.txt}>
            <span className={css.cmt}>{row.comment}</span>
            <code>{row.command}</code>
          </span>
          <button
            type="button"
            className={css.copy}
            onClick={() => { props.onCopy(row.command) }}
          >
            复制
          </button>
        </div>
      ))}
    </div>
  )
}
