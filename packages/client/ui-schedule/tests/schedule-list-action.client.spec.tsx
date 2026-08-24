// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleProjection, ScheduleProjectionItem } from '@deepseek-ai/dsh-schedule/client'
import {
  ScheduleListAction, schedulePopoverPosition, type ScheduleListActionProps,
} from '../src/client/ScheduleListAction.tsx'
import { zh } from '../src/client/locales.ts'

const NOW = Date.parse('2026-08-17T06:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function schedule(overrides: Partial<ScheduleProjectionItem> = {}): ScheduleProjectionItem {
  return {
    id: 'schedule-1' as ScheduleProjectionItem['id'],
    kind: 'after',
    prompt: '检查 Desktop 发布 CI',
    afterSeconds: 3_600,
    scheduledAt: '2026-08-17T07:00:00.000Z',
    paused: false,
    ...overrides,
  } as ScheduleProjectionItem
}

function props(schedules: ScheduleProjection | undefined): ScheduleListActionProps {
  return {
    useProjection: () => schedules,
    onPause: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    onResume: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    onDelete: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    t: makeTranslate(zh),
  } as unknown as ScheduleListActionProps
}

describe('ScheduleListAction visibility and count', () => {
  it('portals the board and opens it leftward from a right-edge trigger', () => {
    const trigger = document.createElement('button')
    trigger.getBoundingClientRect = () => ({
      x: 960, y: 20, width: 24, height: 24, top: 20, right: 984, bottom: 44, left: 960,
      toJSON: () => ({}),
    })
    expect(schedulePopoverPosition(trigger)).toEqual({ top: 49, left: 424 })

    render(<ScheduleListAction {...props([schedule()])} />)
    fireEvent.click(screen.getByRole('button', { name: '1 个定时任务等待执行' }))
    expect(screen.getByRole('list', { name: '定时任务' }).parentElement?.parentElement).toBe(document.body)
  })

  it('renders only for retained schedules and counts scheduled plus overdue but not paused', () => {
    expect(render(<ScheduleListAction {...props(undefined)} />).container.firstChild).toBeNull()
    cleanup()
    expect(render(<ScheduleListAction {...props([])} />).container.firstChild).toBeNull()
    cleanup()

    render(<ScheduleListAction {...props([
      schedule(),
      schedule({ id: 'schedule-2' as ScheduleProjectionItem['id'], scheduledAt: '2026-08-17T05:00:00.000Z' }),
      schedule({ id: 'schedule-3' as ScheduleProjectionItem['id'], paused: true }),
    ])} />)
    const trigger = screen.getByRole('button', { name: '2 个定时任务等待执行' })
    fireEvent.click(trigger)
    const rows = within(screen.getByRole('list', { name: '定时任务' })).getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('等待中'),
      expect.stringContaining('待补跑'),
      expect.stringContaining('已暂停'),
    ])
    cleanup()

    render(<ScheduleListAction {...props([schedule({ paused: true })])} />)
    expect(screen.getByRole('button', { name: '0 个定时任务等待执行' })).toBeTruthy()
    expect(document.querySelector('time')).toBeNull()
  })
})

describe('ScheduleListAction mutations', () => {
  it('pauses or resumes from the projected durable state', async () => {
    const input = props([
      schedule(),
      schedule({ id: 'schedule-2' as ScheduleProjectionItem['id'], prompt: '周报', paused: true }),
    ])
    render(<ScheduleListAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '1 个定时任务等待执行' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停 检查 Desktop 发布 CI' })) })
    expect(input.onPause).toHaveBeenCalledWith('schedule-1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '恢复 周报' })) })
    expect(input.onResume).toHaveBeenCalledWith('schedule-2')
  })

  it('requires inline confirmation before deleting a schedule', () => {
    const input = props([schedule()])
    render(<ScheduleListAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '1 个定时任务等待执行' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 检查 Desktop 发布 CI' }))
    expect(input.onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('确认删除？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除 检查 Desktop 发布 CI' }))
    expect(input.onDelete).toHaveBeenCalledWith('schedule-1')
  })

  it('cancels an in-progress delete confirmation without calling the Host', () => {
    const input = props([schedule()])
    render(<ScheduleListAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '1 个定时任务等待执行' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 检查 Desktop 发布 CI' }))
    fireEvent.click(screen.getByRole('button', { name: '取消删除 检查 Desktop 发布 CI' }))
    expect(input.onDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '删除 检查 Desktop 发布 CI' })).toBeTruthy()
  })

  it('labels every-rules by days, hours, and minutes and reports Host and transport failures', async () => {
    const input = props([
      schedule({ id: 'schedule-day' as ScheduleProjectionItem['id'], kind: 'every', everySeconds: 86_400, prompt: '日报' }),
      schedule({ id: 'schedule-hour' as ScheduleProjectionItem['id'], kind: 'every', everySeconds: 7_200, prompt: '心跳' }),
      schedule({ id: 'schedule-minute' as ScheduleProjectionItem['id'], kind: 'every', everySeconds: 90, prompt: '轮询' }),
    ])
    input.onPause = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { message: '' } })
      .mockRejectedValueOnce('offline')
      .mockRejectedValueOnce(new Error('network down'))
    render(<ScheduleListAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '3 个定时任务等待执行' }))
    expect(screen.getByText('每 1 天')).toBeTruthy()
    expect(screen.getByText('每 2 小时')).toBeTruthy()
    expect(screen.getByText('每 2 分钟')).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停 日报' })) })
    expect(screen.getByRole('alert').textContent).toBe('操作失败')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停 心跳' })) })
    expect(screen.getByRole('alert').textContent).toBe('操作失败')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停 轮询' })) })
    expect(screen.getByRole('alert').textContent).toBe('network down')
  })

  it('ignores a second mutation while one is pending and closes on Escape or an outside pointer', async () => {
    const hold = Promise.withResolvers<{ ok: true; value: undefined }>()
    const input = props([schedule(), schedule({ id: 'schedule-2' as ScheduleProjectionItem['id'], prompt: '周报' })])
    input.onPause = vi.fn().mockReturnValue(hold.promise)
    render(<ScheduleListAction {...input} />)
    const trigger = screen.getByRole('button', { name: '2 个定时任务等待执行' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '暂停 检查 Desktop 发布 CI' }))
    fireEvent.click(screen.getByRole('button', { name: '暂停 周报' }))
    expect(input.onPause).toHaveBeenCalledTimes(1)
    hold.resolve({ ok: true, value: undefined })
    await act(async () => { await hold.promise })

    fireEvent.keyDown(trigger, { key: 'a' })
    expect(screen.getByRole('list', { name: '定时任务' })).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: '定时任务' })).toBeNull()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: '定时任务' })).toBeNull()

    fireEvent.click(trigger)
    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('list', { name: '定时任务' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('list', { name: '定时任务' })).toBeNull()
  })

  it('ticks while open and drops confirmation when the confirmed reminder leaves the projection', () => {
    const input = props([schedule()])
    const view = render(<ScheduleListAction {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '1 个定时任务等待执行' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 检查 Desktop 发布 CI' }))
    act(() => { vi.advanceTimersByTime(30_000) })
    view.rerender(<ScheduleListAction {...props([])} />)
    expect(view.container.firstChild).toBeNull()
  })
})
