/** Strict replay fold for Agent Teams log-only events. */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  TeamId,
  TeamMemberSnapshot,
  TeamMessageId,
  TeamMessageSnapshot,
  TeamTaskId,
  TeamTaskSnapshot,
} from './types.ts'
import { TeamId as toTeamId } from './types.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'
import { decodePersistedTeamEvent, isTeamEvent } from './persisted-events.ts'
import type { TeamSessionEvent } from './persisted-events.ts'
export { isTeamEvent } from './persisted-events.ts'

const numericTaskIdPattern = /^task-(\d+)$/u

function assertNeverEvent(event: never): never {
  throw new Error(`unhandled Agent Teams event type ${String((event as TeamSessionEvent).type)}`)
}

/** Mutable internal replay state. */
export interface TeamFoldState {
  readonly id: TeamId
  readonly members: Map<SessionId, TeamMemberSnapshot>
  readonly memberIdsByName: Map<string, SessionId>
  readonly tasks: Map<TeamTaskId, TeamTaskSnapshot>
  readonly messages: Map<TeamMessageId, TeamMessageSnapshot>
  readonly delivered: Set<TeamMessageId>
  nextTaskNumber: number
}

/**
 * Construct an empty Team fold for one root Session.
 * @param rootId - Session whose TeamId selects applicable records.
 * @returns mutable empty replay state.
 */
export function emptyTeamFoldState(rootId: SessionId): TeamFoldState {
  return {
    id: toTeamId(rootId),
    members: new Map(),
    memberIdsByName: new Map(),
    tasks: new Map(),
    messages: new Map(),
    delivered: new Set(),
    nextTaskNumber: 1,
  }
}

/**
 * Apply one event, ignoring Team records inherited by a different root fork.
 * @param state - mutable Team replay state.
 * @param event - next contiguous Session event.
 */
export function applyTeamEvent(state: TeamFoldState, event: SessionEvent): void {
  if (!isTeamEvent(event)) return
  const decoded = decodePersistedTeamEvent(state.id, event)
  if (decoded === undefined) return

  switch (decoded.type) {
    case 'team/member': {
      const member = decoded.data.member
      const prior = state.members.get(member.id)
      const named = state.memberIdsByName.get(member.name)
      if (named !== undefined && named !== member.id) {
        throw new Error(`teammate name "${member.name}" is reused by another member`)
      }
      if (prior === undefined) {
        if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
        state.memberIdsByName.set(member.name, member.id)
      } else {
        if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        if (prior.phase !== 'provisioning' || member.phase === 'provisioning') {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      state.members.set(member.id, member)
      break
    }
    case 'team/task': {
      const task = decoded.data.task
      const prior = state.tasks.get(task.id)
      if (prior === undefined && task.revision !== 1) {
        throw new Error(`team task "${task.id}" must begin at revision 1`)
      }
      if (prior !== undefined && task.revision !== prior.revision + 1) {
        throw new Error(`team task "${task.id}" revision is not contiguous`)
      }
      assertTaskGraphCandidate([...state.tasks.values()], task)
      const match = numericTaskIdPattern.exec(task.id)
      if (match !== null) {
        const number = Number(match[1])
        state.nextTaskNumber = Math.max(
          state.nextTaskNumber,
          number === Number.MAX_SAFE_INTEGER ? number : number + 1,
        )
      }
      state.tasks.set(task.id, task)
      break
    }
    case 'team/message/queued': {
      const message = decoded.data.message
      if (state.messages.has(message.id)) throw new Error(`team message "${message.id}" was queued twice`)
      state.messages.set(message.id, message)
      break
    }
    case 'team/message/delivered': {
      const queued = state.messages.get(decoded.data.messageId)
      if (queued === undefined) throw new Error(`team message "${decoded.data.messageId}" was delivered before queueing`)
      if (queued.targetId !== decoded.data.targetId) throw new Error(`team message "${decoded.data.messageId}" target changed`)
      if (state.delivered.has(decoded.data.messageId)) throw new Error(`team message "${decoded.data.messageId}" was delivered twice`)
      state.delivered.add(decoded.data.messageId)
      break
    }
    /* v8 ignore next -- closed Team event union is exhaustive. */
    default:
      return assertNeverEvent(decoded)
  }
}

/**
 * Replay one root Session into its current Team state.
 * @param rootId - root Session identity selecting Team-owned records.
 * @param events - complete contiguous Session log.
 * @returns mutable replay state at the end of the log.
 */
export function foldTeam(rootId: SessionId, events: readonly SessionEvent[]): TeamFoldState {
  const state = emptyTeamFoldState(rootId)
  for (const event of events) applyTeamEvent(state, event)
  return state
}
