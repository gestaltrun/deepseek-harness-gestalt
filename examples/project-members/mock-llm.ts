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
const CALL_ID = CallId('project-members-demo-call')

/**
 * Keyless scripted adapter for the project-members demo: the first request
 * calls `project_members` without `projectId` (exercising the workspace
 * binding face), and the follow-up request folds the roster text into a
 * final answer so the transcript pins the model-visible result verbatim.
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
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CALL_ID, name: 'project_members', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CALL_ID, name: 'project_members', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const roster = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `PROJECT_MEMBERS_ROSTER ${roster}`
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
