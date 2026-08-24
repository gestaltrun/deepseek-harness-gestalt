/** Compute comparable CI feedback metrics from GitHub workflow and job timestamps. */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** GitHub job fields required by the metric population. */
export interface CiMetricJob {
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
}

/** GitHub workflow run and its complete job inventory. */
export interface CiMetricRun {
  databaseId: number
  event: string
  status: string
  conclusion: string | null
  createdAt: string
  jobs: CiMetricJob[]
}

/** Comparable CI success and latency baseline. */
export interface CiMetrics {
  formatVersion: 1
  sampleSize: number
  successfulRuns: number
  successRate: number | null
  queueMs: Distribution
  executionMs: Distribution
  firstConclusionMs: Distribution
  includedRunIds: number[]
  excludedRunIds: number[]
}

interface Distribution {
  p50: number | null
  p95: number | null
}

const EXCLUDED_RUN_CONCLUSIONS = new Set(['cancelled', 'skipped', 'stale'])
const AGGREGATE_JOB_NAMES = new Set(['all checks passed', 'candidate verdict', 'master evidence verdict'])
const OBSERVATIONAL_JOB_NAMES = new Set([
  'macos electron runtime e2e',
  'windows node 24 / native complete',
  'windows node 24 / native build and runtime',
  'windows node 24 / native coverage',
  'windows node 24 / native static portability',
  'windows node 24 / native verdict',
])

function isBookkeepingJob(name: string): boolean {
  return AGGREGATE_JOB_NAMES.has(name)
    || name.endsWith(' / plan targets')
    || name.startsWith('windows node 24 / native coverage shard ')
}

/**
 * Compute one baseline while excluding bookkeeping and invalid samples.
 * @param runs - Completed workflow runs with their complete job inventories.
 * @returns Comparable success and latency distributions.
 */
