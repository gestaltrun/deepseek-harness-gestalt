import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

function tool(name: string, deferLoading = false): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    deferLoading,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(name),
  }
}

describe('session.toolEligibility', () => {
  it('projects the resolver catalog through the Host API', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536 } })
    ctx.tools.register(tool('read', true))
    ctx.tools.register(tool('write'))
    const session = ctx.sessions.create()
    const agent = { id: session.id, session } as Agent
    let agentCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => {
      agentCtx = createScope(inner, agent).ctx
      agentCtx.tools.allowEligible(['read'])
    }, { inject: ['tools'] }))
    Object.assign(agent, { status: 'idle', ctx: agentCtx })
    ctx.agents.register(agent)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/tmp',
    })

    const response = await api.sessions.toolEligibility({
      rpcId: RpcId('eligibility-1'),
      payload: { sessionId: session.id },
    })

    expect(response).toEqual({
      rpcId: RpcId('eligibility-1'),
      result: {
        ok: true,
        value: {
          allow: ['read'],
          tools: [{
            name: 'read',
            description: 'tool read',
            parameters: { type: 'object', properties: {} },
          }],
        },
      },
    })
  })
})
