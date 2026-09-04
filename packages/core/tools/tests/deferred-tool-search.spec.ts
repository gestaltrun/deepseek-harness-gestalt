import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage as createBaseToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { Config, ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const TEST_MAX_RESULT_BYTES = 64 * 1024

const signal = new AbortController().signal

function createToolResultMessage(
  input: Parameters<typeof createBaseToolResultMessage>[0] & { loadedTools?: ToolSchema[] },
): ReturnType<typeof createBaseToolResultMessage> {
  const base = createBaseToolResultMessage(input)
  if (input.loadedTools === undefined) return base
  const block = base.content[0]
  if (block?.type !== 'tool-result') throw new Error('expected canonical tool result block')
  return { ...base, content: [{ ...block, loadedTools: input.loadedTools }] } as ReturnType<typeof createBaseToolResultMessage>
}

function tool(name: string, description: string, deferLoading = false): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: async () => name,
    deferLoading,
  }
}

class FakeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.behavior(request)
  }
}

async function mount(config: Config = { toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES } }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, config)
  if (config.mode !== undefined && config.mode !== 'native') await ctx.plugin(FakeRuntime)
  return ctx
}

async function scopedAgent(ctx: Context, session: Session): Promise<{ agent: Agent; scope: Scope }> {
  const agent = { session } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  return { agent, scope }
}

function durableResultBlockBytes(callId: ToolCallId, result: ToolExecutionResult): number {
  if (result.isError || result.loadedTools === undefined) throw new Error('expected loaded tool result')
  const message = createToolResultMessage({
    callId,
    content: result.content,
    isError: false,
    loadedTools: result.loadedTools,
  })
  return new TextEncoder().encode(JSON.stringify(message.content[0])).byteLength
}

function deferredSchema(name: string, description: string): ToolSchema {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    },
  }
}

function appendDiscovery(session: Session, callId: ToolCallId, schemas: ToolSchema[]): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: JSON.stringify(schemas, null, 2) }],
      isError: false,
      loadedTools: schemas,
    }),
  }, { surfaceOp: 'append' })
}

function reconstructedResultBytes(schemas: ToolSchema[]): number {
  const message = createToolResultMessage({
    callId: ToolCallId('tool-search-restored'),
    content: [{ type: 'text', text: JSON.stringify(schemas, null, 2) }],
    isError: false,
    loadedTools: schemas,
  })
  return new TextEncoder().encode(JSON.stringify(message.content[0])).byteLength
}

function agentWithRestoredCandidates(candidates: readonly unknown[]): Agent {
  const base = createToolResultMessage({
    callId: ToolCallId('hostile-restored-candidates'),
    content: [{ type: 'text', text: 'restored discovery candidates' }],
    isError: false,
  })
  const block = base.content[0]
  if (block?.type !== 'tool-result') throw new Error('expected canonical tool result block')
  const message = {
    ...base,
    content: [{ ...block, loadedTools: candidates }],
  }
  return {
    session: {
      deriveMessages: () => [message] as never,
    },
  } as unknown as Agent
}

