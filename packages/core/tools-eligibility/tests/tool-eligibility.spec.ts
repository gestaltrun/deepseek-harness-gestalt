import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as ToolEligibility from '../src/index.ts'
import {
  Config,
  TOOL_ELIGIBILITY_SETTINGS_NAMESPACE,
} from '../src/index.ts'

const signal = new AbortController().signal

/** Writable in-memory settings provider for live-update coverage. */
class MemorySettings extends SettingsProvider {
  private doc: Record<string, unknown>

  constructor(ctx: Context, doc: Record<string, unknown>) {
    super(ctx)
    this.doc = structuredClone(doc)
  }

  get writable(): boolean { return true }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

function tool(name: string, execute = vi.fn(() => Promise.resolve(name))): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute,
  }
}

interface HarnessOptions {
  readonly cwd?: string | undefined
  readonly settings?: Config
  readonly presetAllow?: readonly string[] | null
  readonly workspaceRegistry?: 'match' | 'miss' | 'absent'
}

async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  if (options.workspaceRegistry !== 'absent') {
    ctx.provide('workspaceRegistry', {
      list: () => [{
        id: WorkspaceId('workspace-1'),
        path: options.workspaceRegistry === 'miss' ? '/elsewhere' : '/workspace',
      }],
    } as never)
  }
  const settings = options.settings ?? {
    workspaces: { 'workspace-1': ['workspace-tool'] },
    sessions: { 'session-1': ['session-tool'] },
  }
  const settingsRow = ctx.plugin(MemorySettings, {
    [TOOL_ELIGIBILITY_SETTINGS_NAMESPACE]: settings,
  })
  await settingsRow
  const resolverRow = ctx.plugin(ToolEligibility, { workspaces: {}, sessions: {} })
  await resolverRow

  const preset = { kind: 'preset' }
  let presetCtx!: Context
  let agentCtx!: Context
  const id = SessionId('session-1')
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: 0,
    isSeeded: false,
    ...'cwd' in options
      ? options.cwd === undefined ? {} : { cwd: options.cwd }
      : { cwd: '/workspace' },
  })
  const agent = { id, session } as Agent
  await ctx.plugin(Object.assign((inner: Context) => {
    presetCtx = createScope(inner, preset).ctx
    agentCtx = createScope(inner, agent, { parent: preset }).ctx
  }, { inject: ['tools', 'systemPrompt'] }))
  Object.assign(agent, { ctx: agentCtx, status: 'idle' })
  if (options.presetAllow !== null) {
    presetCtx.tools.allowEligible(options.presetAllow ?? ['preset-tool', 'late-tool'])
  }
  const removeAgent = ctx.agents.register(agent)
  return { agent, ctx, removeAgent, resolverRow, settingsRow }
}

async function addSecondAgent(ctx: Context): Promise<Agent> {
  const preset = { kind: 'preset' }
  let presetCtx!: Context
  let agentCtx!: Context
  const id = SessionId('session-2')
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd: '/workspace',
  })
  const agent = { id, session } as Agent
  await ctx.plugin(Object.assign((inner: Context) => {
    presetCtx = createScope(inner, preset).ctx
    agentCtx = createScope(inner, agent, { parent: preset }).ctx
  }, { inject: ['tools', 'systemPrompt'] }))
  Object.assign(agent, { ctx: agentCtx, status: 'idle' })
  presetCtx.tools.allowEligible(['preset-tool', 'late-tool'])
  ctx.agents.register(agent)
  return agent
}

