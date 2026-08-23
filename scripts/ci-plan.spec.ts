import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { planCi, renderCiPlan, renderGitHubOutputs, type CiPlanInput } from './ci-plan.ts'
import { collectPackageGraph } from './package-graph.ts'

const completeInput: CiPlanInput = {
  event: 'pull_request',
  readiness: 'draft',
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
  changedPaths: ['.github/workflows/ci.yml', 'scripts/ci-plan.ts'],
  dependencyGraphDigest: 'dependency-graph',
  dependencyGraph: [],
  riskCatalog: {
    formatVersion: 1,
    rules: [
      { pattern: '.github/**', area: 'area/infra', escalation: 'workflow-or-planner-change' },
      { pattern: 'scripts/ci-*.ts', area: 'area/infra', escalation: 'workflow-or-planner-change' },
    ],
  },
  lockfileDigest: 'lockfile',
  workflowDigest: 'workflows',
  toolchainDigest: 'toolchain',
}

describe('CI plan', () => {
  it('renders one deterministic exhaustive plan with required and observational lanes', () => {
    const changedPaths = completeInput.changedPaths
    if (changedPaths === null) throw new TypeError('fixture must define changed paths')
    const plan = planCi(completeInput)

    expect(plan).toEqual(planCi({ ...completeInput, changedPaths: [...changedPaths] }))
    expect(plan).toMatchObject({
      formatVersion: 1,
      level: 'exhaustive',
      affectedAreas: ['area/infra'],
      directPackages: [],
      affectedPackages: [],
      escalationReasons: ['workflow-or-planner-change'],
    })
    expect(plan.evidenceKey).toMatch(/^[a-f0-9]{64}$/u)
    expect(plan.lanes.filter(lane => lane.classification === 'required').map(lane => lane.id)).toEqual([
      'static',
      'coverage',
      'consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows-wine',
    ])
    expect(plan.lanes.filter(lane => lane.classification === 'observational').map(lane => lane.id)).toEqual([
      'windows-native',
      'electron-macos',
    ])
  })

  it('fails closed to exhaustive evidence when any planning input is unavailable', () => {
    const plan = planCi({
      ...completeInput,
      baseSha: null,
      changedPaths: null,
      dependencyGraphDigest: null,
      dependencyGraph: null,
    })

    expect(plan.level).toBe('exhaustive')
    expect(plan.escalationReasons).toEqual([
      'unavailable-base',
      'unavailable-changed-paths',
      'unavailable-dependency-graph',
    ])
    expect(plan.lanes).toHaveLength(9)
  })

  it('requires every exhaustive lane for the Merge Queue candidate tree', () => {
    const plan = planCi({
      ...completeInput,
      event: 'merge_group',
      readiness: 'ready',
    })

    expect(plan.level).toBe('exhaustive')
    expect(plan.lanes).toHaveLength(9)
    expect(plan.lanes.every(lane => lane.classification === 'required')).toBe(true)
    expect(plan.lanes.map(lane => lane.id)).toEqual([
      'static',
      'coverage',
      'consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows-wine',
      'windows-native',
      'electron-macos',
    ])
  })

  it('selects changed packages, reverse consumers, and changed-source coverage for a Draft', () => {
    const plan = planCi({
      ...completeInput,
      changedPaths: [
        'packages/core/session/src/index.ts',
        'packages/core/session/tests/index.spec.ts',
      ],
      dependencyGraph: [
        { short: 'session', name: '@deepseek-ai/dsh-session', group: 'core', rel: 'packages/core/session', deps: [] },
        { short: 'agent', name: '@deepseek-ai/dsh-agent', group: 'core', rel: 'packages/core/agent', deps: ['session'] },
        { short: 'unrelated', name: '@deepseek-ai/dsh-unrelated', group: 'core', rel: 'packages/core/unrelated', deps: [] },
      ],
      riskCatalog: {
        formatVersion: 1,
        rules: [{ pattern: 'packages/core/**', area: 'area/session' }],
      },
    })

    expect(plan).toMatchObject({
      level: 'impacted',
      directPackages: ['session'],
      affectedPackages: ['agent', 'session'],
      changedSources: ['packages/core/session/src/index.ts'],
    })
    expect(plan.lanes.map(lane => lane.id)).toEqual(['draft-impact'])
  })

  it('adds assembled snapshots for Draft GUI and model-visible paths', () => {
    const plan = planCi({
      ...completeInput,
      changedPaths: ['packages/client/ui-browser/src/index.tsx'],
      dependencyGraph: [{
        short: 'client-ui-browser',
        name: '@deepseek-ai/dsh-client-ui-browser',
        group: 'client',
        rel: 'packages/client/ui-browser',
        deps: [],
      }],
      riskCatalog: {
        formatVersion: 1,
        rules: [{ pattern: 'packages/client/**', area: 'area/web' }],
      },
    })

    expect(plan.level).toBe('impacted')
    expect(plan.lanes.map(lane => lane.id)).toEqual(['draft-impact', 'consumers'])
  })

  it('selects static documentation evidence for a known documentation-only Draft', () => {
    const plan = planCi({
      ...completeInput,
      changedPaths: ['docs/testing.md'],
      dependencyGraph: [],
      riskCatalog: {
        formatVersion: 1,
        rules: [{ pattern: 'docs/**', area: 'area/infra' }],
      },
    })

    expect(plan.level).toBe('impacted')
    expect(plan.lanes.map(lane => lane.id)).toEqual(['static'])
    expect(plan.affectedAreas).toEqual(['area/infra'])
  })

  it.each([
    ['ready review', { readiness: 'ready' as const }],
    ['session lifecycle', { changedPaths: ['packages/core/session/src/index.ts'] }],
    ['unknown path', { changedPaths: ['future/new-surface.ts'] }],
  ])('escalates %s to exhaustive evidence', (_label, override) => {
    const plan = planCi({
      ...completeInput,
      dependencyGraph: [{
        short: 'session',
        name: '@deepseek-ai/dsh-session',
        group: 'core',
        rel: 'packages/core/session',
        deps: [],
      }],
      riskCatalog: {
        formatVersion: 1,
        rules: [{
          pattern: 'packages/core/session/**',
          area: 'area/session',
          escalation: 'session-lifecycle-change',
        }],
      },
      ...override,
    })

    expect(plan.level).toBe('exhaustive')
    expect(plan.lanes).toHaveLength(9)
  })

  it('escalates a cross-domain Draft while ignoring documentation-only area overlap', () => {
    const graph = [
      { short: 'llm', name: '@deepseek-ai/dsh-llm', group: 'llm', rel: 'packages/llm/llm', deps: [] },
      { short: 'web', name: '@deepseek-ai/dsh-web', group: 'web', rel: 'packages/web/web', deps: [] },
    ]
    const riskCatalog = {
      formatVersion: 1,
      rules: [
        { pattern: 'packages/llm/**', area: 'area/llm' as const },
        { pattern: 'packages/web/**', area: 'area/web' as const },
        { pattern: '.agents/**', area: 'area/infra' as const },
      ],
    }
    expect(planCi({
      ...completeInput,
      changedPaths: ['.agents/notes/note.md', 'packages/llm/llm/src/index.ts'],
      dependencyGraph: graph,
      riskCatalog,
    }).level).toBe('impacted')
    expect(planCi({
      ...completeInput,
      changedPaths: ['packages/llm/llm/src/index.ts', 'packages/web/web/src/index.ts'],
      dependencyGraph: graph,
      riskCatalog,
    }).escalationReasons).toContain('cross-domain-change')
  })

  it('fails closed for an unrecognized event and path', () => {
    const plan = planCi({
      ...completeInput,
      event: 'repository_import',
      changedPaths: ['future/system.dat'],
    })

    expect(plan.level).toBe('exhaustive')
    expect(plan.affectedAreas).toEqual([])
    expect(plan.escalationReasons).toEqual(['unknown-event', 'unknown-path'])
  })

  it('fails closed when a package path is absent from the current graph', () => {
    const plan = planCi({
      ...completeInput,
      changedPaths: ['packages/core/removed/src/index.ts'],
      dependencyGraph: [],
      riskCatalog: {
        formatVersion: 1,
        rules: [{ pattern: 'packages/core/**', area: 'area/session' }],
      },
    })

    expect(plan.level).toBe('exhaustive')
    expect(plan.escalationReasons).toContain('unresolved-package-path')
  })

  it('fails closed for an unsupported risk-catalog version', () => {
    const riskCatalog = completeInput.riskCatalog
    if (riskCatalog === null) throw new TypeError('fixture must define a risk catalog')
    const plan = planCi({
      ...completeInput,
      riskCatalog: { ...riskCatalog, formatVersion: 2 },
    })

    expect(plan.level).toBe('exhaustive')
    expect(plan.affectedAreas).toEqual([])
    expect(plan.escalationReasons).toContain('invalid-risk-catalog')
  })

  it('classifies every current package group without an unknown-path escalation', () => {
    const root = resolve(import.meta.dirname, '..')
    const graph = collectPackageGraph(root, [], 'ci-plan-spec')
    const riskCatalog = JSON.parse(readFileSync(resolve(root, 'scripts/ci-risk-catalog.json'), 'utf8')) as CiPlanInput['riskCatalog']
    for (const pkg of graph) {
      const plan = planCi({
        ...completeInput,
        changedPaths: [`${pkg.rel}/README.md`],
        dependencyGraph: graph,
        riskCatalog,
      })
      expect(plan.escalationReasons, pkg.rel).not.toContain('unknown-path')
    }
  })

  it('resolves the same local plan from the repository root and a nested directory', () => {
    const root = resolve(import.meta.dirname, '..')
    const args = [
      '--event', 'pull_request',
      '--readiness', 'draft',
      '--base', 'HEAD',
      '--head', 'HEAD',
    ]
    const first = renderCiPlan(args, root)

    expect(first).toBe(renderCiPlan(args, resolve(root, 'scripts')))
    expect(JSON.parse(first)).toMatchObject({ formatVersion: 1, level: 'exhaustive' })
  })

  it('degrades an unavailable ref instead of narrowing evidence', () => {
    const root = resolve(import.meta.dirname, '..')
    const unavailable = JSON.parse(renderCiPlan([
      '--event', 'pull_request',
      '--readiness', 'ready',
      '--base', 'missing-ref',
      '--head', 'HEAD',
    ], root)) as { level: string; escalationReasons: string[] }
    expect(unavailable.level).toBe('exhaustive')
    expect(unavailable.escalationReasons).toContain('unavailable-base')
    expect(unavailable.escalationReasons).toContain('unavailable-changed-paths')
  })

  it('projects stable job outputs from the plan', () => {
    const plan = planCi(completeInput)

    expect(renderGitHubOutputs(plan)).toBe([
      'level=exhaustive',
      'lanes=["static","coverage","consumers","node-compat","python-sdk","python-runtime","windows-wine","windows-native","electron-macos"]',
      'affected_areas=["area/infra"]',
      'affected_packages=[]',
      'changed_sources=[]',
      'escalation_reasons=["workflow-or-planner-change"]',
      `evidence_key=${plan.evidenceKey}`,
      '',
    ].join('\n'))
  })
})
