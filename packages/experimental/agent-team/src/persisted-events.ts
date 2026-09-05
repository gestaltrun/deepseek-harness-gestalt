/** Private persisted-read decoder for Agent Teams events. */

import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamId, TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from './types.ts'
import { TeamId as toTeamId, TeamMessageId, TeamTaskId } from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonNegativeSafeInteger.min(1)
const sessionIdSchema = z.string().min(1).transform(SessionId)
const teamIdSchema = z.string().min(1).transform(toTeamId)
const numericTaskIdPattern = /^task-(\d+)$/u
const teamTaskIdSchema = z.string().min(1).refine((value) => {
  const match = numericTaskIdPattern.exec(value)
  return match === null || Number.isSafeInteger(Number(match[1]))
}, { message: 'numeric task id suffix must be a safe integer' }).transform(TeamTaskId)
const teamMessageIdSchema = z.string().min(1).transform(TeamMessageId)

const coreContentBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
const imageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: nonNegativeSafeInteger,
  width: positiveSafeInteger,
  height: positiveSafeInteger,
  name: z.string().optional(),
}).strict()

const contentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() => z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
  z.object({
    type: z.literal('tool-call'),
    id: z.string().min(1),
    name: z.string(),
    arguments: z.string(),
  }).strict(),
  z.object({
    type: z.literal('tool-result'),
    toolCallId: z.string().min(1),
    content: z.array(contentBlockSchema),
    isError: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.string().min(1) }).loose().refine(
    block => !coreContentBlockTypes.has(block.type),
    { message: 'known content block types must match their declared fields' },
  ),
])) as z.ZodType<ContentBlock>

/** Zod schema for a durable teammate lifecycle snapshot. */
export const teamMemberSnapshotSchema = z.object({
  id: sessionIdSchema,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(['fresh', 'fork']),
  phase: z.enum(['provisioning', 'active', 'failed']),
  error: z.string().optional(),
}).strict() as z.ZodType<TeamMemberSnapshot>

/** Zod schema for a durable shared-task snapshot. */
export const teamTaskSnapshotSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
}).strict() as z.ZodType<TeamTaskSnapshot>

const messageFields = {
  id: teamMessageIdSchema,
  senderId: sessionIdSchema,
  senderName: z.string(),
  targetId: sessionIdSchema,
  content: z.array(contentBlockSchema),
}
/** Zod schema for a current-version queued mailbox message snapshot. */
export const teamMessageSnapshotSchema = z.object(messageFields).strict() as z.ZodType<TeamMessageSnapshot>
const teamMessageSnapshotV1Schema = z.object({
  ...messageFields,
  delivery: z.enum(['quiet', 'wakeup']),
}).strict()

const memberV1Schema = z.object({ version: z.literal(1), teamId: teamIdSchema, member: teamMemberSnapshotSchema }).strict()
const memberV2Schema = z.object({ version: z.literal(2), teamId: teamIdSchema, member: teamMemberSnapshotSchema }).strict()
const taskV1Schema = z.object({ version: z.literal(1), teamId: teamIdSchema, task: teamTaskSnapshotSchema }).strict()
const taskV2Schema = z.object({ version: z.literal(2), teamId: teamIdSchema, task: teamTaskSnapshotSchema }).strict()
const queuedV1Schema = z.object({ version: z.literal(1), teamId: teamIdSchema, message: teamMessageSnapshotV1Schema }).strict()
const queuedV2Schema = z.object({ version: z.literal(2), teamId: teamIdSchema, message: teamMessageSnapshotSchema }).strict()
const deliveredV1Schema = z.object({
  version: z.literal(1), teamId: teamIdSchema,
  messageId: teamMessageIdSchema, targetId: sessionIdSchema,
}).strict()
const deliveredV2Schema = z.object({
  version: z.literal(2), teamId: teamIdSchema,
  messageId: teamMessageIdSchema, targetId: sessionIdSchema,
}).strict()

/** Durable Agent Teams event names stored in the Team Lead Session. */
export type TeamEventType = 'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered'
/** Session event whose type is one of the Agent Teams durable records. */
export type TeamSessionEvent = SessionEvent<TeamEventType>

/**
 * Narrow a Session event to an Agent Teams durable record.
 * @param event - any reconstructed Session event.
 * @returns whether the event is one of the four Team record types.
 */
export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/member'
    || event.type === 'team/task'
    || event.type === 'team/message/queued'
    || event.type === 'team/message/delivered'
}

function invalid(type: TeamEventType, cause?: unknown): never {
  throw new Error(`persisted Agent Teams ${type} payload is invalid`, cause === undefined ? undefined : { cause })
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !('value' in descriptor)) return undefined
  return descriptor.value
}

function parse<T>(type: TeamEventType, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    return invalid(type, error)
  }
}

function assertNeverEvent(event: never): never {
  throw new Error(`unhandled persisted Agent Teams event type ${String((event as TeamSessionEvent).type)}`)
}

/**
 * Decode a same-Team v1/v2 record to a current v2 event without decoding foreign nested payloads.
 * @param selectedTeamId - Team identity whose records this decoder owns.
 * @param event - persisted Team event from the Lead Session log.
 * @returns the current-version event, or `undefined` when the record belongs to another Team.
 */
export function decodePersistedTeamEvent(selectedTeamId: TeamId, event: TeamSessionEvent): TeamSessionEvent | undefined {
  const rawTeamId = ownDataProperty(event.data, 'teamId')
  if (typeof rawTeamId === 'string' && rawTeamId.length > 0 && rawTeamId !== selectedTeamId) return undefined
  if (rawTeamId !== selectedTeamId) return invalid(event.type)

  const version = ownDataProperty(event.data, 'version')
  if (version !== 1 && version !== 2) {
    if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0) {
      throw new Error(`unsupported Agent Teams event version ${String(version)}`)
    }
    return invalid(event.type)
  }

  switch (event.type) {
    case 'team/member': {
      const data = version === 1
        ? parse(event.type, memberV1Schema, event.data)
        : parse(event.type, memberV2Schema, event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, member: data.member } }
    }
    case 'team/task': {
      const data = version === 1
        ? parse(event.type, taskV1Schema, event.data)
        : parse(event.type, taskV2Schema, event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, task: data.task } }
    }
    case 'team/message/queued': {
      if (version === 1) {
        const data = parse(event.type, queuedV1Schema, event.data)
        const { delivery: _delivery, ...message } = data.message
        return { ...event, data: { version: 2, teamId: data.teamId, message } }
      }
      const data = parse(event.type, queuedV2Schema, event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, message: data.message } }
    }
    case 'team/message/delivered': {
      const data = version === 1
        ? parse(event.type, deliveredV1Schema, event.data)
        : parse(event.type, deliveredV2Schema, event.data)
      return { ...event, data: { version: 2, teamId: data.teamId, messageId: data.messageId, targetId: data.targetId } }
    }
    /* v8 ignore next -- closed Team event union is exhaustive. */
    default:
      return assertNeverEvent(event)
  }
}
