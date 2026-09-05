import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTeam } from '../src/fold.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamFoldState } from '../src/fold.ts'
import type { TeamProjectionState } from '../src/projection.ts'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/types.ts'

const ROOT = SessionId('portable-root')
const CHILD = SessionId('portable-child')
const TEAM = TeamId(ROOT)
type Variant = 'pure-v1' | 'pure-v2' | 'mixed'
type TeamEventName = 'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered'

function raw(type: TeamEventName, data: unknown, seq: number): SessionEvent {
  return { type, data, seq: SessionSeq(seq), time: seq } as unknown as SessionEvent
}

function versionFor(variant: Variant, index: number): 1 | 2 {
  if (variant === 'pure-v1') return 1
  if (variant === 'pure-v2') return 2
  return index % 2 === 0 ? 1 : 2
}

function portableLog(variant: Variant): SessionEvent[] {
  const versions = Array.from({ length: 7 }, (_, index) => versionFor(variant, index))
  const member = (phase: 'provisioning' | 'active') => ({
    id: CHILD, name: 'portable', description: 'portable worker', provider: 'spawn', context: 'fresh', phase,
  })
  const task = (revision: number, status: 'pending' | 'in_progress') => ({
    id: TeamTaskId('task-7'), revision, subject: 'portable task', description: 'same durable task',
    status, ownerId: CHILD, blockedBy: [], writeScopes: ['packages/experimental/agent-team'],
  })
  const message = {
    id: TeamMessageId('portable-message'), senderId: ROOT, senderName: 'lead', targetId: CHILD,
    content: [{ type: 'text', text: 'portable hello' }],
  }
  const queued = (version: 1 | 2, value: typeof message) => version === 1
    ? { version, teamId: TEAM, message: { ...value, delivery: 'quiet' } }
    : { version, teamId: TEAM, message: value }
  const pendingMessage = { ...message, id: TeamMessageId('portable-pending') }
  return [
    raw('team/member', { version: versions[0], teamId: TEAM, member: member('provisioning') }, 0),
    raw('team/member', { version: versions[1], teamId: TEAM, member: member('active') }, 1),
    raw('team/task', { version: versions[2], teamId: TEAM, task: task(1, 'pending') }, 2),
    raw('team/task', { version: versions[3], teamId: TEAM, task: task(2, 'in_progress') }, 3),
    raw('team/message/queued', queued(versions[4]!, message), 4),
    raw('team/message/delivered', { version: versions[5], teamId: TEAM, messageId: message.id, targetId: CHILD }, 5),
    raw('team/message/queued', queued(versions[6]!, pendingMessage), 6),
  ]
}

function normalizedFold(state: TeamFoldState) {
  return {
    id: state.id,
    members: [...state.members.values()],
    tasks: [...state.tasks.values()],
    messages: [...state.messages.values()],
    delivered: [...state.delivered],
    pending: [...state.messages.values()].filter(message => !state.delivered.has(message.id)),
    nextTaskNumber: state.nextTaskNumber,
  }
}

function normalizedProjection(state: TeamProjectionState) {
  if (state.failure !== undefined) throw new Error(state.failure)
  return {
    id: state.id,
    members: state.members,
    tasks: state.tasks,
    messages: state.messages,
    delivered: state.delivered,
    pending: state.messages.filter(message => !state.delivered.includes(message.id)),
    nextTaskNumber: state.nextTaskNumber,
  }
}

function project(events: readonly SessionEvent[]): TeamProjectionState {
  let state = teamProjectionDefinition.init({ version: 0, id: ROOT, createdAt: 0, isSeeded: false })
  for (const event of events) state = teamProjectionDefinition.apply(state, event)
  return state
}

describe('Agent Teams persisted event portability', () => {
  it('folds and projects pure-v1, pure-v2, and mixed logs to one complete current state', () => {
    const variants: Variant[] = ['pure-v1', 'pure-v2', 'mixed']
    const states = variants.map((variant) => {
      const events = portableLog(variant)
      const folded = normalizedFold(foldTeam(ROOT, events))
      const projected = normalizedProjection(project(events))
      expect(folded).toEqual(projected)
      expect(folded.messages.every(message => !('delivery' in message))).toBe(true)
      return folded
    })
    expect(states[1]).toEqual(states[0])
    expect(states[2]).toEqual(states[0])
    expect(states[0]).toMatchObject({
      nextTaskNumber: 8,
      delivered: [TeamMessageId('portable-message')],
      pending: [{ id: TeamMessageId('portable-pending') }],
    })
  })
})
