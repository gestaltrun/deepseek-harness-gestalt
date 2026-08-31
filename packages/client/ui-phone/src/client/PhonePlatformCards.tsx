/** Scheme-C Android/iOS platform cards below the shared mobilecli runtime. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PhoneAndroidView, PhonePlatformView } from './phone-runtime-source.ts'
import css from './PhonePlatformCards.module.css'

export interface PhonePlatformCardsProps {
  readonly android: PhoneAndroidView
  readonly ios: PhonePlatformView
  readonly iosUnsupportedMessage: string
  readonly onPrepareAndroid: () => void
  readonly onCancelAndroid: () => void
  readonly onRefreshAndroid: () => void
  readonly onStartAndroid: () => void
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
        {props.ios.kind === 'unsupported'
          ? <div className={css.unavailable}><strong>iOS 设备需要 Mac</strong><p>{props.iosUnsupportedMessage}</p></div>
          : <div className={css.deferred}><strong>需要 macOS + 完整 Xcode</strong><p>iOS Runtime 与默认模拟器准备由独立平台能力提供。</p></div>}
      </article>
    </div>
  )
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
    case 'booting': return <p className={css.status}>正在启动模拟器并等待 Android 完成启动…</p>
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
    return (
      <div className={css.actions}>
        {!props.state.running && <Button variant="primary" onClick={props.onStart}>启动默认模拟器</Button>}
        <Button variant="outline" onClick={props.onRefresh}>重新检测</Button>
      </div>
    )
  }
  if (props.state.kind === 'unsupported' || props.state.kind === 'deferred' || props.state.kind === 'checking') return null
  return (
    <div className={css.actions}>
      <Button variant="primary" onClick={props.onPrepare}>一键准备 Android</Button>
      <Button variant="outline" onClick={props.onRefresh}>查看明细</Button>
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
