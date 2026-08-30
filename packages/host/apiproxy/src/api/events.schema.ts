/**
 * events domain zod schemas: MuxFrame / HostFrame unions (discriminatedUnion('type')).
 * A frame is the payload slot of the ServerRequest full form; the SessionEvent inside
 * a session/event frame reuses sessions.schema's strict-envelope + wide-data passthrough branch.
 */

import { z } from 'zod'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { HostFrame, MuxFrame } from './events.ts'
import type { Wire } from './rpc.schema.ts'
import { rpcErrorSchema, rpcIdSchema } from './rpc.schema.ts'
import { approvalRequestIdSchema } from './approvals.schema.ts'
import {
  contentBlockSchema, messageIdSchema, sessionEventSchema, sessionIdSchema, toolEventViewSchema,
} from './sessions.schema.ts'
import { taskViewSchema } from './jobs.schema.ts'
import { workspaceIdSchema, workspaceViewSchema } from './workspace.schema.ts'
import { memberQuestionSnapshotValueSchema } from './member-questions.schema.ts'

/** Question fields validated strictly against core dsh-user-questions. */
export const askUserQuestionItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  // Presentation intent: a tagged union on the wire, so an unknown tag is a
  // rejected frame rather than a silently generic render. The member-question
  // variant carries its whole Decision Brief (origin identity, background,
  // material references, expiry instant) with the same bounds the Companion
  // codec (T4) and the sender payload (T5) already enforce upstream — every
  // field is required here, so an incomplete brief fails loud at the frame.
  intent: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('plan-review'), approve: z.string() }),
    z.object({
      kind: z.literal('member-question'),
      questionId: z.string().min(1),
      originSessionId: z.string().min(1),
      toProjectMember: z.string().min(1),
      origin: z.object({
        projectName: z.string().min(1),
        originSessionTitle: z.string().min(1),
        askerAccountId: z.string().min(1),
        askerRole: z.union([z.literal('owner'), z.literal('admin'), z.literal('member')]),
        askerDisplayName: z.string().min(1),
        askerAvatarUrl: z.string().min(1),
      }),
      background: z.string(),
      references: z.array(z.object({
        path: z.string().min(1),
        reason: z.string(),
        // Inline document body for the renderable kinds (.md/.html); absent
        // renders the receiver's bare file tab.
        content: z.string().optional(),
      })),
      // oxlint-disable-next-line typescript/no-deprecated -- Zod's default v3-compatible export accepts infinite numbers.
      expiresAt: z.number().finite(),
    }),
  ]).optional(),
}) satisfies z.ZodType<Wire<AskUserQuestionItem>>

/** Unified message envelope carried by transient queue frames. */
const messageSchema = z.object({
  id: z.string().min(1),
  role: z.union([z.literal('system'), z.literal('user'), z.literal('assistant')]),
  content: z.array(contentBlockSchema),
  source: z.looseObject({ kind: z.string() }),
})

/** MuxFrame union (payload slot of a mux-stream ServerRequest). */
export const muxFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session/event'), sessionId: sessionIdSchema, event: sessionEventSchema, view: toolEventViewSchema.optional() }),
  z.object({ type: z.literal('session/subscribed'), sessionId: sessionIdSchema, lastSeq: z.number().int() }),
  z.object({ type: z.literal('approval/requested'), sessionId: sessionIdSchema, approvalId: approvalRequestIdSchema, toolName: z.string(), callId: z.string().optional(), reason: z.string().optional() }),
  z.object({ type: z.literal('approval/resolved'), sessionId: sessionIdSchema, approvalId: approvalRequestIdSchema, outcome: z.union([z.literal('allowed-once'), z.literal('rejected'), z.literal('cancelled'), z.literal('unavailable')]) }),
  // Non-empty by wire contract: the user-questions service rejects empty
  // batches at ask() (EMPTY_QUESTIONS), so an empty frame is host breakage
  // and must fail loud here, not reach the composer.
  z.object({ type: z.literal('question/requested'), sessionId: sessionIdSchema, questions: z.array(askUserQuestionItemSchema).min(1) }),
  z.object({ type: z.literal('question/resolved'), sessionId: sessionIdSchema, questionRpcId: rpcIdSchema, outcome: z.union([z.literal('answered'), z.literal('cancelled')]) }),
  z.object({
    type: z.literal('session/queue'),
    sessionId: sessionIdSchema,
    items: z.array(z.object({
      id: messageIdSchema,
      placement: z.union([z.literal('queued'), z.literal('steering'), z.literal('context')]),
      message: messageSchema,
    })),
  }),
  z.object({ type: z.literal('session/jobs'), sessionId: sessionIdSchema, jobs: z.array(taskViewSchema) }),
  // value stays wide: it already passed its unit's own schema on the host,
  // and deep-validating here would import every domain's schema into the carrier.
  z.object({ type: z.literal('session/projection'), sessionId: sessionIdSchema, key: z.string().min(1), value: z.unknown(), seq: z.number().int().nonnegative() }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<MuxFrame>

/** HostFrame union (payload slot of a host-stream ServerRequest). */
export const hostFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('host/member-question-snapshot'),
    snapshot: memberQuestionSnapshotValueSchema,
    currentInstallationId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('host/session-added'),
    sessionId: sessionIdSchema,
    blank: z.boolean(),
    parentSessionId: sessionIdSchema.optional(),
    origin: z.literal('subagent').optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
  }),
  z.object({ type: z.literal('host/session-removed'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('host/session-status'), sessionId: sessionIdSchema, running: z.boolean() }),
  z.object({ type: z.literal('host/agent-error'), sessionId: sessionIdSchema, message: z.string() }),
  z.object({ type: z.literal('host/workspace-changed'), workspace: workspaceViewSchema }),
  z.object({ type: z.literal('host/workspace-removed'), workspaceId: workspaceIdSchema }),
  z.object({ type: z.literal('host/workspace-order-changed'), workspaceIds: z.array(workspaceIdSchema) }),
  z.object({ type: z.literal('host/archived-sessions-changed'), archivedSessionIds: z.array(sessionIdSchema) }),
  // args stays wide, the same posture as session/projection's value: the frame
  // arrives from JSON.parse, so every element is already a JSON value, and the
  // structural contract belongs to the owner package's cordis `Events`
  // declaration — the host validated JSON-safety before forwarding.
  z.object({ type: z.literal('host/remote-event'), event: z.string().min(1), args: z.array(z.unknown()) }),
  z.object({ type: z.literal('stream/error'), error: rpcErrorSchema }),
]) as unknown as z.ZodType<HostFrame>
