/**
 * Allow-only tool eligibility resolved from preset, Workspace, and Session
 * configuration.
 * @module @deepseek-ai/dsh-tools-eligibility
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import { TOOL_ELIGIBILITY_CONTRIBUTIONS } from '@deepseek-ai/dsh-tools'
import type { ToolEligibilityContribution } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
// Type-only imports install the service declarations used through Context.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'

/** Cordis plugin name. */
export const name = 'tool-eligibility'

/** Services required by the settings-to-registry resolver. */
export const inject = ['agents', 'tools']

/** User-settings namespace for Workspace and Session additions. */
export const TOOL_ELIGIBILITY_SETTINGS_NAMESPACE = 'tool-eligibility'

/** Positive user configuration layered above preset allowances. */
export interface Config {
  /** Tool names added for every session in the Workspace keyed by its stable id. */
  workspaces: Record<string, string[]>
  /** Tool names added for the Session keyed by its durable id. */
  sessions: Record<string, string[]>
}

/** Runtime and settings schema. Both maps are allow-only. */
export const Config: z<Config> = z.object({
  workspaces: z.dict(z.array(z.string().min(1))).default({}),
  sessions: z.dict(z.array(z.string().min(1))).default({}),
})

/** Committed settings contribution and its expected effective registry view. */
export interface ToolEligibilityPublication {
  /** Sorted Workspace and Session additions, or absent when neither applies. */
  readonly settingsAllow?: readonly string[]
  /** Sorted preset-plus-settings union, or absent when no declaration applies. */
  readonly effectiveAllow?: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A settings-derived allowance was committed to or removed from one live
     * Agent's registry scope.
     * @param agent - live Agent whose scoped registry view changed.
     * @param publication - committed settings addition and expected effective union.
     * @mode emit
     */
    'tool-eligibility/published'(agent: Agent, publication: ToolEligibilityPublication): void
  }
}

interface AgentEligibilityState {
  readonly agent: Agent
  readonly contribution: ToolEligibilityContribution
}

function sameNames(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.length === right.length && left.every((entry, index) => entry === right[index]))
}

function unionNames(
  base: readonly string[] | undefined,
  additions: readonly string[] | undefined,
): readonly string[] | undefined {
  if (base === undefined && additions === undefined) return undefined
  return [...new Set([...base ?? [], ...additions ?? []])].sort()
}

/**
 * Contribute live Workspace and Session allowances to each Agent's authoritative
 * tool-registry scope. Preset allowances remain the base of the scope-chain union.
 * @param ctx - resolver context that owns every contribution and listener.
 * @param config - composition defaults beneath live user settings.
 */
export function apply(ctx: Context, config: Config): void {
  const entry = Config(config)
  let source = (): Config => entry
  const states = new Map<Agent, AgentEligibilityState>()

  const workspaceFor = (agent: Agent): Workspace | undefined => {
    const registry = ctx.get('workspaceRegistry')
    const cwd = agent.session.header.cwd
    return cwd === undefined ? undefined : registry?.list().find(workspace => workspace.path === cwd)
  }

  const additionsFor = (agent: Agent): readonly string[] | undefined => {
    const current = source()
    const workspace = workspaceFor(agent)
    const workspaceAllow = workspace === undefined ? undefined : current.workspaces[String(workspace.id)]
    const sessionAllow = current.sessions[String(agent.session.id)]
    if (workspaceAllow === undefined && sessionAllow === undefined) return undefined
    return [...new Set([...workspaceAllow ?? [], ...sessionAllow ?? []])].sort()
  }

  const attach = (agent: Agent): void => {
    if (states.has(agent)) return
    const contribution: ToolEligibilityContribution = ctx.tools[TOOL_ELIGIBILITY_CONTRIBUTIONS]
      .register(ctx, agent, (settingsAllow) => {
        const effectiveAllow = unionNames(contribution.baseAllow(), settingsAllow)
        ctx.emit('tool-eligibility/published', agent, {
          ...settingsAllow === undefined ? {} : { settingsAllow },
          ...effectiveAllow === undefined ? {} : { effectiveAllow },
        })
      })
    const state = { agent, contribution }
    states.set(agent, state)
    contribution.replace(additionsFor(agent))
  }

  const commitRefresh = (state: AgentEligibilityState): (() => readonly unknown[]) | undefined => {
    const additions = additionsFor(state.agent)
    if (sameNames(state.contribution.current(), additions)) return undefined
    return state.contribution.commit(additions)
  }

  const runRefresh = (containObserverFailures: boolean): void => {
    const notifications: Array<() => readonly unknown[]> = []
    for (const state of states.values()) {
      const notify = commitRefresh(state)
      if (notify !== undefined) notifications.push(notify)
    }
    const failures: unknown[] = []
    for (const notify of notifications) failures.push(...notify())
    if (failures.length === 0) return
    const aggregate = new AggregateError(failures, 'tool eligibility settings refresh observers failed')
    if (containObserverFailures) {
      ctx.logger.warn(aggregate)
      return
    }
    throw aggregate
  }

  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    state.contribution.dispose()
  })
  ctx.inject(['settings'], (settingsCtx) => {
    let sourceSet = false
    let containNextRefresh = false
    settingsCtx.settings.installSection(ctx, TOOL_ELIGIBILITY_SETTINGS_NAMESPACE, Config, entry, {
      setSource: (current) => {
        containNextRefresh = sourceSet
        sourceSet = true
        source = current
      },
      onChange: () => {
        const contain = containNextRefresh
        containNextRefresh = false
        runRefresh(contain)
      },
    })
  })

  for (const agent of ctx.agents.list()) attach(agent)
}
