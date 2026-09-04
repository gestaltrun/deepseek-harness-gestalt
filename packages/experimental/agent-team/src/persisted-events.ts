/** Private persisted-read decoder for Agent Teams events. */

import { z } from 'zod'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import type { TeamId, TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from './types.ts'
import { TeamId as toTeamId, TeamMessageId, TeamTaskId } from './types.ts'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const sessionId = z.string().min(1).transform(toSessionId)
const teamId = z.string().min(1).transform(toTeamId)
const numericTaskIdPattern = /^task-(\d+)$/u
const taskId = z.string().min(1).refine((value) => {
  const match = numericTaskIdPattern.exec(value)
  return match === null || Number.isSafeInteger(Number(match[1]))
}, { message: 'numeric task id suffix must be a safe integer' }).transform(TeamTaskId)
const messageId = z.string().min(1).transform(TeamMessageId)
const member = z.object({ id: sessionId, name: z.string(), description: z.string(), provider: z.string(), context: z.enum(['fresh', 'fork']), phase: z.enum(['provisioning', 'active', 'failed']), error: z.string().optional() }).strict() as z.ZodType<TeamMemberSnapshot>
const task = z.object({ id: taskId, revision: integer.min(1), subject: z.string(), description: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'deleted']), ownerId: sessionId.optional(), blockedBy: z.array(taskId), writeScopes: z.array(z.string()) }).strict() as z.ZodType<TeamTaskSnapshot>
const coreBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
const contentBlock: z.ZodType<unknown> = z.lazy(() => z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), attachment: z.object({ attachmentId: z.string().min(1), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: integer, width: integer.min(1), height: integer.min(1), name: z.string().optional() }).strict() }).strict(),
  z.object({ type: z.literal('tool-call'), id: z.string().min(1), name: z.string(), arguments: z.string() }).strict(),
  z.object({ type: z.literal('tool-result'), toolCallId: z.string().min(1), content: z.array(contentBlock), isError: z.boolean().optional() }).strict(),
  z.object({ type: z.string().min(1) }).loose().refine(block => !coreBlockTypes.has(block.type)),
]))
const messageFields = { id: messageId, senderId: sessionId, senderName: z.string(), targetId: sessionId, content: z.array(contentBlock) }
const message = z.object(messageFields).strict() as unknown as z.ZodType<TeamMessageSnapshot>
const messageV1 = z.object({ ...messageFields, delivery: z.enum(['quiet', 'wakeup']) }).strict()
const selector = z.object({ version: integer, teamId }).loose()

export type TeamEventType = 'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered'
export type TeamSessionEvent = SessionEvent<TeamEventType>

export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/member' || event.type === 'team/task' || event.type === 'team/message/queued' || event.type === 'team/message/delivered'
}

function parse<T>(type: TeamEventType, schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(value) } catch (error: unknown) { throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error }) }
}

/** Decode one same-Team v1/v2 event to the current v2 payload; foreign events skip nested decoding. */
export function decodePersistedTeamEvent(selectedTeamId: TeamId, event: TeamSessionEvent): TeamSessionEvent | undefined {
  const selected = parse(event.type, selector, event.data)
  if (selected.teamId !== selectedTeamId) return undefined
  if (selected.version !== 1 && selected.version !== 2) throw new Error(`unsupported Agent Teams event version ${String(selected.version)}`)
  const base = { version: z.literal(selected.version), teamId }
  switch (event.type) {
    case 'team/member': {
      const data = parse(event.type, z.object({ ...base, member }).strict(), event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, member: data.member } }
    }
    case 'team/task': {
      const data = parse(event.type, z.object({ ...base, task }).strict(), event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, task: data.task } }
    }
    case 'team/message/queued': {
      if (selected.version === 1) {
        const data = parse(event.type, z.object({ ...base, message: messageV1 }).strict(), event.data)
        const { delivery: _delivery, ...current } = data.message
        return { ...event, data: { version: 2, teamId: data.teamId, message: current as unknown as TeamMessageSnapshot } }
      }
      const data = parse(event.type, z.object({ ...base, message }).strict(), event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, message: data.message } }
    }
    case 'team/message/delivered': {
      const data = parse(event.type, z.object({ ...base, messageId, targetId: sessionId }).strict(), event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, messageId: data.messageId, targetId: data.targetId } }
    }
  }
}

const _publicWritesRemainV2: SessionEventMap[TeamEventType]['version'] = 2
void _publicWritesRemainV2
