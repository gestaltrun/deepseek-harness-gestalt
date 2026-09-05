/** Real Loader composition for deployment-preauthorized child routes. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import StaticSubagentRoutePreauthorization from '@deepseek-ai/dsh-subagent-route-preauthorization-static'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig, {
  SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
} from '../src/model-selection-settings.ts'
import { subagentModelSelectionPolicy } from '../src/model-selection-state.ts'

/** Writable in-memory settings provider for the Loader composition. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).reverse().map(ctx => ctx.fiber.dispose()))
})

/** Read whether one Agent's delegation definition contains route fields. */
function selectable(ctx: Context, agent: Awaited<ReturnType<Context['agents']['create']>>['agent']): boolean {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.schemas(agent).some(candidate => candidate.name === 'list_subagent_models')
}

describe('tool-subagent real Loader composition', () => {
  it('unions user and deployment routes without writing Settings', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-subagent', SubagentRuntime],
      ['@deepseek-ai/dsh-subagent-spawn-in-process', SubagentSpawn],
      ['@deepseek-ai/dsh-subagent-route-preauthorization-static', StaticSubagentRoutePreauthorization],
      ['@deepseek-ai/dsh-tool-subagent/model-selection-settings', SubagentModelSelectionConfig],
      ['@deepseek-ai/dsh-tool-subagent', tool],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.plugin(MemorySettings)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.loader.create({ name: '@deepseek-ai/dsh-session-projection' })
    await ctx.loader.create({
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
      config: {
        enabled: true,
        allowedModels: [{ provider: 'alpha', model: 'user' }],
      },
    })
    await ctx.loader.create({
      name: '@deepseek-ai/dsh-subagent-route-preauthorization-static',
      config: { allowedModels: [{ provider: 'beta', model: 'deploy' }] },
    })
    await ctx.loader.create({ name: '@deepseek-ai/dsh-subagent' })
    await ctx.loader.create({
      name: '@deepseek-ai/dsh-subagent-spawn-in-process',
      config: { providerName: 'spawn' },
    })
    await ctx.loader.await()
    const before = structuredClone(ctx.settings.get(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE))
    const handle = await ctx.agents.create({
      sessionId: SessionId('loader-union'),
      setup: async (agentCtx) => {
        await agentCtx.plugin(tool, {
          provider: 'spawn',
          modelSelectionSettings: true,
          deploymentRoutePreauthorization: true,
        })
      },
    })

    expect(selectable(ctx, handle.agent)).toBe(true)
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, handle.agent.session)).toEqual([
      { provider: 'alpha', model: 'user' },
      { provider: 'beta', model: 'deploy' },
    ])
    expect(ctx.settings.get(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE)).toEqual(before)
    expect(handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'subagent/model-selection-policy')).toHaveLength(1)
  })
})
