/** Scheme-C Android/iOS platform cards below the shared mobilecli runtime. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PhoneAndroidView, PhoneIosView } from './phone-runtime-source.ts'
import css from './PhonePlatformCards.module.css'

export interface PhonePlatformCardsProps {
  readonly android: PhoneAndroidView
  readonly ios: PhoneIosView
  readonly iosUnsupportedMessage: string
  readonly onPrepareAndroid: () => void
  readonly onCancelAndroid: () => void
  readonly onRefreshAndroid: () => void
  readonly onStartAndroid: () => void
  readonly onPrepareIos: () => void
  readonly onCancelIos: () => void
  readonly onRefreshIos: () => void
  readonly onStartIos: () => void
}

/** Render Android preparation and the stable iOS capability card as parallel platform lanes. */
export function PhonePlatformCards(props: PhonePlatformCardsProps): ReactNode {
  const [confirming, setConfirming] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const plan = 'plan' in props.android ? props.android.plan : undefined
  const begin = (): void => { setConfirming(true); setAccepted(false) }
  const confirm = (): void => {
    if (!accepted) return
    setConfirming(false)
    props.onPrepareAndroid()
  }
  return (
    <div className={css.grid} data-phone-platform-grid>
      <article className={css.card} data-phone-platform-android={props.android.kind}>
        <header className={css.head}>
          <span className={css.logo} aria-hidden="true">A</span>
          <div><h3>Android</h3><p>模拟器与 USB 真机</p></div>
        </header>
        <div className={css.components}>
          <ComponentRow title="platform-tools" detail={componentDetail(plan?.components.platformTools, 'adb')} />
          <ComponentRow title="Android Emulator" detail={componentDetail(plan?.components.emulator, '需要下载')} />
          <ComponentRow title="Pixel 6 · API 35" detail={componentDetail(plan?.components.systemImage && plan.components.avd, '系统镜像与默认 AVD')} />
        </div>
        <AndroidStatus state={props.android} />
        {confirming && plan !== undefined && (
          <div className={css.confirm} data-phone-android-confirm>
            <strong>准备 Android 环境</strong>
            <dl>
              <div><dt>来源</dt><dd>Google Android SDK</dd></div>
              <div><dt>命令行工具</dt><dd>{`${formatBytes(plan.commandLineToolsBytes)} · ${plan.commandLineToolsVersion}`}</dd></div>
              <div><dt>最低可用空间</dt><dd>{formatBytes(plan.minimumFreeBytes)}</dd></div>
              <div><dt>SDK 根目录</dt><dd><code>{plan.sdkRoot}</code></dd></div>
              <div><dt>AVD</dt><dd><code>{`${plan.avdName} · ${plan.abi}`}</code></dd></div>
            </dl>
            <label className={css.license}>
              <input type="checkbox" checked={accepted} onChange={(event) => { setAccepted(event.target.checked) }} />
              <span>
                我已阅读并接受
                {' '}<a href={plan.licenseUrl} target="_blank" rel="noreferrer">Android SDK License</a>
              </span>
            </label>
            <div className={css.confirmActions}>
              <Button variant="outline" onClick={() => { setConfirming(false) }}>返回</Button>
              <Button variant="primary" disabled={!accepted} onClick={confirm}>接受并准备</Button>
            </div>
          </div>
        )}
        {!confirming && (
          <AndroidActions
            state={props.android}
            onPrepare={begin}
            onCancel={props.onCancelAndroid}
            onRefresh={props.onRefreshAndroid}
            onStart={props.onStartAndroid}
          />
        )}
      </article>
      <article className={css.card} data-phone-platform-ios={props.ios.kind}>
        <header className={css.head}>
          <span className={css.logo} aria-hidden="true">●</span>
          <div><h3>iOS</h3><p>模拟器与 USB 真机</p></div>
        </header>
        <IosComponents state={props.ios} />
        <IosStatus state={props.ios} unsupportedMessage={props.iosUnsupportedMessage} />
        <IosActions
          state={props.ios}
          onPrepare={props.onPrepareIos}
          onCancel={props.onCancelIos}
          onRefresh={props.onRefreshIos}
          onStart={props.onStartIos}
        />
      </article>
    </div>
  )
}

