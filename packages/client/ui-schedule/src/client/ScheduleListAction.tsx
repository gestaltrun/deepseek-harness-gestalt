/** Session-header task board for durable Schedule reminders. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ScheduleProjectionItem } from '@deepseek-ai/dsh-schedule/client'
import {
  IconChevronDownOutline14,
  IconPauseOutline16,
  IconPlayOutline16,
  IconTrashOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleActions } from './slots.ts'
import type { ScheduleKey } from './locales.ts'
import css from './ScheduleListAction.module.css'

/** Props composed by the Session header slot renderer. */
export type ScheduleListActionProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'schedule'>
  & ScheduleActions

type Translate = ScheduleListActionProps['t']
const POPOVER_MARGIN = 16
const POPOVER_WIDTH = 560

/** Align the task board's right edge to its trigger and clamp it inside the viewport. */
export function schedulePopoverPosition(trigger: HTMLButtonElement): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - POPOVER_MARGIN * 2)
  return {
    top: rect.bottom + 5,
    left: Math.min(
      Math.max(POPOVER_MARGIN, rect.right - width),
      window.innerWidth - width - POPOVER_MARGIN,
    ),
  }
}

function ClockGlyph() {
  return (
    <svg className={css.clock} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7 3.8V7l2.3 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function timingState(schedule: ScheduleProjectionItem, now: number): 'scheduled' | 'overdue' | 'paused' {
  if (schedule.paused) return 'paused'
  return now >= Date.parse(schedule.scheduledAt) ? 'overdue' : 'scheduled'
}

function statusKey(state: ReturnType<typeof timingState>): ScheduleKey {
  if (state === 'scheduled') return 'state.scheduled'
  if (state === 'overdue') return 'state.overdue'
  return 'state.paused'
}

function dotState(state: ReturnType<typeof timingState>): 'ongoing' | 'warning' | 'done' {
  if (state === 'scheduled') return 'ongoing'
  if (state === 'overdue') return 'warning'
  return 'done'
}

function duration(seconds: number, t: Translate): string {
  if (seconds % 86_400 === 0) return t('duration.days', { days: seconds / 86_400 })
  if (seconds % 3_600 === 0) return t('duration.hours', { hours: seconds / 3_600 })
  return t('duration.minutes', { minutes: Math.max(1, Math.round(seconds / 60)) })
}

function rule(schedule: ScheduleProjectionItem, t: Translate): string {
  return schedule.kind === 'every'
    ? t('rule.every', { duration: duration(schedule.everySeconds, t) })
    : t('rule.once')
}

function target(instant: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(Date.parse(instant))
}

/** Render the A-variant Schedule task board from the standard Session projection. */
export function ScheduleListAction({
  useProjection,
  onPause,
  onResume,
  onDelete,
  t,
}: ScheduleListActionProps) {
  const schedules = useProjection('schedules')
  const [open, setOpen] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<CSSProperties>()
  const [now, setNow] = useState(() => Date.now())
  const [confirming, setConfirming] = useState<ScheduleProjectionItem['id'] | null>(null)
  const [pending, setPending] = useState<ScheduleProjectionItem['id'] | null>(null)
  const [error, setError] = useState<{ readonly id: ScheduleProjectionItem['id']; readonly message: string } | null>(null)
  const pendingRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)

  const active = useMemo(() => schedules?.filter(schedule => !schedule.paused) ?? [], [schedules])
  const next = useMemo(() => [...active].sort((left, right) =>
    Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))[0], [active])

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const trigger = triggerRef.current
      if (trigger !== null) setPopoverPosition(schedulePopoverPosition(trigger))
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (schedules === undefined || schedules.length === 0) setOpen(false)
    if (confirming !== null && !schedules?.some(schedule => schedule.id === confirming)) setConfirming(null)
  }, [confirming, schedules])

  const run = useCallback(async (
    id: ScheduleProjectionItem['id'],
    action: () => Promise<Awaited<ReturnType<ScheduleActions['onPause']>>>,
  ): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(id)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) setError({ id, message: result.error.message || t('error.fallback') })
    } catch (cause) {
      setError({ id, message: cause instanceof Error ? cause.message : t('error.fallback') })
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }, [t])

  if (schedules === undefined || schedules.length === 0) return null

  const countLabel = t(active.length === 1 ? 'count.active.one' : 'count.active.other', { count: active.length })
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    if (!open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={closeOnEscape}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          const trigger = triggerRef.current
          if (trigger !== null) setPopoverPosition(schedulePopoverPosition(trigger))
          setOpen(value => !value)
        }}
      >
        <ClockGlyph />
        <span>{t('count.short', { count: active.length })}</span>
        {next === undefined ? null : <time className={css.next}>{target(next.scheduledAt)}</time>}
        <IconChevronDownOutline14 className={open ? css.chevronOpen : undefined} />
      </button>
      {open && popoverPosition !== undefined
        ? createPortal((
          <section ref={popoverRef} className={css.popover} style={popoverPosition} aria-label={t('list.aria')}>
            <header className={css.header}>
              <div><strong>{t('list.title')}</strong><span>{t('list.scope')}</span></div>
              <span className={css.total}>{schedules.length}</span>
            </header>
            <ul className={css.list} aria-label={t('list.aria')}>
              {schedules.map((schedule) => {
                const state = timingState(schedule, now)
                const isPending = pending === schedule.id
                const isConfirming = confirming === schedule.id
                return (
                  <li key={schedule.id} className={css.row}>
                    <StateDot state={dotState(state)} className={css.dot} />
                    <span className={css.rule}>{rule(schedule, t)}</span>
                    <span className={css.copy}>
                      <strong title={schedule.prompt}>{schedule.prompt}</strong>
                      <small>{target(schedule.scheduledAt)} · {t(statusKey(state))}</small>
                      {error?.id === schedule.id ? <em role="alert">{error.message}</em> : null}
                    </span>
                    <span className={css.status}>{t(statusKey(state))}</span>
                    {isConfirming
                      ? (
                        <span className={css.confirm}>
                          <span>{t('delete.confirm')}</span>
                          <button
                            type="button"
                            disabled={isPending}
                            aria-label={t('action.confirmDelete', { prompt: schedule.prompt })}
                            onClick={() => {
                              void run(schedule.id, () => onDelete(schedule.id))
                              setConfirming(null)
                            }}
                          >{t('delete.yes')}</button>
                          <button
                            type="button"
                            aria-label={t('action.cancelDelete', { prompt: schedule.prompt })}
                            onClick={() => { setConfirming(null) }}
                          >{t('delete.no')}</button>
                        </span>
                      )
                      : (
                        <span className={css.actions}>
                          <button
                            type="button"
                            className={css.iconButton}
                            disabled={isPending}
                            aria-label={t(schedule.paused ? 'action.resume' : 'action.pause', { prompt: schedule.prompt })}
                            onClick={() => { void run(schedule.id, () => schedule.paused ? onResume(schedule.id) : onPause(schedule.id)) }}
                          >{schedule.paused ? <IconPlayOutline16 /> : <IconPauseOutline16 />}</button>
                          <button
                            type="button"
                            className={`${css.iconButton} ${css.deleteButton}`}
                            disabled={isPending}
                            aria-label={t('action.delete', { prompt: schedule.prompt })}
                            onClick={() => { setConfirming(schedule.id) }}
                          ><IconTrashOutline16 /></button>
                        </span>
                      )}
                  </li>
                )
              })}
            </ul>
          </section>
        ), document.body)
        : null}
    </div>
  )
}
