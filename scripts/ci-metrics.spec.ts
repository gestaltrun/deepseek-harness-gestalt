import { describe, expect, it } from 'vitest'

import {
  computeCiMetrics,
  parseGitHubJobList,
  parseGitHubRunList,
  type CiMetricRun,
} from './ci-metrics.ts'

function run(
  databaseId: number,
  conclusion: string,
  jobs: CiMetricRun['jobs'],
): CiMetricRun {
  return {
    databaseId,
    event: 'pull_request',
    status: 'completed',
    conclusion,
    createdAt: '2026-08-24T00:00:00.000Z',
    jobs,
  }
}

function job(
  name: string,
  conclusion: string,
  startedAt: string,
  completedAt: string,
) {
  return { name, status: 'completed', conclusion, startedAt, completedAt }
}

describe('CI metrics', () => {
  it('rejects malformed GitHub run and job responses', () => {
    expect(() => parseGitHubRunList({ workflow_runs: [{ id: 'not-a-number' }] }))
      .toThrow('GitHub workflow run 0 is invalid')
    expect(() => parseGitHubJobList({ jobs: [{ name: 'missing timestamps' }] }))
      .toThrow('GitHub job 0 is invalid')
  })

  it('excludes aggregate, observational, cancelled, skipped, and superseded samples', () => {
    const metrics = computeCiMetrics([
      run(1, 'success', [
        job('preflight', 'success', '2026-08-24T00:00:02.000Z', '2026-08-24T00:00:05.000Z'),
        job('coverage', 'success', '2026-08-24T00:00:05.000Z', '2026-08-24T00:00:15.000Z'),
        job('python runtime / release-shaped Linux x64 / plan targets', 'success', '2026-08-24T00:00:01.000Z', '2026-08-24T00:00:02.000Z'),
        job('all checks passed', 'success', '2026-08-24T00:00:15.000Z', '2026-08-24T00:00:40.000Z'),
        job('windows node 24 / native complete', 'failure', '2026-08-24T00:00:02.000Z', '2026-08-24T00:01:00.000Z'),
        job('windows node 24 / native verdict', 'failure', '2026-08-24T00:00:02.000Z', '2026-08-24T00:01:00.000Z'),
      ]),
      run(2, 'cancelled', []),
      run(3, 'skipped', []),
      run(4, 'stale', []),
    ])

    expect(metrics).toMatchObject({
      sampleSize: 1,
      successfulRuns: 1,
      successRate: 1,
      queueMs: { p50: 2000, p95: 2000 },
      executionMs: { p50: 13000, p95: 13000 },
      firstConclusionMs: { p50: 5000, p95: 5000 },
      includedRunIds: [1],
      excludedRunIds: [2, 3, 4],
    })
  })

  it('counts a required failure without treating the aggregate as another sample', () => {
    const metrics = computeCiMetrics([
      run(5, 'failure', [
        job('preflight', 'failure', '2026-08-24T00:00:01.000Z', '2026-08-24T00:00:03.000Z'),
        job('coverage', 'skipped', '2026-08-24T00:00:03.000Z', '2026-08-24T00:00:03.000Z'),
        job('all checks passed', 'failure', '2026-08-24T00:00:03.000Z', '2026-08-24T00:00:04.000Z'),
      ]),
    ])

    expect(metrics).toMatchObject({ sampleSize: 1, successfulRuns: 0, successRate: 0 })
  })
})
