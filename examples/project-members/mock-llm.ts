import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')
const ROSTER_CALL_ID = CallId('project-members-demo-call')
const QUESTION_CALL_ID = CallId('project-member-question-demo-call')

/**
 * Keyless scripted adapter for the project-members demo: the first request
 * calls `project_members` without `projectId` (exercising the workspace
 * binding face). The follow-up request matches a public GitHub login from
 * that live roster, then routes `ask_user_question` with that login.
 */
class ProjectMembersMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResults = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    if (toolResults.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ROSTER_CALL_ID, name: 'project_members', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ROSTER_CALL_ID, name: 'project_members', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    if (toolResults.length === 1) {
      const rosterText = toolResults[0].content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      const login = publicLogin(rosterText, 'GRACE')
      const argumentsJson = JSON.stringify({
        questions: [{ id: 'rollout', question: 'Approve the guarded rollout?', options: [{ label: 'approve' }] }],
        to_project_member: login,
        background: 'Review the project roster before deciding whether to proceed.',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta', index: 0, id: QUESTION_CALL_ID,
        name: 'ask_user_question', argumentsDelta: argumentsJson,
      }
      yield {
        type: 'block-end', index: 0,
        block: { type: 'tool-call', id: QUESTION_CALL_ID, name: 'ask_user_question', arguments: argumentsJson },
      }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const [rosterResult, answerResult] = toolResults
    const roster = rosterResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const answer = answerResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `PROJECT_MEMBERS_ROSTER ${roster} PROJECT_MEMBER_ANSWER ${answer}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'project-members-mock-llm'
export const inject = ['llm']

/** Register the keyless `project-members-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['project-members-mock'], new ProjectMembersMockAdapter())
}

function publicLogin(content: string, displayName: string): string {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('project-members demo roster was not JSON')
  }
  if (!Array.isArray(value)) throw new Error('project-members demo roster was not an array')
  const normalized = displayName.toLowerCase()
  for (const member of value) {
    if (typeof member !== 'object' || member === null || Array.isArray(member)) continue
    const record = member as Record<string, unknown>
    if (typeof record.displayName === 'string' && record.displayName.toLowerCase() === normalized) {
      return record.displayName
    }
  }
  throw new Error(`project-members demo roster did not contain ${displayName}`)
}
