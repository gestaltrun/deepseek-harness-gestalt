/** Shared managed-mobilecli row above the Android and iOS preparation sections. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PhoneManagedRuntimeView } from './phone-runtime-source.ts'
import css from './PhoneRuntimeBar.module.css'

/** Props for the shared phone runtime row. */
export interface PhoneRuntimeBarProps {
  readonly runtime: PhoneManagedRuntimeView
  readonly onPrepare: () => void
  readonly onCancel: () => void
  readonly onRefresh: () => void
}

/** Render source, version, download size, progress, and the current operation. */
export function PhoneRuntimeBar(props: PhoneRuntimeBarProps): ReactNode {
  const runtime = props.runtime
  const busy = runtime.kind === 'downloading' || runtime.kind === 'verifying' || runtime.kind === 'activating'
  return (
    <article className={css.bar} data-phone-runtime={runtime.kind}>
      <div className={css.copy}>
        <strong>设备运行时 · mobilecli</strong>
        <span>{detail(runtime)}</span>
        <small>来源：mobile-next/mobilecli 官方 1.0.5 · 安装到 $DSH_HOME/phone</small>
      </div>
      {runtime.kind === 'downloading' && (
        <progress max={runtime.totalBytes} value={runtime.receivedBytes} aria-label="mobilecli 下载进度" />
      )}
      {busy
        ? <Button variant="outline" onClick={props.onCancel}>取消</Button>
        : runtime.kind === 'ready'
          ? <Button variant="outline" onClick={props.onRefresh}>重新检测</Button>
          : <Button variant="primary" onClick={props.onPrepare}>准备 mobilecli</Button>}
    </article>
  )
}

function detail(runtime: PhoneManagedRuntimeView): string {
  switch (runtime.kind) {
    case 'missing': return `未准备 · v${runtime.targetVersion}${runtime.assetBytes === undefined ? '' : ` · ${formatBytes(runtime.assetBytes)}`}`
    case 'downloading': return `下载中 · ${formatBytes(runtime.receivedBytes)} / ${formatBytes(runtime.totalBytes)}`
    case 'verifying': return `正在校验 v${runtime.targetVersion} 的大小、SHA-256 与归档`
    case 'activating': return `正在激活 v${runtime.targetVersion} · ${runtime.source}`
    case 'ready': return `已就绪 · v${runtime.version} · ${runtime.source}`
    case 'failed': return `准备失败 · ${runtime.message}`
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
