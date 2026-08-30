/** Host-authoritative member-question receiver RPCs. */
import type {
  MemberQuestionReceiverSnapshot,
  ReceivingSessionId,
} from '@deepseek-ai/dsh-member-question-receiver'
import type {
  CompanionMemberQuestionAnswer,
  CompanionMemberQuestionSettledResult,
  MemberQuestionId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { PromptContentPart } from './sessions.ts'

export type {
  MemberQuestionReceiverSnapshot,
  PendingMemberQuestionView,
  TerminalMemberQuestionView,
} from '@deepseek-ai/dsh-member-question-receiver'

/** Unary receiver baseline and settlement operations. */
export interface MemberQuestionsApi {
  /** Read the complete committed receiver projection. */
  snapshot(request: RpcRequest<{}>): Promise<RpcResponse<MemberQuestionReceiverSnapshot>>
  /** Settle one pending question from this authenticated Host Installation. */
  settle(request: RpcRequest<{
    receivingSessionId: ReceivingSessionId
    revision: number
    questionId: MemberQuestionId
    response:
      | { kind: 'answered'; answers: readonly CompanionMemberQuestionAnswer[] }
      | { kind: 'declined' }
  }>): Promise<RpcResponse<CompanionMemberQuestionSettledResult>>
  /** Materialize the Host receiving Session and admit one explicit human turn. */
  admitHumanTurn(request: RpcRequest<{
    receivingSessionId: ReceivingSessionId
    revision: number
    content: readonly PromptContentPart[]
    mode: 'queue' | 'steer'
  }>): Promise<RpcResponse<{ accepted: true; sessionId: ReceivingSessionId }>>
}