describe('deferred tool search', () => {
  it('applies direct-construction search defaults', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    new ToolRuntime(ctx, { toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES } })
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'tool_search')
    expect(schema?.parameters).toMatchObject({
      properties: {
        limit: { maximum: 10, description: 'Maximum matches to return (default 5).' },
      },
    })
  })

  it.each([
    [{}, /maxResultBytes must be a positive integer/],
    [{ maxResultBytes: 0 }, /maxResultBytes must be a positive integer/],
    [{ maxResultBytes: 1.5 }, /maxResultBytes must be a positive integer/],
    [{ maxResultBytes: TEST_MAX_RESULT_BYTES, maxResults: 0 }, /maxResults must be a positive integer/],
    [{ maxResultBytes: TEST_MAX_RESULT_BYTES, maxResults: 1.5 }, /maxResults must be a positive integer/],
    [{ maxResultBytes: TEST_MAX_RESULT_BYTES, maxResults: 2, defaultLimit: 0 }, /defaultLimit must be a positive integer/],
    [{ maxResultBytes: TEST_MAX_RESULT_BYTES, maxResults: 2, defaultLimit: 1.5 }, /defaultLimit must be a positive integer/],
    [{ maxResultBytes: TEST_MAX_RESULT_BYTES, maxResults: 2, defaultLimit: 3 }, /defaultLimit must be a positive integer/],
  ] as const)('rejects invalid direct-construction limits %#', async (toolSearch, message) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    expect(() => new ToolRuntime(ctx, {
      toolSearch: toolSearch as Exclude<Config['toolSearch'], undefined>,
    })).toThrow(message)
  })

  it('reserves tool_search and rejects deferred definitions while discovery is disabled', async () => {
    const ctx = await mount({ toolSearch: false })
    expect(() => ctx.tools.register(tool('tool_search', 'shadow search'))).toThrow(/reserved for deferred schema discovery/)
    expect(() => ctx.tools.register(tool('deferred', 'hidden', true))).toThrow(/toolSearch is disabled/)
  })

  it('keeps deferred schemas out of the initial request while retaining the eligible catalog', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('read', 'Read a local file'))
    ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather by city', true))
    ctx.tools.register(tool('mcp__calendar__list', 'List calendar events', true))

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['read', 'tool_search'])
    expect(ctx.tools.catalogSchemas().map(schema => schema.name)).toEqual([
      'read',
      'mcp__weather__forecast',
      'mcp__calendar__list',
    ])

    const result = await ctx.tools.execute({
      callId: ToolCallId('search-1'),
      name: 'tool_search',
      arguments: { query: 'weather forecast' },
      signal,
    })

    expect(result).toMatchObject({
      isError: false,
      loadedTools: [{
        name: 'mcp__weather__forecast',
        description: 'Forecast weather by city',
      }],
    })
    expect(result.content).toEqual([{
      type: 'text',
      text: JSON.stringify(result.isError ? [] : result.loadedTools, null, 2),
    }])
  })

  it.each([
    [null, 'non-object arguments'],
    [{ query: 42 }, 'query type'],
    [{ query: '' }, 'empty query'],
    [{ query: '   ' }, 'blank query'],
    [{ query: 'weather', unexpected: true }, 'unexpected property'],
    [{ query: 'weather', limit: '3' }, 'limit type'],
    [{ query: 'weather', limit: -1 }, 'negative limit'],
    [{ query: 'weather', limit: 0 }, 'zero limit'],
    [{ query: 'weather', limit: 1.5 }, 'fractional limit'],
    [{ query: 'weather', limit: 999 }, 'limit above configured maximum'],
  ] as const)('rejects invalid model search arguments: %s', async (arguments_, _case) => {
    const ctx = await mount({ toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES, maxResults: 3, defaultLimit: 2 } })
    for (let index = 0; index < 8; index += 1) {
      ctx.tools.register(tool(`weather_${index}`, `Weather forecast source ${index}`, true))
    }

    await expect(ctx.tools.execute({
      callId: ToolCallId('invalid-search'),
      name: 'tool_search',
      arguments: arguments_,
      signal,
    })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: 'INVALID_ARGS' } },
    })
  })

  it('enforces the configured search result cap at the model boundary', async () => {
    const ctx = await mount({ toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES, maxResults: 3, defaultLimit: 2 } })
    for (let index = 0; index < 8; index += 1) {
      ctx.tools.register(tool(`weather_${index}`, `Weather forecast source ${index}`, true))
    }

    const result = await ctx.tools.execute({
      callId: ToolCallId('capped-search'),
      name: 'tool_search',
      arguments: { query: 'weather', limit: 3 },
      signal,
    })

    expect(result).toMatchObject({ isError: false })
    if (result.isError) throw new Error('expected tool search success')
    expect(result.loadedTools).toHaveLength(3)
  })

  it.each([
    ['one huge description', [tool('weather_huge', `Weather ${'description '.repeat(200)}`, true)]],
    ['one huge parameter schema', [{
      ...tool('weather_parameters', 'Weather parameters', true),
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', description: `Weather ${'parameter '.repeat(200)}` } },
        additionalProperties: false,
      },
    }]],
    ['multiple schemas whose aggregate exceeds the budget', Array.from({ length: 4 }, (_, index) => (
      tool(`weather_${index}`, `Weather ${String(index)} ${'forecast '.repeat(20)}`, true)
    ))],
  ] as const)('rejects %s when the complete discovery result exceeds maxResultBytes', async (_case, definitions) => {
    const ctx = await mount({ toolSearch: { maxResultBytes: 800, maxResults: 10, defaultLimit: 10 } })
    for (const definition of definitions) ctx.tools.register(definition)

    await expect(ctx.tools.execute({
      callId: ToolCallId('oversize-search'),
      name: 'tool_search',
      arguments: { query: 'weather' },
      signal,
    })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: 'TOOL_SEARCH_RESULT_TOO_LARGE' } },
    })
  })

  it.each([
    ['draft-07', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { unit: { enum: ['celsius', 'fahrenheit'] } },
      additionalProperties: false,
    }],
    ['draft-07 HTTPS alias', {
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object',
      properties: { unit: { enum: ['celsius', 'fahrenheit'] } },
      additionalProperties: false,
    }],
    ['2020-12', {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        coordinates: {
          type: 'array',
          prefixItems: [{ type: 'number' }, { type: 'number' }],
          items: false,
        },
      },
      unevaluatedProperties: false,
    }],
    ['2020-12 hash alias', {
      $schema: 'https://json-schema.org/draft/2020-12/schema#',
      type: 'object',
      properties: {
        coordinates: {
          type: 'array',
          prefixItems: [{ type: 'number' }, { type: 'number' }],
          items: false,
        },
      },
      unevaluatedProperties: false,
    }],
  ] as const)('accepts a valid %s deferred parameter schema', async (_dialect, parameters) => {
    const ctx = await mount()
    ctx.tools.register({ ...tool(`weather_${_dialect}`, `Weather ${_dialect}`, true), parameters })

    await expect(ctx.tools.execute({
      callId: ToolCallId(`search-${_dialect}`),
      name: 'tool_search',
      arguments: { query: `weather ${_dialect}` },
      signal,
    })).resolves.toMatchObject({ isError: false, loadedTools: [{ parameters }] })
  })

  const invalidKeywordSchemas = [
    ['draft-07 required', {
      $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: 'value',
    }],
    ['draft-07 properties', {
      $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: [],
    }],
    ['draft-07 enum', {
      $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { value: { enum: 'x' } },
    }],
    ['2020-12 required', {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: 'value',
    }],
    ['2020-12 properties', {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: [],
    }],
    ['2020-12 enum', {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { value: { enum: 'x' } },
    }],
  ] as const

  it.each(invalidKeywordSchemas)('rejects invalid fresh %s schema keywords', async (_case, parameters) => {
    const ctx = await mount()
    ctx.tools.register({ ...tool('weather_invalid_keyword', 'Weather invalid keyword', true), parameters })

    await expect(ctx.tools.execute({
      callId: ToolCallId(`fresh-${_case}`),
      name: 'tool_search',
      arguments: { query: 'weather invalid keyword' },
      signal,
    })).resolves.toMatchObject({ isError: true })
  })

  it.each(invalidKeywordSchemas)('rejects invalid reconstructed %s schema keywords', async (_case, parameters) => {
    const ctx = await mount()
    const name = 'weather_invalid_keyword'
    ctx.tools.register(tool(name, 'Weather invalid keyword', true))
    const session = Session.create(SessionId(`reconstructed-${_case}`))
    appendDiscovery(session, ToolCallId(`restored-${_case}`), [{ name, description: 'Weather invalid keyword', parameters }])
    const agent = { session } as Agent

    await expect(ctx.systemPrompt.assemble({ scope: agent, agent })).rejects.toThrow(/valid JSON schema/)
  })

  it.each([
    [{
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { location: { type: 'not-a-json-schema-type' } },
    }, /must be equal to one of the allowed values/],
    [{
      $schema: 'https://example.com/custom-schema-dialect',
      type: 'object',
    }, /unsupported JSON schema dialect/],
  ] as const)('rejects malformed or unsupported deferred schema dialect %#', async (parameters, message) => {
    const ctx = await mount()
    ctx.tools.register({ ...tool('weather_dialect', 'Weather dialect', true), parameters })

    const result = await ctx.tools.execute({
      callId: ToolCallId('search-invalid-dialect'),
      name: 'tool_search',
      arguments: { query: 'weather dialect' },
      signal,
    })
    expect(result).toMatchObject({ isError: true })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toMatch(message)
    expect(result).not.toHaveProperty('loadedTools')
  })

  it.each(['value', 'content', 'error'] as const)(
    'clears discovery metadata when post-execute replaces the committed %s',
    async (replacement) => {
      const ctx = await mount()
      ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather by city', true))
      ctx.on('tools/post-execute', async () => {
        if (replacement === 'value') return { kind: 'accept', value: [] }
        if (replacement === 'content') {
          return { kind: 'accept', content: [{ type: 'text' as const, text: 'policy replaced search content' }] }
        }
        return { kind: 'block', feedback: [{ type: 'text' as const, text: 'search result blocked' }] }
      })

      const result = await ctx.tools.execute({
        callId: ToolCallId(`post-replaced-${replacement}`),
        name: 'tool_search',
        arguments: { query: 'weather forecast' },
        signal,
      })

      expect('loadedTools' in result ? result.loadedTools : undefined).toBeUndefined()
      if (replacement === 'content') {
        expect(result).toMatchObject({
          isError: false,
          value: [{ name: 'mcp__weather__forecast' }],
          content: [{ type: 'text', text: 'policy replaced search content' }],
        })
      } else if (replacement === 'error') {
        expect(result).toMatchObject({ isError: true, error: { message: 'search result blocked' } })
      } else {
        expect(result).toMatchObject({ isError: false, value: [], content: [{ type: 'text', text: '[]' }] })
      }
    },
  )

  it.each(['value', 'error'] as const)(
    'clears discovery metadata when around-execute replaces the committed %s',
    async (replacement) => {
      const ctx = await mount()
      ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather by city', true))
      ctx.on('tools/execute', async (_exec, next) => {
        await next()
        if (replacement === 'error') {
          return {
            isError: true as const,
            error: { message: 'around policy rejected search' },
            content: [{ type: 'text' as const, text: 'around policy rejected search' }],
          }
        }
        return {
          isError: false as const,
          value: [],
          content: [{ type: 'text' as const, text: 'around replacement' }],
        }
      })

      const result = await ctx.tools.execute({
        callId: ToolCallId(`around-replaced-${replacement}`),
        name: 'tool_search',
        arguments: { query: 'weather forecast' },
        signal,
      })

      expect('loadedTools' in result ? result.loadedTools : undefined).toBeUndefined()
      expect(result.isError).toBe(replacement === 'error')
    },
  )

  it('reconstructs discovered schemas from the durable result on the next request', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather by city', true))
    ctx.tools.register(tool('mcp__calendar__list', 'List calendar events', true))
    const session = Session.create(SessionId('deferred-search'))
    const agent = { session } as Agent
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Find a weather tool.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect((await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map(schema => schema.name))
      .toEqual(['tool_search'])

    const result = await ctx.tools.execute({
      callId: ToolCallId('search-1'),
      name: 'tool_search',
      arguments: { query: 'weather forecast' },
      agent,
      signal,
    })
    if (result.isError) throw new Error('expected tool search success')
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('search-1'),
        content: result.content,
        isError: false,
        loadedTools: result.loadedTools ?? [],
      }),
    }, { surfaceOp: 'append' })

    const next = await ctx.systemPrompt.assemble({ scope: agent, agent })
    expect(next.tools.map(schema => schema.name)).toEqual([
      'mcp__weather__forecast',
      'tool_search',
    ])

    const resumed = Session.create(SessionId('deferred-search-resumed'), session.snapshotEvents())
    const resumedAgent = { session: resumed } as Agent
    expect((await ctx.systemPrompt.assemble({ scope: resumedAgent, agent: resumedAgent })).tools)
      .toEqual(next.tools)
  })

  it.each([
    [{ name: 'mcp__weather__forecast', description: 'Forecast weather' }, 'missing field'],
    [{ name: 'mcp__weather__forecast', description: 42, parameters: { type: 'object' } }, 'description'],
    [{ name: 'mcp__weather__forecast', description: 'Forecast weather', parameters: null }, 'parameters'],
    [{
      name: 'mcp__weather__forecast',
      description: 'Forecast weather',
      parameters: { type: 'object', properties: { city: { type: 'unknown' } } },
    }, 'nested parameter schema'],
    [{
      name: 'mcp__weather__forecast',
      description: 'Forecast weather',
      parameters: { $schema: 'https://example.com/schema', type: 'object' },
    }, 'unsupported dialect'],
  ] as const)('rejects restored loadedTools with malformed %s', async (malformed, _case) => {
    const ctx = await mount()
    ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather', true))
    const persisted = Session.create(SessionId('malformed-loaded-tool'))
    persisted.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('search-malformed'),
        content: [{ type: 'text', text: 'malformed durable discovery' }],
        isError: false,
        loadedTools: [malformed] as never,
      }),
    }, { surfaceOp: 'append' })
    const restored = Session.create(
      SessionId(`restored-${_case}`),
      persisted.snapshotEvents(),
    )
    const agent = { session: restored } as Agent

    await expect(ctx.systemPrompt.assemble({ scope: agent, agent }))
      .rejects.toThrow(/durable loadedTools/)
  })

  it('ignores malformed, unsupported, huge, and hostile stale restored candidates', async () => {
    const ctx = await mount({ toolSearch: { maxResultBytes: 1_024 } })
    const eligible = deferredSchema('mcp__restored__eligible', 'Eligible restored schema')
    ctx.tools.register(tool(eligible.name, eligible.description, true))
    ctx.tools.register(tool('mcp__restored__ineligible', 'Currently ineligible schema', true))
    const session = Session.create(SessionId('restored-stale-candidates'))
    const { agent, scope } = await scopedAgent(ctx, session)
    scope.ctx.tools.allowEligible([eligible.name])
    const hostile = JSON.parse(`{
      "name": "__proto__",
      "description": "hostile stale schema",
      "parameters": { "type": "object" },
      "__proto__": { "polluted": true }
    }`) as unknown
    const stale = [
      null,
      { description: 'missing name', parameters: { type: 'object' } },
      { name: '', description: 'empty stale name', parameters: { type: 'object' } },
      { name: 42, description: 'non-string stale name', parameters: { type: 'object' } },
      {
        name: 'mcp__restored__unregistered',
        description: 'x'.repeat(1_000_000),
        parameters: { $schema: 'https://example.com/schema', type: 'object' },
      },
      {
        name: 'mcp__restored__ineligible',
        description: 42,
        parameters: { $schema: 'https://example.com/schema', type: 'object' },
      },
      hostile,
    ]
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('restored-stale'),
        content: [{ type: 'text', text: 'stale and eligible discovery candidates' }],
        isError: false,
        loadedTools: [...stale, eligible] as never,
      }),
    }, { surfaceOp: 'append' })

    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
    expect(assembly.tools.map(schema => schema.name)).toContain(eligible.name)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('ignores restored proxies and accessors without invoking their traps', async () => {
    const ctx = await mount()
    const eligible = deferredSchema('mcp__restored__eligible', 'Eligible restored schema')
    ctx.tools.register(tool(eligible.name, eligible.description, true))
    let prototypeTrapCalls = 0
    let accessorReads = 0
    const revoked = Proxy.revocable({
      name: 'mcp__restored__revoked',
      description: 'Revoked stale schema',
      parameters: { type: 'object' },
    }, {})
    revoked.revoke()
    const prototypeTrap = new Proxy({
      name: 'mcp__restored__trapped',
      description: 'Trapped stale schema',
      parameters: { type: 'object' },
    }, {
      getPrototypeOf: () => {
        prototypeTrapCalls++
        throw new Error('restored candidate prototype trap must not run')
      },
    })
    const accessorParameters = { type: 'object' }
    Object.defineProperty(accessorParameters, 'properties', {
      enumerable: true,
      get: () => {
        accessorReads++
        throw new Error('restored candidate accessor must not run')
      },
    })
    const accessor = {
      name: eligible.name,
      description: 'Accessor-bearing eligible schema',
      parameters: accessorParameters,
    }
    const cyclicParameters: Record<string, unknown> = { type: 'object' }
    cyclicParameters.self = cyclicParameters
    const cyclic = {
      name: eligible.name,
      description: 'Cyclic eligible schema',
      parameters: cyclicParameters,
    }
    const agent = agentWithRestoredCandidates([
      revoked.proxy,
      prototypeTrap,
      eligible,
      cyclic,
      accessor,
    ])

    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
    expect(assembly.tools.map(schema => schema.name)).toContain(eligible.name)
    expect(prototypeTrapCalls).toBe(0)
    expect(accessorReads).toBe(0)
  })

  it('budgets an eligible raw restored candidate before schema validation', async () => {
    const ctx = await mount({ toolSearch: { maxResultBytes: 512 } })
    const name = 'mcp__restored__oversized-invalid'
    ctx.tools.register(tool(name, 'Oversized invalid restored schema', true))
    const session = Session.create(SessionId('restored-budget-before-validation'))
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('restored-oversized-invalid'),
        content: [{ type: 'text', text: 'oversized invalid durable discovery' }],
        isError: false,
        loadedTools: [{
          name,
          description: 'x'.repeat(1_000_000),
          parameters: { $schema: 'https://example.com/schema', type: 'object' },
        }] as never,
      }),
    }, { surfaceOp: 'append' })
    const agent = { session } as Agent

    await expect(ctx.systemPrompt.assemble({ scope: agent, agent }))
      .rejects.toThrow(/maxResultBytes 512/)
  })

  it.each([
    ['one oversized schema', 'x'.repeat(1_000_000)],
    ['multibyte schema data', '界'.repeat(300)],
  ])('rejects restored %s under the current byte budget', async (_case, description) => {
    const ctx = await mount({ toolSearch: { maxResultBytes: 512 } })
    const schema = deferredSchema('mcp__restored__huge', description)
    ctx.tools.register(tool(schema.name, 'Restored huge schema', true))
    const session = Session.create(SessionId(`restored-${_case}`))
    appendDiscovery(session, ToolCallId('restored-huge'), [schema])
    const agent = { session } as Agent

    await expect(ctx.systemPrompt.assemble({ scope: agent, agent }))
      .rejects.toThrow(/maxResultBytes 512/)
  })

  it('budgets the aggregate eligible set restored from multiple results', async () => {
    const ctx = await mount({ toolSearch: { maxResultBytes: 900 } })
    const schemas = ['alpha', 'bravo', 'charlie', 'delta'].map(name => (
      deferredSchema(`mcp__restored__${name}`, `${name} ${'description '.repeat(20)}`)
    ))
    for (const schema of schemas) ctx.tools.register(tool(schema.name, schema.description, true))
    const session = Session.create(SessionId('restored-aggregate'))
    appendDiscovery(session, ToolCallId('restored-first'), schemas.slice(0, 2))
    appendDiscovery(session, ToolCallId('restored-second'), schemas.slice(2))
    const agent = { session } as Agent

    await expect(ctx.systemPrompt.assemble({ scope: agent, agent }))
      .rejects.toThrow(/maxResultBytes 900/)
  })

  it('accepts exact and under-budget restoration after filtering stale eligibility', async () => {
    const eligible = deferredSchema('mcp__restored__eligible', 'Eligible restored schema')
    const stale = {
      ...deferredSchema('mcp__restored__stale', '界'.repeat(1_000)),
      parameters: { $schema: 'https://example.com/schema', type: 'object' },
    }
    const exactBytes = reconstructedResultBytes([eligible])
    const assemble = async (maxResultBytes: number): Promise<ReturnType<Context['systemPrompt']['assemble']>> => {
      const ctx = await mount({ toolSearch: { maxResultBytes } })
      ctx.tools.register(tool(eligible.name, eligible.description, true))
      ctx.tools.register(tool(stale.name, stale.description, true))
      const session = Session.create(SessionId(`restored-bound-${maxResultBytes}`))
      appendDiscovery(session, ToolCallId('restored-bound'), [stale, eligible])
      const { agent, scope } = await scopedAgent(ctx, session)
      scope.ctx.tools.allowEligible([eligible.name])
      return ctx.systemPrompt.assemble({ scope: agent, agent })
    }

    expect((await assemble(exactBytes)).tools.map(schema => schema.name)).toContain(eligible.name)
    expect((await assemble(exactBytes + 1)).tools.map(schema => schema.name)).toContain(eligible.name)
    await expect(assemble(exactBytes - 1)).rejects.toThrow(/maxResultBytes/)
  })

  it.each(['native', 'both'] as const)('accepts visible tool_search in toolOrder under mode %s', async (mode) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { toolOrder: ['tool_search', '<unlisted-tools>'] })
    await ctx.plugin(ToolRuntime, { mode, toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES } })
    if (mode === 'both') await ctx.plugin(FakeRuntime)
    ctx.tools.register(tool('echo', 'Echo a value'))

    expect((await ctx.systemPrompt.assemble()).tools.map(schema => schema.name)[0]).toBe('tool_search')
    expect(() => ctx.tools.register(tool('tool_search', 'Shadow reserved discovery')))
      .toThrow(/reserved for deferred schema discovery/)
  })

  it('keeps PTC mode ordering limited to its actual run_code wire schema', async () => {
    const valid = new Context()
    await valid.plugin(SystemPrompt, { toolOrder: [RUN_CODE_NAME, '<unlisted-tools>'] })
    await valid.plugin(ToolRuntime, { mode: 'ptc', toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES } })
    await valid.plugin(FakeRuntime)
    expect((await valid.systemPrompt.assemble()).tools.map(schema => schema.name)).toEqual([RUN_CODE_NAME])

    const invalid = new Context()
    await invalid.plugin(SystemPrompt, { toolOrder: ['tool_search', '<unlisted-tools>'] })
    await invalid.plugin(ToolRuntime, { mode: 'ptc', toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES } })
    await invalid.plugin(FakeRuntime)
    await expect(invalid.systemPrompt.assemble())
      .rejects.toThrow(/toolOrder lists unregistered tool "tool_search"/)
  })

  it('drops a discovered schema when current allow-only eligibility changes', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather by city', true))
    ctx.tools.register(tool('mcp__calendar__list', 'List calendar events', true))
    const session = Session.create(SessionId('deferred-eligibility'))
    const { agent, scope } = await scopedAgent(ctx, session)
    const removeWeatherEligibility = scope.ctx.tools.allowEligible(['mcp__weather__forecast'])
    const result = await ctx.tools.execute({
      callId: ToolCallId('search-eligibility'),
      name: 'tool_search',
      arguments: { query: 'weather forecast' },
      agent,
      signal,
    })
    if (result.isError) throw new Error('expected tool search success')
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('search-eligibility'),
        content: result.content,
        isError: false,
        loadedTools: result.loadedTools ?? [],
      }),
    }, { surfaceOp: 'append' })

    removeWeatherEligibility()
    scope.ctx.tools.allowEligible(['mcp__calendar__list'])

    expect((await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map(schema => schema.name))
      .toEqual(['tool_search'])
    await expect(ctx.tools.execute({
      callId: ToolCallId('stale-weather'),
      name: 'mcp__weather__forecast',
      arguments: {},
      agent,
      signal,
    })).resolves.toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
  })

  it('reconstructs discovered schemas in the PTC mode SDK without native activation', async () => {
    const ctx = await mount({ mode: 'ptc', toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES } })
    ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather by city', true))
    const session = Session.create(SessionId('deferred-code-mode'))
    const agent = { session } as Agent
    const runtime = ctx.codeRuntime as FakeRuntime
    runtime.behavior = async (request) => {
      await request.bindings[0]?.functions.tool_search?.({ query: 'weather' })
      await request.bindings[0]?.functions.tool_search?.({ query: 'weather forecast' })
      return { logs: [] }
    }
    const result = await ctx.tools.execute({
      callId: ToolCallId('run-code-search'),
      name: 'run_code',
      arguments: { code: 'await tools.tool_search({ query: "weather" })', description: 'Find the weather tool' },
      agent,
      signal,
    })
    if (result.isError) throw new Error('expected run_code success')
    expect(result.loadedTools?.map(schema => schema.name)).toEqual(['mcp__weather__forecast'])
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('run-code-search'),
        content: result.content,
        isError: false,
        loadedTools: result.loadedTools ?? [],
      }),
    }, { surfaceOp: 'append' })

    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
    expect(assembly.tools.map(schema => schema.name)).toEqual(['run_code'])
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text)
      .toContain('mcp__weather__forecast')

    let nextRunBindings: string[] = []
    runtime.behavior = async (request) => {
      nextRunBindings = Object.keys(request.bindings[0]!.functions).sort()
      const forecast = request.bindings[0]!.functions.mcp__weather__forecast
      if (forecast === undefined) throw new Error('weather binding missing from reconstructed program')
      const value = await forecast({ value: 'Shanghai' })
      return { logs: [], value }
    }
    const nextRun = await ctx.tools.execute({
      callId: ToolCallId('run-code-weather'),
      name: 'run_code',
      arguments: { code: 'await tools.mcp__weather__forecast({ value: "Shanghai" })', description: 'Read the weather forecast' },
      agent,
      signal,
    })
    expect(nextRun).toMatchObject({ isError: false })
    expect(nextRunBindings).toEqual(['mcp__weather__forecast', 'tool_search'])
  })

  it('enforces the complete aggregate discovery limit on the outer PTC mode result', async () => {
    const searches = [
      ['alpha', 'forecast'],
      ['bravo', 'calendar'],
      ['charlie', 'contacts'],
      ['delta', 'documents'],
      ['echo', 'email'],
      ['foxtrot', 'files'],
      ['golf', 'geocoding'],
      ['hotel', 'hosting'],
    ] as const
    const callId = ToolCallId('run-code-aggregate-search')
    const run = async (maxResultBytes: number): Promise<{
      ctx: Context
      agent: Agent
      result: ToolExecutionResult
      completedSearches: number
      observed: ToolExecutionResult | undefined
    }> => {
      const ctx = await mount({ mode: 'ptc', toolSearch: { maxResultBytes, maxResults: 2, defaultLimit: 1 } })
      for (const [query, capability] of searches) {
        ctx.tools.register(tool(`mcp__${query}__${capability}`, `${query} ${capability} deferred capability`, true))
      }
      const agent = { session: Session.create(SessionId(`aggregate-${maxResultBytes}`)) } as Agent
      const runtime = ctx.codeRuntime as FakeRuntime
      let completedSearches = 0
      runtime.behavior = async (request) => {
        for (const [query] of searches) {
          await request.bindings[0]!.functions.tool_search?.({ query, limit: 1 })
          completedSearches += 1
        }
        return { logs: [] }
      }
      let observed: ToolExecutionResult | undefined
      ctx.on('tools/result', (exec, result) => {
        if (exec.callId === callId) observed = result
      })
      const result = await ctx.tools.execute({
        callId,
        name: 'run_code',
        arguments: { code: 'await Promise.all(searches)', description: 'Discover several deferred capabilities' },
        agent,
        signal,
      })
      return { ctx, agent, result, completedSearches, observed }
    }

    const probe = await run(TEST_MAX_RESULT_BYTES)
    if (probe.result.isError) throw new Error('expected aggregate probe success')
    const exactBytes = durableResultBlockBytes(callId, probe.result)

    const exact = await run(exactBytes)
    expect(exact.completedSearches).toBe(searches.length)
    expect(exact.result).toMatchObject({ isError: false })
    expect(durableResultBlockBytes(callId, exact.result)).toBe(exactBytes)

    const overflow = await run(exactBytes - 1)
    expect(overflow.completedSearches).toBe(searches.length)
    expect(overflow.result).toMatchObject({
      isError: true,
      error: { info: { code: 'TOOL_SEARCH_RESULT_TOO_LARGE' } },
    })
    expect(overflow.result).not.toHaveProperty('loadedTools')
    expect(overflow.observed).toEqual(overflow.result)
    expect(overflow.observed).not.toHaveProperty('loadedTools')

    if (!overflow.result.isError) throw new Error('expected aggregate overflow failure')
    overflow.agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: overflow.result.content,
        isError: true,
      }),
      ...(overflow.result.error.info === undefined ? {} : { error: overflow.result.error.info }),
    }, { surfaceOp: 'append' })
    const restored = overflow.agent.session.deriveMessages().at(-1)?.content[0]
    expect(restored).toMatchObject({ type: 'tool-result', isError: true })
    expect(restored).not.toHaveProperty('loadedTools')
    expect((await overflow.ctx.systemPrompt.assemble({ scope: overflow.agent, agent: overflow.agent }))
      .sections.find(section => section.name === 'tools:sdk')?.text)
      .not.toContain('mcp__alpha__forecast')
  })

  it('removes a reconstructed PTC mode binding when eligibility becomes stale', async () => {
    const ctx = await mount({ mode: 'ptc', toolSearch: { maxResultBytes: TEST_MAX_RESULT_BYTES } })
    ctx.tools.register(tool('mcp__weather__forecast', 'Forecast weather by city', true))
    ctx.tools.register(tool('mcp__calendar__list', 'List calendar events', true))
    const session = Session.create(SessionId('deferred-code-mode-stale'))
    const { agent, scope } = await scopedAgent(ctx, session)
    const removeWeatherEligibility = scope.ctx.tools.allowEligible(['mcp__weather__forecast'])
    const runtime = ctx.codeRuntime as FakeRuntime
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.tool_search?.({ query: 'weather forecast' })
      return { logs: [] }
    }
    const search = await ctx.tools.execute({
      callId: ToolCallId('run-code-stale-search'),
      name: 'run_code',
      arguments: { code: 'await tools.tool_search({ query: "weather forecast" })', description: 'Find the weather tool' },
      agent,
      signal,
    })
    if (search.isError) throw new Error('expected run_code search success')
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('run-code-stale-search'),
        content: search.content,
        isError: false,
        loadedTools: search.loadedTools ?? [],
      }),
    }, { surfaceOp: 'append' })

    removeWeatherEligibility()
    scope.ctx.tools.allowEligible(['mcp__calendar__list'])
    let nextRunBindings: string[] = []
    runtime.behavior = async (request) => {
      nextRunBindings = Object.keys(request.bindings[0]!.functions).sort()
      return { logs: [] }
    }
    await ctx.tools.execute({
      callId: ToolCallId('run-code-after-stale'),
      name: 'run_code',
      arguments: { code: 'return Object.keys(tools)', description: 'Inspect callable tools' },
      agent,
      signal,
    })

    expect(nextRunBindings).toEqual(['tool_search'])
  })
})