function IosComponents({ state }: { readonly state: PhoneIosView }): ReactNode {
  const plan = 'plan' in state ? state.plan : undefined
  const xcodeDetected = plan !== undefined || state.kind === 'license-required'
    || state.kind === 'manual-required' && state.developerDir !== undefined
  return (
    <div className={css.components}>
      <ComponentRow title="完整 Xcode" detail={componentDetail(xcodeDetected, '需要手动安装或更新')} />
      <ComponentRow title="iOS Simulator Runtime" detail={componentDetail(plan?.runtime !== undefined, '可在这里一键下载')} />
      <ComponentRow title="DSH Gestalt iPhone" detail={componentDetail(
        state.kind === 'ready' || state.kind === 'preparing' && state.step === 'booting',
        plan?.deviceType?.name ?? '默认 iPhone 模拟器',
      )} />
    </div>
  )
}

function IosStatus(props: { readonly state: PhoneIosView; readonly unsupportedMessage: string }): ReactNode {
  const state = props.state
  switch (state.kind) {
    case 'deferred': return <p className={css.status}>等待 iOS 环境 Provider…</p>
    case 'unsupported': return <div className={css.unavailable}><strong>iOS 模拟器需要 macOS</strong><p>{props.unsupportedMessage || state.reason}</p></div>
    case 'checking': return <p className={css.status}>正在检测 Xcode、Apple 授权、iOS Runtime 与模拟器…</p>
    case 'xcode-missing': return <p className={css.problem}>{state.message}</p>
    case 'license-required': return <p className={css.problem}>请在 Xcode 中接受 Apple 许可；Gestalt 不会代替你接受。{state.message}</p>
    case 'manual-required': return <p className={css.problem}>{state.message}</p>
    case 'runtime-missing': return <p className={css.status}>可由 Xcode 下载 iOS Simulator Runtime；下载体积由 Apple 决定。</p>
    case 'no-simulator': return <p className={css.status}>iOS Runtime 已就绪，可创建产品默认 iPhone 模拟器。</p>
    case 'preparing': return <p className={css.status}>{iosStep(state.step)}</p>
    case 'ready': return <p className={css.success}>{state.running ? `已启动 · MJPEG 实时画面 · ${state.deviceId}` : '环境已准备，可启动默认 iPhone 模拟器'}</p>
    case 'failed': return <p className={css.problem}>{state.message}</p>
  }
}

function IosActions(props: {
  readonly state: PhoneIosView
  readonly onPrepare: () => void
  readonly onCancel: () => void
  readonly onRefresh: () => void
  readonly onStart: () => void
}): ReactNode {
  if (props.state.kind === 'preparing') return <Button variant="outline" onClick={props.onCancel}>取消</Button>
  if (props.state.kind === 'ready') {
    return <SimulatorReadyActions running={props.state.running} onStart={props.onStart} onRefresh={props.onRefresh} />
  }
  if (props.state.kind === 'runtime-missing' || props.state.kind === 'no-simulator'
    || props.state.kind === 'failed' && props.state.retryable) {
    return (
      <div className={css.actions}>
        <Button variant="primary" onClick={props.onPrepare}>一键准备 iOS</Button>
        <Button variant="outline" onClick={props.onRefresh}>重新检测</Button>
      </div>
    )
  }
  if (props.state.kind === 'xcode-missing' || props.state.kind === 'license-required' || props.state.kind === 'manual-required') {
    return <Button variant="outline" onClick={props.onRefresh}>完成手动步骤后重新检测</Button>
  }
  return null
}

function iosStep(step: 'downloading-runtime' | 'creating-simulator' | 'booting'): string {
  if (step === 'downloading-runtime') return '正在通过 Xcode 下载 iOS Simulator Runtime…'
  if (step === 'creating-simulator') return '正在创建 DSH Gestalt iPhone…'
  return '正在启动模拟器，并由设备控制代理验证 mobilecli MJPEG 真实画面…'
}

