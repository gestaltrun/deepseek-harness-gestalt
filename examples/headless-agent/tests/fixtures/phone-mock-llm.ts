/** Keyless adapter scripting the deferred phone arc: discover → list → runtime loss → revoked act. */

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

/** The model-visible deny text the assembled approval chain produces for an unattended ask. */
const REVOKED_MARKER = 'the user rejected tool "device_act"'

function toolCallChunks(id: string, name: string, args: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Scripted `phone-mock` adapter; the completed tool-result count selects the
 * turn, and the final turn fails loud unless the assembled chain actually
 * rejected the act — a regression that executes the tap never reaches the
 * scripted reply.
 */
class PhoneMockAdapter extends LlmAdapter {
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
    const toolResults = options.messages
      .flatMap(message => message.content)
      .filter(block => block.type === 'tool-result')
    if (toolResults.length === 0) {
      yield* toolCallChunks('phone-search-call', 'tool_search', JSON.stringify({ query: 'device act' }))
      return
    }
    if (toolResults.length === 1) {
      yield* toolCallChunks('phone-list-call', 'device_list', JSON.stringify({}))
      return
    }
    if (toolResults.length === 2) {
      yield* toolCallChunks('phone-act-call', 'device_act', JSON.stringify({
        deviceId: 'emulator-5554',
        action: { kind: 'tap', x: 12, y: 40 },
      }))
      return
    }
    const last = toolResults.at(-1)
    const text = last?.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('') ?? ''
    if (!text.includes(REVOKED_MARKER)) {
      throw new Error(`phone-mock expected the revoked device_act failure, got: ${text}`)
    }
    yield* textChunks('PHONE_TOOL_REVOKED_KEYLESS')
  }
}

export const name = 'phone-mock-llm'
export const inject = ['llm']

/** Register the keyless `phone-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['phone-mock'], new PhoneMockAdapter())
}
