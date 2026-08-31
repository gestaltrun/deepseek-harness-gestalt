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

const DEVICE_GROUPS: readonly {
  readonly id: PhoneReadyDevice['group']
  readonly title: string
}[] = [
  { id: 'android-emulator', title: '模拟器 · ANDROID' },
  { id: 'ios-simulator', title: '模拟器 · IOS' },
  { id: 'usb', title: 'USB 真机' },
]

type PhoneEnvironmentKind = PhoneEnvironmentView['kind']

const TITLES = {
  off: '手机设备',
  probing: '手机设备',
  'android-wizard': '创建第一台 Android 模拟器',
  'ios-wizard': 'iOS 环境差两步',
  ready: '手机设备',
  errors: '手机设备',
} satisfies Record<PhoneEnvironmentKind, string>

const DESCRIPTIONS = {
  off: '把 Android / iOS 模拟器与 USB 真机接入会话。启用后 Agent 获得设备工具，你可以在右侧面板实时观看画面并随时接管。',
  probing: '正在检测本机的调试工具与模拟器运行时，检测完成后按缺失项给出指引。',
  'android-wizard': '尚无设备。请在上方 Android 分栏一键准备默认模拟器，或连接已启用 USB 调试的真机。',
  'ios-wizard': '仅 macOS 可用；需要完整 Xcode。先补齐模拟器运行时，再创建一台 iPhone 模拟器。',
  ready: '环境就绪。点击任一设备的「打开面板」在右侧查看实时画面，Agent 的 device_* 工具同时生效。',
  errors: '启用后发现的问题列在这里，每条都带下一步动作；处理完条目自动消失。',
} satisfies Record<PhoneEnvironmentKind, string>

const FOOTERS = {
  off: <p className={css.foot}>关闭时不注册任何 device_* 工具，也不监听 adb / mobilecli 进程；本机环境不受影响。</p>,
  probing: null,
  'android-wizard': <p className={css.foot}>Android 自动准备与 USB 调试、RSA 信任等人工前置条件分开显示。</p>,
  'ios-wizard': <p className={css.foot}>模拟器由设备控制代理连接；真机上的每次点击都有真实后果，涉及登录与支付的步骤请人工接管。</p>,
  ready: <p className={css.foot}>停止的设备先用「启动」拉起再打开面板；清单变化会实时刷新，无需重启会话。</p>,
  errors: null,
} satisfies Record<PhoneEnvironmentKind, ReactNode>

function assertNever(value: never): never {
  throw new Error(`unhandled phone environment view: ${JSON.stringify(value)}`)
}

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
  return TITLES[view.kind]
}

function descriptionOf(view: PhoneEnvironmentView): string {
  return DESCRIPTIONS[view.kind]
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
      return <IosWizardBody />
    case 'ready':
      return <ReadyBody devices={view.devices} />
    case 'errors':
      return <ErrorsBody errors={view.errors} onNextAction={actions.onNextAction} />
    default:
      return assertNever(view)
  }
}

function footerOf(view: PhoneEnvironmentView): ReactNode {
  return FOOTERS[view.kind]
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
  void props.onCopy
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
      <div className={clsx(css.alert, css.info)}>
        <span className={clsx(css.iconDot, css.infoDot)} aria-hidden="true">A</span>
        <p>
          Android 环境尚未准备
          <small>使用上方 Android 分栏查看下载来源、磁盘需求与 SDK License，然后一键完成。</small>
        </p>
      </div>
    </div>
  )
}

function IosWizardBody(): ReactNode {
  return (
    <div className={css.body}>
      <div className={clsx(css.alert, css.warn)}>
        <span className={clsx(css.iconDot, css.warnDot)} aria-hidden="true">!</span>
        <p>
          iOS 环境尚未准备
          <small>使用上方 iOS 分栏检测完整 Xcode，并一键下载 iOS Runtime、创建默认模拟器。</small>
        </p>
      </div>
      <div className={clsx(css.alert, css.info)}>
        <span className={clsx(css.iconDot, css.infoDot)} aria-hidden="true">A</span>
        <p>
          USB 真机需要人工授权
          <small>设备解锁、信任、Developer Mode、Apple ID、系统权限和签名配置保持手动；设备控制代理会报告具体状态。</small>
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
