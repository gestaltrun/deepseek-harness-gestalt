/** Exact wire schemas for Host-authoritative member-question receiver RPCs. */
import { z } from 'zod'
import type { MemberQuestionReceiverSnapshot, ReceivingSessionId } from '@deepseek-ai/dsh-member-question-receiver'
import type { CompanionMemberQuestionSettledResult } from '@deepseek-ai/dsh-remote-protocol'
import type { Wire } from './rpc.schema.ts'
import type { MemberQuestionsApi } from './member-questions.ts'

const idSchema = z.string().min(1)
const safeEpochSchema = z.number().int().nonnegative()
const memberQuestionOptionSchema = z.strictObject({
  label: z.string(),
  description: z.string().optional(),
})
const memberQuestionItemSchema = z.strictObject({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(memberQuestionOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
})
const memberQuestionOperationSchema = z.strictObject({
  type: z.literal('member-question'),
  operationId: idSchema,
  questionId: idSchema,
  projectId: idSchema,
  originSessionId: idSchema,
  expiresAt: safeEpochSchema,
  origin: z.strictObject({
    projectName: z.string(),
    originSessionTitle: z.string(),
    askerAccountId: idSchema,
    askerRole: z.union([z.literal('owner'), z.literal('admin'), z.literal('member')]),
    askerDisplayName: z.string(),
    askerAvatarUrl: z.string(),
  }),
  background: z.string(),
  questions: z.array(memberQuestionItemSchema).min(1),
  references: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
})
const answerSchema = z.strictObject({
  id: z.string(),
  selected: z.array(z.string()),
  custom: z.string().optional(),
})
const terminalSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    type: z.literal('member-question-settled'), operationId: idSchema, questionId: idSchema,
    outcome: z.literal('answered'), settledAt: safeEpochSchema,
    settledByInstallationId: idSchema, settledByDeviceName: z.string(), answers: z.array(answerSchema),
  }),
  z.strictObject({
    type: z.literal('member-question-settled'), operationId: idSchema, questionId: idSchema,
    outcome: z.literal('declined'), settledAt: safeEpochSchema,
    settledByInstallationId: idSchema, settledByDeviceName: z.string(),
  }),
  z.strictObject({
    type: z.literal('member-question-settled'), operationId: idSchema, questionId: idSchema,
    outcome: z.union([z.literal('expired'), z.literal('withdrawn'), z.literal('superseded')]),
    settledAt: safeEpochSchema,
  }),
]) as unknown as z.ZodType<Wire<CompanionMemberQuestionSettledResult>>
const pendingSchema = z.strictObject({
  questionId: idSchema,
  receivingSessionId: idSchema,
  receivingAccountId: idSchema,
  revision: z.number().int().nonnegative(),
  arrivedAt: safeEpochSchema,
  operation: memberQuestionOperationSchema,
  hostSessionId: idSchema.optional(),
  reservedAdmission: z.strictObject({
    rpcId: idSchema,
    mode: z.union([z.literal('queue'), z.literal('steer')]),
  }).optional(),
})
const terminalViewSchema = z.strictObject({
  questionId: idSchema,
  receivingSessionId: idSchema,
  receivingAccountId: idSchema,
  revision: z.number().int().nonnegative(),
  arrivedAt: safeEpochSchema,
  terminal: terminalSchema,
  brief: memberQuestionOperationSchema,
  hostSessionId: idSchema.optional(),
})

/** Exact empty request for the complete receiver baseline. */
export const memberQuestionSnapshotRequestSchema = z.strictObject({})
/** Exact complete receiver snapshot on unary responses and Host frames. */
export const memberQuestionSnapshotValueSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  pending: z.array(pendingSchema),
  terminal: z.array(terminalViewSchema),
}) as unknown as z.ZodType<Wire<MemberQuestionReceiverSnapshot>>
/** Exact answer-or-decline settlement request. */
export const memberQuestionSettleRequestSchema = z.strictObject({
  receivingSessionId: idSchema,
  revision: z.number().int().nonnegative(),
  questionId: idSchema,
  response: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('answered'), answers: z.array(answerSchema) }),
    z.strictObject({ kind: z.literal('declined') }),
  ]),
}) as unknown as z.ZodType<Wire<Parameters<MemberQuestionsApi['settle']>[0]['payload']>>
/** Canonical terminal returned by Host settlement. */
export const memberQuestionSettleValueSchema = terminalSchema
/** Exact explicit-human-turn admission request. */
export const memberQuestionAdmitHumanTurnRequestSchema = z.strictObject({
  receivingSessionId: idSchema,
  revision: z.number().int().nonnegative(),
  content: z.array(z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string() }),
    z.strictObject({
      type: z.literal('image'), mediaType: z.string(), data: z.string(), name: z.string().optional(),
    }),
  ])).min(1),
  mode: z.union([z.literal('queue'), z.literal('steer')]),
}) as unknown as z.ZodType<Wire<Parameters<MemberQuestionsApi['admitHumanTurn']>[0]['payload']>>
/** Materialized Host Session identity. */
export const memberQuestionAdmitHumanTurnValueSchema = z.strictObject({
  accepted: z.literal(true),
  sessionId: idSchema,
}) as unknown as z.ZodType<Wire<{ accepted: true; sessionId: ReceivingSessionId }>>
