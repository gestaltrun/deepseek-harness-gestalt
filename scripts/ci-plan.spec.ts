import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { planCi, renderCiPlan, renderGitHubOutputs, type CiPlanInput } from './ci-plan.ts'

const completeInput: CiPlanInput = {
  event: 'pull_request',
  readiness: 'draft',
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
  changedPaths: ['.github/workflows/ci.yml', 'scripts/ci-plan.ts'],
  dependencyGraphDigest: 'dependency-graph',
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
    })

    expect(plan.level).toBe('exhaustive')
    expect(plan.escalationReasons).toEqual([
      'unavailable-base',
      'unavailable-changed-paths',
      'unavailable-dependency-graph',
    ])
    expect(plan.lanes).toHaveLength(9)
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
      'escalation_reasons=["workflow-or-planner-change"]',
      `evidence_key=${plan.evidenceKey}`,
      '',
    ].join('\n'))
  })
})
