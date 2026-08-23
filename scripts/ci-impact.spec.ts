import { describe, expect, it } from 'vitest'

import { planCiImpact } from './ci-impact.ts'
import type { CiPlan } from './ci-plan.ts'
import type { PackageGraphNode } from './package-graph.ts'

const graph: PackageGraphNode[] = [
  { short: 'session', name: '@deepseek-ai/dsh-session', group: 'core', rel: 'packages/core/session', deps: [] },
  { short: 'agent', name: '@deepseek-ai/dsh-agent', group: 'core', rel: 'packages/core/agent', deps: ['session'] },
]

const plan: CiPlan = {
  formatVersion: 1,
  level: 'impacted',
  affectedAreas: ['area/session'],
  directPackages: ['session'],
  affectedPackages: ['agent', 'session'],
  changedSources: ['packages/core/session/src/deleted.ts', 'packages/core/session/src/index.ts'],
  escalationReasons: [],
  lanes: [{ id: 'draft-impact', classification: 'required', reason: 'changed packages and reverse consumers' }],
  evidenceKey: 'evidence',
}

function withPnpmEntrypoint<T>(action: () => T): T {
  const previous = process.env.npm_execpath
  process.env.npm_execpath = '/private/pnpm.cjs'
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
    else process.env.npm_execpath = previous
  }
}

describe('Draft impacted evidence', () => {
  it('runs reverse-consumer tests with explicit coverage for existing changed sources', () => {
    const command = withPnpmEntrypoint(() =>
      planCiImpact(plan, graph, path => path.endsWith('index.ts')))

    expect(command.packages).toEqual(['agent', 'session'])
    expect(command.changedSources).toEqual(['packages/core/session/src/index.ts'])
    expect(command.displayCommand).toBe([
      'pnpm exec vitest run --coverage',
      '--coverage.include=packages/core/session/src/index.ts',
      'packages/core/agent packages/core/session',
    ].join(' '))
  })

  it('runs package tests without repository-wide coverage when only tests changed', () => {
    const command = withPnpmEntrypoint(() =>
      planCiImpact({ ...plan, changedSources: [] }, graph, () => false))

    expect(command.displayCommand).toBe('pnpm exec vitest run packages/core/agent packages/core/session')
  })

  it('rejects exhaustive and unresolved package plans', () => {
    expect(() => withPnpmEntrypoint(() =>
      planCiImpact({ ...plan, level: 'exhaustive' }, graph, () => true)))
      .toThrow('requires an impacted plan')
    expect(() => withPnpmEntrypoint(() =>
      planCiImpact({ ...plan, affectedPackages: ['missing'] }, graph, () => true)))
      .toThrow('cannot resolve every affected package')
  })
})
