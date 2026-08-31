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
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { ProjectId } from '@deepseek-ai/dsh-project-membership'
import type { WorkspaceId } from './workspace.ts'

export type {
  MemberQuestionReceiverSnapshot,
  PendingMemberQuestionView,
  TerminalMemberQuestionView,
} from '@deepseek-ai/dsh-member-question-receiver'

/** Unary receiver baseline and settlement operations. */
export interface MemberQuestionsApi {
  /** Read the exact local Workspace already selected for an Account and Project. */
  workspaceBinding(request: RpcRequest<{
    receivingAccountId: PlatformAccountId
    projectId: ProjectId
  }>): Promise<RpcResponse<
    | { state: 'missing' }
    | { state: 'live' | 'stale'; workspaceId: WorkspaceId }
  >>
  /** Keep a live exact binding, or atomically establish one when missing or stale. */
  ensureWorkspaceBinding(request: RpcRequest<{
    receivingAccountId: PlatformAccountId
    projectId: ProjectId
    workspaceId: WorkspaceId
  }>): Promise<RpcResponse<{
    state: 'created' | 'existing' | 'repaired'
    workspaceId: WorkspaceId
  }>>
  /** Persist the exact local Workspace selected while accepting a Project invitation. */
  bindWorkspace(request: RpcRequest<{
    receivingAccountId: PlatformAccountId
    projectId: ProjectId
    workspaceId: WorkspaceId
  }>): Promise<RpcResponse<{ bound: true }>>
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
