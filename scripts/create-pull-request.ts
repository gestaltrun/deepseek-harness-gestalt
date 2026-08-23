/** Create a Draft pull request with tracker and CI-planner metadata. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { renderCiPlan, type CiPlan } from './ci-plan.ts'

const PULL_REQUEST_KINDS = new Set([
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
])

export interface PullRequestCreationInput {
  repository: string
  issueNumber: number
  kind: string
  explicitAreas: readonly string[]
  plannerAreas: readonly string[]
  title: string
  body: string
  base: string
}

export interface PullRequestCreationPlan {
  repository: string
  issueNumber: number
  labels: string[]
  title: string
  body: string
  base: string
}

/**
 * Resolve the complete GitHub metadata for a supported pull-request creation.
 * @param input - Explicit author intent and areas selected by the CI planner.
 * @returns The validated metadata sent to GitHub.
 */
export function planPullRequestCreation(input: PullRequestCreationInput): PullRequestCreationPlan {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(input.repository)) throw new Error('repository must be owner/name')
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) throw new Error('issue must be a positive integer')
  if (!PULL_REQUEST_KINDS.has(input.kind)) throw new Error(`unsupported kind: ${input.kind}`)
  const areas = [...new Set([...input.explicitAreas, ...input.plannerAreas])].sort()
  if (areas.some(area => !/^area\/[^/\s]+$/u.test(area))) throw new Error('areas must use area/* labels')
  if (areas.length === 0) throw new Error('at least one area is required')
  if (input.title.trim() === '') throw new Error('title must not be empty')
  if (input.body.trim() === '') throw new Error('body must not be empty')
  if (input.base.trim() === '') throw new Error('base must not be empty')
  return {
    repository: input.repository,
    issueNumber: input.issueNumber,
    labels: [input.kind, ...areas],
    title: input.title,
    body: `${input.body.trimEnd()}\n\nRefs #${input.issueNumber}`,
    base: input.base,
  }
}

/**
 * Project one validated creation plan into a GitHub CLI invocation.
 * @param plan - Validated pull-request metadata.
 * @returns Arguments for `gh`.
 */
export function pullRequestCreateArgs(plan: PullRequestCreationPlan): string[] {
  return [
    'pr', 'create',
    '--repo', plan.repository,
    '--draft',
    '--base', plan.base,
    '--title', plan.title,
    '--body', plan.body,
    ...plan.labels.flatMap(label => ['--label', label]),
  ]
}

interface CliOptions {
  issueNumber: number
  kind: string
  explicitAreas: string[]
  title: string
  bodyFile: string
  base: string
  repository: string
}

function parseOptions(args: string[], cwd: string): CliOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      issue: { type: 'string' },
      kind: { type: 'string' },
      area: { type: 'string', multiple: true },
      title: { type: 'string' },
      'body-file': { type: 'string' },
      base: { type: 'string' },
      repo: { type: 'string' },
    },
  })
  if (values.issue === undefined) throw new Error('missing required --issue <number>')
  if (values.kind === undefined) throw new Error('missing required --kind <kind/*>')
  if (values.title === undefined) throw new Error('missing required --title <title>')
  if (values['body-file'] === undefined) throw new Error('missing required --body-file <path>')
  if (values.base === undefined) throw new Error('missing required --base <branch>')
  const issueNumber = Number.parseInt(values.issue, 10)
  if (String(issueNumber) !== values.issue) throw new Error('issue must be a positive integer')
  return {
    issueNumber,
    kind: values.kind,
    explicitAreas: values.area ?? [],
    title: values.title,
    bodyFile: resolve(cwd, values['body-file']),
    base: values.base,
    repository: values.repo ?? originRepository(cwd),
  }
}

function originRepository(cwd: string): string {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim()
  const match = remote.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u)
  if (match === null) throw new Error('origin must be a GitHub repository')
  return `${match[1]}/${match[2]}`
}

function run(args: string[], cwd: string): void {
  const options = parseOptions(args, cwd)
  execFileSync('gh', [
    'issue', 'view', String(options.issueNumber),
    '--repo', options.repository,
    '--json', 'number',
  ], { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
  const ciPlan = JSON.parse(renderCiPlan([
    '--event', 'pull_request',
    '--readiness', 'draft',
    '--base', options.base,
    '--head', 'HEAD',
  ], cwd)) as CiPlan
  const plan = planPullRequestCreation({
    repository: options.repository,
    issueNumber: options.issueNumber,
    kind: options.kind,
    explicitAreas: options.explicitAreas,
    plannerAreas: ciPlan.affectedAreas,
    title: options.title,
    body: readFileSync(options.bodyFile, 'utf8'),
    base: options.base,
  })
  const output = execFileSync('gh', pullRequestCreateArgs(plan), { cwd, encoding: 'utf8' })
  process.stdout.write(output)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2), process.cwd())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`create-pull-request: ${message}\n`)
    process.exitCode = 1
  }
}
