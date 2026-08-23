/** Pure Schedule unit for the standard Session projection transport. */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { advanceDispatchedSchedule, decodeScheduleChange, ScheduleLogError } from './domain.ts'
import type {
  ScheduleChange,
  ScheduleId,
  ScheduleProjection,
  ScheduleProjectionItem,
  ScheduleRecord,
} from './types.ts'

/** Plain-JSON fold state persisted by the projection cache. */
export interface ScheduleProjectionState {
  readonly schedules: readonly { readonly record: ScheduleRecord; readonly paused: boolean }[]
  readonly seenIds: readonly ScheduleId[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Plain retained-record state, including identities already consumed by this Session. */
    schedules: ScheduleProjectionState
  }
}

/**
 * Construct a fresh empty projection state.
 * @returns Plain empty state with no retained or seen identities.
 */
export function emptyScheduleProjectionState(): ScheduleProjectionState {
  return Object.freeze({ schedules: Object.freeze([]), seenIds: Object.freeze([]) })
}

/** Replace one retained entry without changing its create-order position. */
function replace(
  state: ScheduleProjectionState,
  index: number,
  record: ScheduleRecord,
  paused: boolean,
): ScheduleProjectionState {
  const schedules = [...state.schedules]
  schedules[index] = Object.freeze({ record, paused })
  return Object.freeze({ schedules: Object.freeze(schedules), seenIds: state.seenIds })
}

/** Apply one decoded change, rejecting transition-invalid durable history. */
function applyChange(state: ScheduleProjectionState, change: ScheduleChange): ScheduleProjectionState {
  if (change.operation === 'create') {
    if (state.seenIds.includes(change.schedule.id)) {
      throw new ScheduleLogError(`schedule id ${JSON.stringify(change.schedule.id)} was reused`)
    }
    return Object.freeze({
      schedules: Object.freeze([
        ...state.schedules,
        Object.freeze({ record: change.schedule, paused: false }),
      ]),
      seenIds: Object.freeze([...state.seenIds, change.schedule.id]),
    })
  }

  const index = state.schedules.findIndex(schedule => schedule.record.id === change.id)
  if (index < 0) {
    throw new ScheduleLogError(`schedule ${change.operation} targets inactive id ${JSON.stringify(change.id)}`)
  }
  const current = state.schedules[index]
  /* v8 ignore next -- findIndex established the indexed entry. */
  if (current === undefined) return state

  switch (change.operation) {
    case 'delete':
      return Object.freeze({
        schedules: Object.freeze(state.schedules.filter((_schedule, candidate) => candidate !== index)),
        seenIds: state.seenIds,
      })
    case 'pause':
      if (current.paused) {
        throw new ScheduleLogError(`schedule pause targets inactive or paused id ${JSON.stringify(change.id)}`)
      }
      return replace(state, index, current.record, true)
    case 'resume':
      if (!current.paused) {
        throw new ScheduleLogError(`schedule resume targets inactive or active id ${JSON.stringify(change.id)}`)
      }
      return replace(state, index, current.record, false)
    case 'dispatch': {
      if (current.paused) {
        throw new ScheduleLogError(`schedule dispatch targets inactive id ${JSON.stringify(change.id)}`)
      }
      const next: ScheduleRecord | undefined = advanceDispatchedSchedule(current.record, change)
      if (next !== undefined) return replace(state, index, next, false)
      return Object.freeze({
        schedules: Object.freeze(state.schedules.filter((_schedule, candidate) => candidate !== index)),
        seenIds: state.seenIds,
      })
    }
  }
}

/**
 * Fold one committed Session event into the Schedule projection.
 * @param state - Plain retained-record state covering prior owned events.
 * @param event - Next committed Session event.
 * @returns Updated state, or the same reference for an unrelated event.
 * @throws {@link ScheduleLogError} when durable Schedule JSON or its transition is invalid.
 */
export function applyScheduleProjection(
  state: ScheduleProjectionState,
  event: SessionEvent,
): ScheduleProjectionState {
  if (event.type !== 'schedule/change') return state
  return applyChange(state, decodeScheduleChange(event.data))
}

const shared = {
  id: z.string().min(1),
  prompt: z.string().min(1),
  scheduledAt: z.string(),
} as const

const recordSchema = z.discriminatedUnion('kind', [
  z.object({ ...shared, kind: z.literal('after'), afterSeconds: z.number().int().positive() }).strict(),
  z.object({ ...shared, kind: z.literal('at') }).strict(),
  z.object({ ...shared, kind: z.literal('every'), everySeconds: z.number().int().positive() }).strict(),
])
const projectionSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ ...shared, kind: z.literal('after'), afterSeconds: z.number().int().positive(), paused: z.boolean() }).strict(),
  z.object({ ...shared, kind: z.literal('at'), paused: z.boolean() }).strict(),
  z.object({ ...shared, kind: z.literal('every'), everySeconds: z.number().int().positive(), paused: z.boolean() }).strict(),
])) as unknown as ZodType<ScheduleProjection>
const projectionStateSchema = z.object({
  schedules: z.array(z.object({ record: recordSchema, paused: z.boolean() }).strict()),
  seenIds: z.array(z.string().min(1)),
}).strict() as unknown as ZodType<ScheduleProjectionState>

/** Schedule's fork-aware Session projection definition. */
export const scheduleProjectionDefinition = {
  key: 'schedules',
  stateSchema: projectionStateSchema,
  init: emptyScheduleProjectionState,
  apply: applyScheduleProjection,
  wire: {
    viewSchema: projectionSchema,
    view: (state: ScheduleProjectionState) => Object.freeze(state.schedules.map(({ record, paused }): ScheduleProjectionItem =>
      Object.freeze({ ...record, paused }))),
  },
  eventScope: 'owned-suffix',
  stateVersion: 1,
} satisfies ProjectionDefinition<'schedules', ScheduleProjectionState>
