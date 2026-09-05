/** Static deployment Provider for exact child LLM route authorization. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SubagentRoutePreauthorization, {
  modelRouteKey,
  type SubagentRoute,
} from '@deepseek-ai/dsh-subagent-route-preauthorization'

/** Static deployment Provider configuration. */
export interface Config {
  /** Exact child LLM routes authorized by deployment composition. */
  allowedModels: SubagentRoute[]
}

export const Config: z<Config> = z.object({
  allowedModels: z.array(z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
  })).required(),
})

/** Immutable static Provider implementation. */
export class StaticSubagentRoutePreauthorization extends SubagentRoutePreauthorization {
  static Config = Config
  private readonly allowed: readonly SubagentRoute[]

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (!Array.isArray(config.allowedModels)) {
      throw new Error('subagent-route-preauthorization-static: `allowedModels` must be an array')
    }
    const routes = new Map<string, SubagentRoute>()
    for (const route of config.allowedModels) {
      if (typeof route.provider !== 'string' || route.provider.length === 0
        || typeof route.model !== 'string' || route.model.length === 0) {
        throw new Error('subagent-route-preauthorization-static: routes require non-empty provider and model ids')
      }
      routes.set(modelRouteKey(route), { ...route })
    }
    this.allowed = Object.freeze([...routes.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)))
  }

  snapshot(): readonly SubagentRoute[] {
    return Object.freeze(this.allowed.map(route => Object.freeze({ ...route })))
  }
}

export default StaticSubagentRoutePreauthorization