function ComponentRow(props: { readonly title: string; readonly detail: { ok: boolean; text: string } }): ReactNode {
  return (
    <div className={css.component}>
      <span className={props.detail.ok ? css.ok : css.missing} aria-hidden="true">{props.detail.ok ? '✓' : '!'}</span>
      <div><strong>{props.title}</strong><small>{props.detail.text}</small></div>
    </div>
  )
}

function componentDetail(value: boolean | undefined, missing: string): { ok: boolean; text: string } {
  if (value === true) return { ok: true, text: '已检测' }
  return { ok: false, text: value === false ? missing : '正在检测' }
}

function AndroidStatus({ state }: { readonly state: PhoneAndroidView }): ReactNode {
  switch (state.kind) {
    case 'deferred': return <p className={css.status}>等待 Android 环境 Provider…</p>
    case 'unsupported': return <p className={css.problem}>{state.reason}</p>
    case 'checking': return <p className={css.status}>正在检测 Android SDK、模拟器和默认 AVD…</p>
    case 'missing':
    case 'awaiting-license': return <p className={css.status}>缺失项会安装到上方列出的 SDK 根目录，不修改系统 PATH。</p>
    case 'downloading': return <Progress value={state.receivedBytes} max={state.totalBytes} label="正在下载 Android 命令行工具" />
    case 'installing': return <p className={css.status}>{state.step === 'licenses' ? '正在登记 Android SDK License…' : '正在安装 platform-tools、Emulator 与 API 35 镜像…'}</p>
    case 'creating-avd': return <p className={css.status}>正在创建 Pixel 6 · API 35 默认 AVD…</p>
    case 'checking-acceleration': return <p className={css.status}>正在检查硬件虚拟化…</p>
    case 'booting': return <p className={css.status}>正在启动模拟器并验证 mobilecli H264 画面…</p>
    case 'manual-required': return <p className={css.problem}>{state.message}</p>
    case 'ready': return <p className={css.success}>{state.running ? `已启动${state.deviceId === undefined ? '' : ` · ${state.deviceId}`}` : '环境已准备，可启动默认模拟器'}</p>
    case 'failed': return <p className={css.problem}>{state.message}</p>
  }
}

function AndroidActions(props: {
  readonly state: PhoneAndroidView
  readonly onPrepare: () => void
  readonly onCancel: () => void
  readonly onRefresh: () => void
  readonly onStart: () => void
}): ReactNode {
  const busy = props.state.kind === 'downloading' || props.state.kind === 'installing'
    || props.state.kind === 'creating-avd' || props.state.kind === 'checking-acceleration'
    || props.state.kind === 'booting'
  if (busy) return <Button variant="outline" onClick={props.onCancel}>取消</Button>
  if (props.state.kind === 'ready') {
    return <SimulatorReadyActions running={props.state.running} onStart={props.onStart} onRefresh={props.onRefresh} />
  }
  if (props.state.kind === 'unsupported' || props.state.kind === 'deferred' || props.state.kind === 'checking') return null
  return (
    <div className={css.actions}>
      <Button variant="primary" onClick={props.onPrepare}>一键准备 Android</Button>
      <Button variant="outline" onClick={props.onRefresh}>重新检测</Button>
    </div>
  )
}

function SimulatorReadyActions(props: {
  readonly running: boolean
  readonly onStart: () => void
  readonly onRefresh: () => void
}): ReactNode {
  return (
    <div className={css.actions}>
      {!props.running && <Button variant="primary" onClick={props.onStart}>启动默认模拟器</Button>}
      <Button variant="outline" onClick={props.onRefresh}>重新检测</Button>
    </div>
  )
}

function Progress(props: { readonly value: number; readonly max: number; readonly label: string }): ReactNode {
  return (
    <div className={css.progress}>
      <span>{`${props.label} · ${formatBytes(props.value)} / ${formatBytes(props.max)}`}</span>
      <progress value={props.value} max={props.max} aria-label={props.label} />
    </div>
  )
}

function formatBytes(bytes: number): string {
  return bytes === 0 ? '无需下载' : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