export function computeCiMetrics(runs: readonly CiMetricRun[]): CiMetrics {
  const includedRunIds: number[] = []
  const excludedRunIds: number[] = []
  const queue: number[] = []
  const execution: number[] = []
  const firstConclusion: number[] = []
  let successfulRuns = 0

  for (const run of runs) {
    if (run.event !== 'pull_request'
      || run.status !== 'completed'
      || run.conclusion === null
      || EXCLUDED_RUN_CONCLUSIONS.has(run.conclusion)) {
      excludedRunIds.push(run.databaseId)
      continue
    }
    const requiredJobs = run.jobs.filter(job =>
      !isBookkeepingJob(job.name)
      && !OBSERVATIONAL_JOB_NAMES.has(job.name))
    const validJobs = requiredJobs.filter(job =>
      job.status === 'completed'
      && job.conclusion !== null
      && job.startedAt !== null
      && job.completedAt !== null
      && !EXCLUDED_RUN_CONCLUSIONS.has(job.conclusion))
    const hasFailure = validJobs.some(job => job.conclusion !== 'success')
    if (requiredJobs.length === 0 || validJobs.length === 0
      || (validJobs.length !== requiredJobs.length && !hasFailure)) {
      excludedRunIds.push(run.databaseId)
      continue
    }
    const createdAt = timestamp(run.createdAt)
    const startedAt = validJobs.map((job) => {
      if (job.startedAt === null) throw new Error(`CI run ${String(run.databaseId)} has a required job without startedAt`)
      return timestamp(job.startedAt)
    }).sort((left, right) => left - right)
    const completedAt = validJobs.map((job) => {
      if (job.completedAt === null) throw new Error(`CI run ${String(run.databaseId)} has a required job without completedAt`)
      return timestamp(job.completedAt)
    }).sort((left, right) => left - right)
    const firstStartedAt = startedAt[0]
    const firstCompletedAt = completedAt[0]
    const lastCompletedAt = completedAt.at(-1)
    if (firstStartedAt === undefined || firstCompletedAt === undefined || lastCompletedAt === undefined) {
      throw new Error(`CI run ${String(run.databaseId)} has no required job timestamps`)
    }
    includedRunIds.push(run.databaseId)
    if (!hasFailure && validJobs.length === requiredJobs.length) successfulRuns += 1
    queue.push(firstStartedAt - createdAt)
    execution.push(lastCompletedAt - firstStartedAt)
    firstConclusion.push(firstCompletedAt - createdAt)
  }

  return {
    formatVersion: 1,
    sampleSize: includedRunIds.length,
    successfulRuns,
    successRate: includedRunIds.length === 0 ? null : successfulRuns / includedRunIds.length,
    queueMs: distribution(queue),
    executionMs: distribution(execution),
    firstConclusionMs: distribution(firstConclusion),
    includedRunIds,
    excludedRunIds,
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp ${JSON.stringify(value)}`)
  return parsed
}

function distribution(values: readonly number[]): Distribution {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null
}

interface GitHubRunList {
  workflow_runs: Array<{
    id: number
    event: string
    status: string
    conclusion: string | null
    created_at: string
  }>
}

interface GitHubJobList {
  jobs: Array<{
    name: string
    status: string
    conclusion: string | null
    started_at: string | null
    completed_at: string | null
  }>
}

/**
 * Validate the GitHub Actions workflow-runs response at the wire boundary.
 * @param value - JSON value returned by GitHub.
 * @returns Required run fields with their original names.
 */
export function parseGitHubRunList(value: unknown): GitHubRunList {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
    throw new Error('GitHub workflow runs response must contain workflow_runs')
  }
  return {
    workflow_runs: value.workflow_runs.map((run, index) => {
      if (!isRecord(run)
        || typeof run.id !== 'number'
        || typeof run.event !== 'string'
        || typeof run.status !== 'string'
        || !(typeof run.conclusion === 'string' || run.conclusion === null)
        || typeof run.created_at !== 'string') {
        throw new Error(`GitHub workflow run ${String(index)} is invalid`)
      }
      return {
        id: run.id,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
      }
    }),
  }
}

/**
 * Validate the GitHub Actions jobs response at the wire boundary.
 * @param value - JSON value returned by GitHub.
 * @returns Required job fields with their original names.
 */
export function parseGitHubJobList(value: unknown): GitHubJobList {
  if (!isRecord(value) || !Array.isArray(value.jobs)) {
    throw new Error('GitHub jobs response must contain jobs')
  }
  return {
    jobs: value.jobs.map((job, index) => {
      if (!isRecord(job)
        || typeof job.name !== 'string'
        || typeof job.status !== 'string'
        || !(typeof job.conclusion === 'string' || job.conclusion === null)
        || !(typeof job.started_at === 'string' || job.started_at === null)
        || !(typeof job.completed_at === 'string' || job.completed_at === null)) {
        throw new Error(`GitHub job ${String(index)} is invalid`)
      }
      return {
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        started_at: job.started_at,
        completed_at: job.completed_at,
      }
    }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function githubJson(endpoint: string): unknown {
  return JSON.parse(execFileSync('gh', [
    'api',
    '--method', 'GET',
    endpoint,
  ], { encoding: 'utf8' })) as unknown
}

function collectRuns(repository: string, limit: number): CiMetricRun[] {
  const runList = parseGitHubRunList(githubJson(
    `/repos/${repository}/actions/workflows/ci.yml/runs?per_page=${String(limit)}`,
  ))
  return runList.workflow_runs.map((run) => {
    const jobList = parseGitHubJobList(
      githubJson(`/repos/${repository}/actions/runs/${String(run.id)}/jobs?per_page=100`),
    )
    return {
      databaseId: run.id,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      jobs: jobList.jobs.map(job => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
      })),
    }
  })
}

function main(args: string[]): void {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      repo: { type: 'string' },
      limit: { type: 'string', default: '20' },
    },
  })
  if (values.repo === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(values.repo)) {
    throw new Error('missing or invalid --repo <owner/name>')
  }
  const limit = Number.parseInt(values.limit, 10)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || String(limit) !== values.limit) {
    throw new Error('--limit must be an integer from 1 through 100')
  }
  process.stdout.write(`${JSON.stringify(computeCiMetrics(collectRuns(values.repo, limit)), null, 2)}\n`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`ci-metrics: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
