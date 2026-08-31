// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhoneRuntimeBar } from '../src/client/PhoneRuntimeBar.tsx'

afterEach(cleanup)

describe('PhoneRuntimeBar', () => {
  it('renders the pinned missing asset and starts preparation', () => {
    const onPrepare = vi.fn()
    render(<PhoneRuntimeBar
      runtime={{ kind: 'missing', targetVersion: '1.0.5', assetBytes: 5_458_848 }}
      onPrepare={onPrepare}
      onCancel={() => {}}
      onRefresh={() => {}}
    />)
    expect(screen.getByText(/未准备 · v1.0.5 · 5.2 MB/)).toBeTruthy()
    expect(screen.getByText(/安装到 \$DSH_HOME\/phone/)).toBeTruthy()
    const prepare = screen.getByRole('button', { name: '准备 mobilecli' })
    expect(prepare.className).toContain('primary')
    fireEvent.click(prepare)
    expect(onPrepare).toHaveBeenCalledOnce()
  })

  it('renders progress/cancel and ready/refresh operations', () => {
    const onCancel = vi.fn()
    const { rerender } = render(<PhoneRuntimeBar
      runtime={{ kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 50, totalBytes: 100 }}
      onPrepare={() => {}}
      onCancel={onCancel}
      onRefresh={() => {}}
    />)
    expect(screen.getByRole('progressbar', { name: 'mobilecli 下载进度' })).toBeTruthy()
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(cancel.className).toContain('outline')
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledOnce()

    const onRefresh = vi.fn()
    rerender(<PhoneRuntimeBar
      runtime={{ kind: 'ready', version: '1.0.5', source: 'managed' }}
      onPrepare={() => {}}
      onCancel={() => {}}
      onRefresh={onRefresh}
    />)
    expect(screen.getByText('已就绪 · v1.0.5 · managed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('keeps failed state retryable', () => {
    render(<PhoneRuntimeBar
      runtime={{ kind: 'failed', targetVersion: '1.0.5', code: 'PHONE_ENVIRONMENT_DIGEST', message: '摘要不匹配' }}
      onPrepare={() => {}}
      onCancel={() => {}}
      onRefresh={() => {}}
    />)
    expect(screen.getByText('准备失败 · 摘要不匹配')).toBeTruthy()
    expect(screen.getByRole('button', { name: '准备 mobilecli' })).toBeTruthy()
  })
})