describe('allow-only tool eligibility', () => {
  it('attaches an existing Agent when the resolver loads after registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemorySettings, {
      [TOOL_ELIGIBILITY_SETTINGS_NAMESPACE]: { workspaces: {}, sessions: { existing: ['allowed'] } },
    })
    const id = SessionId('existing')
    const session = Session.create(id, [], { version: 0, id, createdAt: 0, isSeeded: false })
    const agent = { id, session } as Agent
    let agentCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => { agentCtx = createScope(inner, agent).ctx }, {
      inject: ['tools', 'systemPrompt'],
    }))
    Object.assign(agent, { ctx: agentCtx, status: 'idle' })
    ctx.agents.register(agent)
    ctx.tools.register(tool('allowed'))
    ctx.tools.register(tool('blocked'))

    await ctx.plugin(ToolEligibility, { workspaces: {}, sessions: {} })

    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['allowed'])
  })

  it('unions preset, Workspace, and Session additions for schemas and execution', async () => {
    const { agent, ctx } = await harness()
    const blockedBody = vi.fn(() => Promise.resolve('blocked'))
    for (const definition of [
      tool('preset-tool'),
      tool('workspace-tool'),
      tool('session-tool'),
      tool('blocked-tool', blockedBody),
    ]) ctx.tools.register(definition)

    expect(ctx.tools.eligibilityAllow(agent)).toEqual([
      'late-tool',
      'preset-tool',
      'session-tool',
      'workspace-tool',
    ])
    expect(ctx.tools.schemas(agent).map(schema => schema.name).sort()).toEqual([
      'preset-tool',
      'session-tool',
      'workspace-tool',
    ])

    const blocked = await ctx.tools.execute({
      agent,
      callId: ToolCallId('blocked-call'),
      name: 'blocked-tool',
      arguments: {},
      signal,
    })
    expect(blocked.content).toEqual([{ type: 'text', text: 'Error: unknown tool "blocked-tool"' }])
    expect(blockedBody).not.toHaveBeenCalled()
  })

  it('recompiles dynamic tools and applies live allow-only settings updates', async () => {
    const { agent, ctx } = await harness()
    for (const name of ['preset-tool', 'workspace-tool', 'session-tool', 'blocked-tool']) {
      ctx.tools.register(tool(name))
    }
    ctx.tools.register(tool('late-tool'))
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toContain('late-tool')

    await ctx.settings.update(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      sessions: { 'session-1': ['session-tool', 'blocked-tool'] },
    })
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toContain('blocked-tool')
  })

  it('exposes no user-facing deny field', () => {
    const schema = JSON.stringify(Config.toJSON())
    expect(schema).toContain('workspaces')
    expect(schema).toContain('sessions')
    expect(schema).not.toContain('deny')
    expect(() => Config({ workspaces: {}, sessions: { 'session-1': [''] } })).toThrow()
  })

  it('removes settings allowances with agent removal and resolver disposal', async () => {
    const first = await harness()
    expect(first.ctx.tools.eligibilityAllow(first.agent)).toEqual([
      'late-tool',
      'preset-tool',
      'session-tool',
      'workspace-tool',
    ])

    first.removeAgent()
    expect(first.ctx.tools.eligibilityAllow(first.agent)).toEqual(['late-tool', 'preset-tool'])

    const second = await harness()
    await second.resolverRow.dispose()
    expect(second.ctx.tools.eligibilityAllow(second.agent)).toEqual(['late-tool', 'preset-tool'])

    await second.settingsRow.dispose()
    const replacement = second.ctx.plugin(ToolEligibility, {
      workspaces: {},
      sessions: { 'session-1': ['replacement-tool'] },
    })
    await replacement
    expect(second.ctx.tools.eligibilityAllow(second.agent)).toEqual([
      'late-tool',
      'preset-tool',
      'replacement-tool',
    ])
  })

  it('replaces one settings contribution without publishing an old-plus-new view', async () => {
    const { agent, ctx } = await harness()
    const observed: Array<readonly string[] | undefined> = []
    ctx.on('tools/change', () => { observed.push(ctx.tools.eligibilityAllow(agent)) })

    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: { 'session-1': ['blocked-tool'] },
    })

    expect(observed).toEqual([['blocked-tool', 'late-tool', 'preset-tool']])
    expect(ctx.tools.eligibilityAllow(agent)).toEqual(['blocked-tool', 'late-tool', 'preset-tool'])
  })

  it('commits replacement before a throwing tools/change listener observes it', async () => {
    const { agent, ctx } = await harness()
    const observed: Array<readonly string[] | undefined> = []
    ctx.on('tools/change', () => {
      observed.push(ctx.tools.eligibilityAllow(agent))
      throw new Error('observer failed')
    })

    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: { 'session-1': ['blocked-tool'] },
    })

    expect(observed).toEqual([['blocked-tool', 'late-tool', 'preset-tool']])
    expect(ctx.tools.eligibilityAllow(agent)).toEqual(['blocked-tool', 'late-tool', 'preset-tool'])
  })

  it('notifies tools/change after a committed publication observer failure', async () => {
    const { agent, ctx } = await harness()
    const observed: Array<[string, readonly string[] | undefined]> = []
    ctx.on('tool-eligibility/published', () => {
      observed.push(['published', ctx.tools.eligibilityAllow(agent)])
      throw Object.assign(new Error('publication invariant failed'), { code: 'INVARIANT' })
    })
    ctx.on('tools/change', () => {
      observed.push(['tools/change', ctx.tools.eligibilityAllow(agent)])
    })

    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: { 'session-1': ['blocked-tool'] },
    })

    expect(observed).toEqual([
      ['published', ['blocked-tool', 'late-tool', 'preset-tool']],
      ['tools/change', ['blocked-tool', 'late-tool', 'preset-tool']],
    ])
    expect(ctx.settings.get(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE)).toEqual({
      workspaces: {},
      sessions: { 'session-1': ['blocked-tool'] },
    })
    expect(ctx.tools.eligibilityAllow(agent)).toEqual(['blocked-tool', 'late-tool', 'preset-tool'])
  })

  it('commits every affected Agent before publishing a settings refresh', async () => {
    const { agent: first, ctx } = await harness()
    const second = await addSecondAgent(ctx)
    const observed: Array<[string, readonly string[] | undefined, readonly string[] | undefined]> = []
    const observe = (event: string): void => {
      observed.push([
        event,
        ctx.tools.eligibilityAllow(first),
        ctx.tools.eligibilityAllow(second),
      ])
    }
    ctx.on('tool-eligibility/published', () => { observe('published') })
    ctx.on('tools/change', () => { observe('tools/change') })

    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: { 'session-1': ['bash'], 'session-2': ['bash'] },
    })

    expect(observed).toHaveLength(4)
    for (const observation of observed) {
      expect(observation).toEqual([
        observation[0],
        ['bash', 'late-tool', 'preset-tool'],
        ['bash', 'late-tool', 'preset-tool'],
      ])
    }
  })

  it('attempts every Agent notification after the first tools/change observer failure', async () => {
    const { agent: first, ctx } = await harness()
    const second = await addSecondAgent(ctx)
    const publicationViews: Array<[readonly string[] | undefined, readonly string[] | undefined]> = []
    const changeViews: Array<[readonly string[] | undefined, readonly string[] | undefined]> = []
    const firstFailure = new Error('first tools/change observer failed')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    ctx.on('tool-eligibility/published', () => {
      publicationViews.push([
        ctx.tools.eligibilityAllow(first),
        ctx.tools.eligibilityAllow(second),
      ])
    })
    ctx.on('tools/change', () => {
      changeViews.push([
        ctx.tools.eligibilityAllow(first),
        ctx.tools.eligibilityAllow(second),
      ])
      if (changeViews.length === 1) throw firstFailure
    })

    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: { 'session-1': ['bash'], 'session-2': ['bash'] },
    })

    expect(publicationViews).toHaveLength(2)
    expect(changeViews).toHaveLength(2)
    for (const view of [...publicationViews, ...changeViews]) {
      expect(view).toEqual([
        ['bash', 'late-tool', 'preset-tool'],
        ['bash', 'late-tool', 'preset-tool'],
      ])
    }
    await vi.waitFor(() => {
      const aggregate = warn.mock.calls.flatMap(([value]) => value instanceof AggregateError ? [value] : [])[0]
      expect(aggregate?.errors).toContain(firstFailure)
    })
  })

  it('attempts both notification families for every Agent after the first publication failure', async () => {
    const { agent: first, ctx } = await harness()
    const second = await addSecondAgent(ctx)
    const publicationViews: Array<[readonly string[] | undefined, readonly string[] | undefined]> = []
    const changeViews: Array<[readonly string[] | undefined, readonly string[] | undefined]> = []
    const firstFailure = new Error('first publication observer failed')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    ctx.on('tool-eligibility/published', () => {
      publicationViews.push([
        ctx.tools.eligibilityAllow(first),
        ctx.tools.eligibilityAllow(second),
      ])
      if (publicationViews.length === 1) throw firstFailure
    })
    ctx.on('tools/change', () => {
      changeViews.push([
        ctx.tools.eligibilityAllow(first),
        ctx.tools.eligibilityAllow(second),
      ])
    })

    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: { 'session-1': ['bash'], 'session-2': ['bash'] },
    })

    expect(publicationViews).toHaveLength(2)
    expect(changeViews).toHaveLength(2)
    for (const view of [...publicationViews, ...changeViews]) {
      expect(view).toEqual([
        ['bash', 'late-tool', 'preset-tool'],
        ['bash', 'late-tool', 'preset-tool'],
      ])
    }
    await vi.waitFor(() => {
      const aggregate = warn.mock.calls.flatMap(([value]) => value instanceof AggregateError ? [value] : [])[0]
      expect(aggregate?.errors).toContain(firstFailure)
    })
  })

  it('handles unrestricted agents, unmatched Workspaces, and duplicate lifecycle notifications', async () => {
    const empty = await harness({
      cwd: undefined,
      presetAllow: null,
      settings: { workspaces: {}, sessions: {} },
      workspaceRegistry: 'absent',
    })
    expect(empty.ctx.tools.eligibilityAllow(empty.agent)).toBeUndefined()
    empty.ctx.emit(scopeTarget(empty.agent, empty.agent), 'agent/created', { agent: empty.agent })
    empty.ctx.emit(scopeTarget(empty.agent, empty.agent), 'agent/disposed', {
      agent: { ...empty.agent, id: SessionId('unknown') },
    })

    await empty.ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: { unused: ['unused'] },
      sessions: {},
    })
    await empty.ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: { 'session-1': ['solo'] },
    })
    expect(empty.ctx.tools.eligibilityAllow(empty.agent)).toEqual(['solo'])
    await empty.ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: {},
      sessions: {},
    })
    expect(empty.ctx.tools.eligibilityAllow(empty.agent)).toBeUndefined()

    const unmatched = await harness({
      presetAllow: null,
      settings: { workspaces: { 'workspace-1': ['unused'] }, sessions: {} },
      workspaceRegistry: 'miss',
    })
    expect(unmatched.ctx.tools.eligibilityAllow(unmatched.agent)).toBeUndefined()

    const workspaceOnly = await harness({
      presetAllow: null,
      settings: { workspaces: { 'workspace-1': ['workspace-only'] }, sessions: {} },
    })
    expect(workspaceOnly.ctx.tools.eligibilityAllow(workspaceOnly.agent)).toEqual(['workspace-only'])

    const absentRegistry = await harness({
      presetAllow: null,
      settings: { workspaces: { 'workspace-1': ['unused'] }, sessions: {} },
      workspaceRegistry: 'absent',
    })
    expect(absentRegistry.ctx.tools.eligibilityAllow(absentRegistry.agent)).toBeUndefined()
  })

  it('coalesces settings refreshes that preserve the normalized addition', async () => {
    const { agent, ctx } = await harness()
    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: { 'workspace-1': ['workspace-tool'] },
      sessions: { 'session-1': ['session-tool', 'session-tool'] },
    })
    expect(ctx.tools.eligibilityAllow(agent)).toEqual([
      'late-tool',
      'preset-tool',
      'session-tool',
      'workspace-tool',
    ])
    await ctx.settings.replace(TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, {
      workspaces: { 'workspace-1': ['workspace-tool'] },
      sessions: { 'session-1': ['blocked-tool'] },
    })
    expect(ctx.tools.eligibilityAllow(agent)).toEqual([
      'blocked-tool',
      'late-tool',
      'preset-tool',
      'workspace-tool',
    ])
  })
})
