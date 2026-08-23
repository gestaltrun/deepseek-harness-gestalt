import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyScheduleProjection,
  emptyScheduleProjectionState,
  scheduleProjectionDefinition,
} from '../src/projection.ts'
import { ScheduleLogError } from '../src/domain.ts'

function change(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq, time: seq, data } as SessionEvent
}

const create = {
  version: 1,
  operation: 'create',
  schedule: {
    id: 'schedule-1',
    kind: 'after',
    prompt: 'check logs',
    afterSeconds: 30,
    scheduledAt: '2026-08-18T01:00:00.000Z',
  },
} as const

describe('Schedule session projection', () => {
  it('projects durable pause, resume, and delete changes as whole retained records', () => {
    const created = applyScheduleProjection(emptyScheduleProjectionState(), change(create, 0))
    const paused = applyScheduleProjection(created, change({ version: 1, operation: 'pause', id: 'schedule-1' }, 1))
    expect(scheduleProjectionDefinition.wire.view(paused)).toEqual([{
      ...create.schedule,
      paused: true,
    }])

    const resumed = applyScheduleProjection(paused, change({ version: 1, operation: 'resume', id: 'schedule-1' }, 2))
    expect(scheduleProjectionDefinition.wire.view(resumed)).toEqual([{
      ...create.schedule,
      paused: false,
    }])
    const deleted = applyScheduleProjection(resumed, change({ version: 1, operation: 'delete', id: 'schedule-1' }, 3))
    expect(scheduleProjectionDefinition.wire.view(deleted)).toEqual([])
  })

  it('ignores unrelated events but rejects malformed or transition-invalid durable changes', () => {
    const empty = emptyScheduleProjectionState()
    expect(applyScheduleProjection(empty, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }))
      .toBe(empty)
    expect(() => applyScheduleProjection(empty, change({ version: 1, operation: 'pause', id: 'missing' }, 1)))
      .toThrow(ScheduleLogError)
    expect(() => applyScheduleProjection(empty, change({ version: 1, operation: 'pause', id: '' }, 2)))
      .toThrow(ScheduleLogError)
    const created = applyScheduleProjection(empty, change(create, 0))
    expect(() => applyScheduleProjection(created, change(create, 1))).toThrow(/was reused/)
    expect(() => applyScheduleProjection(created, change({ version: 1, operation: 'pause', id: 'schedule-1' }, 2)))
      .not.toThrow()
    const paused = applyScheduleProjection(created, change({ version: 1, operation: 'pause', id: 'schedule-1' }, 3))
    expect(() => applyScheduleProjection(paused, change({ version: 1, operation: 'pause', id: 'schedule-1' }, 4)))
      .toThrow(/paused/)
    expect(() => applyScheduleProjection(created, change({ version: 1, operation: 'resume', id: 'schedule-1' }, 5)))
      .toThrow(/active/)
    expect(() => applyScheduleProjection(paused, change({ version: 1, operation: 'dispatch', id: 'schedule-1' }, 6)))
      .toThrow(/inactive/)
  })

  it('advances a fixed-rate dispatch and drops a one-shot after it fires', () => {
    const every = {
      version: 1,
      operation: 'create',
      schedule: {
        id: 'schedule-every',
        kind: 'every',
        prompt: 'check metrics',
        everySeconds: 300,
        scheduledAt: '2026-08-18T01:00:00.000Z',
      },
    } as const
    const created = applyScheduleProjection(emptyScheduleProjectionState(), change(every, 0))
    const advanced = applyScheduleProjection(created, change({
      version: 1,
      operation: 'dispatch',
      id: 'schedule-every',
      acceptedAt: '2026-08-18T01:00:00.000Z',
    }, 1))
    expect(scheduleProjectionDefinition.wire.view(advanced)).toEqual([{
      ...every.schedule,
      scheduledAt: '2026-08-18T01:05:00.000Z',
      paused: false,
    }])

    const oneShot = applyScheduleProjection(emptyScheduleProjectionState(), change(create, 0))
    const dispatched = applyScheduleProjection(oneShot, change({ version: 1, operation: 'dispatch', id: 'schedule-1' }, 1))
    expect(scheduleProjectionDefinition.wire.view(dispatched)).toEqual([])
  })

  it('declares fork-owned event scope for standard Session projection transport', () => {
    expect(scheduleProjectionDefinition).toMatchObject({
      key: 'schedules',
      eventScope: 'owned-suffix',
    })
    expect(scheduleProjectionDefinition.init()).toEqual(emptyScheduleProjectionState())
  })

  it('rejects reused ids and illegal pause, resume, and dispatch transitions', () => {
    const created = applyScheduleProjection(emptyScheduleProjectionState(), change(create, 0))
    expect(() => applyScheduleProjection(created, change(create, 1))).toThrow(/was reused/)

    const paused = applyScheduleProjection(created, change({ version: 1, operation: 'pause', id: 'schedule-1' }, 1))
    expect(() => applyScheduleProjection(paused, change({ version: 1, operation: 'pause', id: 'schedule-1' }, 2)))
      .toThrow(/pause targets/)
    expect(() => applyScheduleProjection(created, change({ version: 1, operation: 'resume', id: 'schedule-1' }, 2)))
      .toThrow(/resume targets/)
    expect(() => applyScheduleProjection(paused, change({ version: 1, operation: 'dispatch', id: 'schedule-1' }, 2)))
      .toThrow(/dispatch targets/)
  })

  it('advances an Every record and removes a terminal one-shot on dispatch', () => {
    const every = {
      version: 1,
      operation: 'create',
      schedule: {
        id: 'schedule-every',
        kind: 'every',
        prompt: 'check metrics',
        everySeconds: 300,
        scheduledAt: '2026-08-18T01:00:00.000Z',
      },
    } as const
    const advanced = applyScheduleProjection(
      applyScheduleProjection(emptyScheduleProjectionState(), change(every, 0)),
      change({
        version: 1,
        operation: 'dispatch',
        id: 'schedule-every',
        acceptedAt: '2026-08-18T01:07:00.000Z',
      }, 1),
    )
    expect(scheduleProjectionDefinition.wire.view(advanced)).toEqual([{
      ...every.schedule,
      scheduledAt: '2026-08-18T01:10:00.000Z',
      paused: false,
    }])

    const terminal = applyScheduleProjection(
      applyScheduleProjection(emptyScheduleProjectionState(), change(create, 0)),
      change({ version: 1, operation: 'dispatch', id: 'schedule-1' }, 1),
    )
    expect(scheduleProjectionDefinition.wire.view(terminal)).toEqual([])
  })
})
