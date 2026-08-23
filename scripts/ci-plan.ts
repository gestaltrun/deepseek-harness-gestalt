/** Compute one deterministic, fail-closed CI execution plan. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { matchesGlob, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { renderChangeScope } from './change-scope.ts'
import { collectPackageGraph, type PackageGraphNode } from './package-graph.ts'

const FORMAT_VERSION = 1
const RISK_CATALOG_FORMAT_VERSION = 1
const KNOWN_EVENTS = new Set(['pull_request', 'merge_group', 'push', 'workflow_dispatch'])

export interface CiRiskRule {
  pattern: string
  area: `area/${string}`
  escalation?: string
}

export interface CiRiskCatalog {
  formatVersion: number
  rules: CiRiskRule[]
}

export interface CiPlanInput {
  event: string
  readiness: 'draft' | 'ready' | null
  baseSha: string | null
  headSha: string | null
  changedPaths: readonly string[] | null
  dependencyGraphDigest: string | null
  dependencyGraph: readonly PackageGraphNode[] | null
  riskCatalog: CiRiskCatalog | null
  lockfileDigest: string | null
  workflowDigest: string | null
  toolchainDigest: string | null
}

export interface CiPlanLane {
  id: string
  classification: 'required' | 'observational'
  reason: string
}

export interface CiPlan {
  formatVersion: typeof FORMAT_VERSION
  level: 'impacted' | 'exhaustive'
  affectedAreas: string[]
  directPackages: string[]
  affectedPackages: string[]
  changedSources: string[]
  escalationReasons: string[]
  lanes: CiPlanLane[]
  evidenceKey: string
}

const EXHAUSTIVE_LANES: CiPlanLane[] = [
  { id: 'static', classification: 'required', reason: 'repository static evidence' },
  { id: 'coverage', classification: 'required', reason: 'per-file coverage evidence' },
  { id: 'consumers', classification: 'required', reason: 'assembled snapshots and artifacts' },
  { id: 'node-compat', classification: 'required', reason: 'supported Node versions' },
  { id: 'python-sdk', classification: 'required', reason: 'Python SDK projection' },
  { id: 'python-runtime', classification: 'required', reason: 'release-shaped Python runtime' },
  { id: 'windows-wine', classification: 'required', reason: 'blocking Windows compatibility' },
  { id: 'windows-native', classification: 'observational', reason: 'native Windows inventory' },
  { id: 'electron-macos', classification: 'observational', reason: 'macOS Electron runtime' },
]

const DRAFT_IMPACT_LANE: CiPlanLane = {
  id: 'draft-impact',
  classification: 'required',
  reason: 'changed packages and reverse consumers',
}

const ASSEMBLED_SURFACE_PATTERNS = [
  /^apps\//u,
  /^packages\/client\//u,
  /^packages\/bundle\//u,
  /^packages\/core\/(?:system-prompt|tools)\//u,
  /^packages\/examples\//u,
  /^packages\/[^/]+\/tool-[^/]+\//u,
]

const DOCUMENTATION_PATTERNS = [
  /^\.agents\/notes\//u,
  /^\.agents\/research\//u,
  /^docs\//u,
  /(?:^|\/)README(?:\.zh)?\.md$/iu,
  /^[^/]+\.md$/u,
]

/**
 * Resolve the exhaustive CI plan for one normalized repository change.
 * @param input - Event, diff, dependency, risk, and toolchain evidence available to the planner.
 * @returns A deterministic plan that never narrows evidence for an unknown input.
 */
export function planCi(input: CiPlanInput): CiPlan {
  const normalizedPaths = input.changedPaths === null
    ? null
    : [...new Set(input.changedPaths)].sort()
  const affectedAreas = new Set<string>()
  const reasons: string[] = []
  const riskCatalog = input.riskCatalog?.formatVersion === RISK_CATALOG_FORMAT_VERSION
    ? input.riskCatalog
    : null

  if (input.baseSha === null) reasons.push('unavailable-base')
  if (input.headSha === null) reasons.push('unavailable-head')
  if (normalizedPaths === null) reasons.push('unavailable-changed-paths')
  if (input.dependencyGraphDigest === null) reasons.push('unavailable-dependency-graph')
  if (input.riskCatalog === null) reasons.push('unavailable-risk-catalog')
  else if (riskCatalog === null) reasons.push('invalid-risk-catalog')
  if (input.lockfileDigest === null) reasons.push('unavailable-lockfile')
  if (input.workflowDigest === null) reasons.push('unavailable-workflows')
  if (input.toolchainDigest === null) reasons.push('unavailable-toolchain')
  if (!KNOWN_EVENTS.has(input.event)) reasons.push('unknown-event')

  if (normalizedPaths !== null && riskCatalog !== null) {
    if (normalizedPaths.length === 0) reasons.push('empty-change-set')
    for (const changedPath of normalizedPaths) {
      const matched = riskCatalog.rules.filter(rule => matchesGlob(changedPath, rule.pattern))
      if (matched.length === 0) {
        addUnique(reasons, 'unknown-path')
        continue
      }
      for (const rule of matched) {
        affectedAreas.add(rule.area)
        if (rule.escalation !== undefined) addUnique(reasons, rule.escalation)
      }
    }
  }
  const productAreas = [...affectedAreas].filter(area => area !== 'area/infra')
  if (new Set(productAreas).size > 1) addUnique(reasons, 'cross-domain-change')

  const dependencyGraph = input.dependencyGraph
  const directPackages = normalizedPaths === null || dependencyGraph === null
    ? []
    : resolveDirectPackages(normalizedPaths, dependencyGraph)
  if (normalizedPaths !== null && dependencyGraph !== null
    && normalizedPaths.some(path => path.startsWith('packages/')
      && !dependencyGraph.some(pkg => path === pkg.rel || path.startsWith(`${pkg.rel}/`)))) {
    addUnique(reasons, 'unresolved-package-path')
  }
  const affectedPackages = dependencyGraph === null
    ? []
    : resolveReverseConsumers(directPackages, dependencyGraph)
  const changedSources = normalizedPaths?.filter(path =>
    /^packages\/[^/]+\/[^/]+\/src\/.*\.(?:[cm]?[jt]sx?)$/u.test(path)
    && !/\.d\.[cm]?[jt]sx?$/u.test(path)) ?? []
  const exhaustive = input.event !== 'pull_request'
    || input.readiness !== 'draft'
    || reasons.length > 0
  const lanes = exhaustive
    ? EXHAUSTIVE_LANES.map(lane => ({ ...lane }))
    : impactedLanes(normalizedPaths ?? [], affectedPackages)

  const normalizedInput = {
    event: input.event,
    readiness: input.readiness,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedPaths: normalizedPaths,
    dependencyGraphDigest: input.dependencyGraphDigest,
    riskCatalog: input.riskCatalog,
    lockfileDigest: input.lockfileDigest,
    workflowDigest: input.workflowDigest,
    toolchainDigest: input.toolchainDigest,
  }
  return {
    formatVersion: FORMAT_VERSION,
    level: exhaustive ? 'exhaustive' : 'impacted',
    affectedAreas: [...affectedAreas].sort(),
    directPackages,
    affectedPackages,
    changedSources,
    escalationReasons: reasons,
    lanes,
    evidenceKey: sha256(JSON.stringify(normalizedInput)),
  }
}

function resolveDirectPackages(paths: readonly string[], graph: readonly PackageGraphNode[]): string[] {
  return graph
    .filter(pkg => paths.some(path => path === pkg.rel || path.startsWith(`${pkg.rel}/`)))
    .map(pkg => pkg.short)
    .sort()
}

function resolveReverseConsumers(direct: readonly string[], graph: readonly PackageGraphNode[]): string[] {
  const affected = new Set(direct)
  for (;;) {
    const previousSize = affected.size
    for (const pkg of graph) {
      if (pkg.deps.some(dependency => affected.has(dependency))) affected.add(pkg.short)
    }
    if (affected.size === previousSize) return [...affected].sort()
  }
}

function impactedLanes(paths: readonly string[], affectedPackages: readonly string[]): CiPlanLane[] {
  const lanes: CiPlanLane[] = []
  if (affectedPackages.length > 0) lanes.push({ ...DRAFT_IMPACT_LANE })
  if (paths.some(path => DOCUMENTATION_PATTERNS.some(pattern => pattern.test(path)))) {
    lanes.push(copyExhaustiveLane('static'))
  }
  if (paths.some(path => ASSEMBLED_SURFACE_PATTERNS.some(pattern => pattern.test(path)))) {
    lanes.push(copyExhaustiveLane('consumers'))
  }
  if (paths.some(path => path.startsWith('packages/browser/browser-runtime-electron/'))) {
    lanes.push(copyExhaustiveLane('electron-macos'))
  }
  return lanes
}

function copyExhaustiveLane(id: string): CiPlanLane {
  const lane = EXHAUSTIVE_LANES.find(candidate => candidate.id === id)
  if (lane === undefined) throw new Error(`ci-plan: missing exhaustive lane ${JSON.stringify(id)}`)
  return { ...lane }
}

/**
 * Inspect a Git diff and render the CI plan used by local and hosted callers.
 * @param args - Planner CLI arguments with explicit event, readiness, base, and head.
 * @param cwd - Directory inside the Git worktree to inspect.
 * @returns Versioned plan JSON with a trailing newline.
 */
export function renderCiPlan(args: string[], cwd: string): string {
  const options = parseOptions(args)
  const repositoryRoot = repositoryRootFrom(cwd)
  const riskCatalog = readRiskCatalog(repositoryRoot)
  let dependencyGraph: PackageGraphNode[] | null = null
  try {
    dependencyGraph = collectPackageGraph(repositoryRoot, [], 'ci-plan')
  } catch {
    dependencyGraph = null
  }
  let scope: ReturnType<typeof parseChangeScope> | null = null
  try {
    scope = parseChangeScope(renderChangeScope([
      '--base', options.base,
      '--head', options.head,
    ], repositoryRoot))
  } catch {
    scope = null
  }
  const plan = planCi({
    event: options.event,
    readiness: options.readiness,
    baseSha: scope?.resolved.baseSha ?? null,
    headSha: scope?.resolved.headSha ?? null,
    changedPaths: scope?.paths.committed ?? null,
    dependencyGraphDigest: dependencyGraph === null ? null : sha256(JSON.stringify(dependencyGraph)),
    dependencyGraph,
    riskCatalog,
    lockfileDigest: digestFile(repositoryRoot, 'pnpm-lock.yaml'),
    workflowDigest: digestWorkflows(repositoryRoot),
    toolchainDigest: digestFile(repositoryRoot, 'package.json'),
  })
  return `${JSON.stringify(plan, null, 2)}\n`
}

/**
 * Render the stable outputs consumed by downstream GitHub Actions jobs.
 * @param plan - Complete CI plan to project.
 * @returns GitHub output-file records with a trailing newline.
 */
export function renderGitHubOutputs(plan: CiPlan): string {
  return [
    `level=${plan.level}`,
    `lanes=${JSON.stringify(plan.lanes.map(lane => lane.id))}`,
    `affected_areas=${JSON.stringify(plan.affectedAreas)}`,
    `affected_packages=${JSON.stringify(plan.affectedPackages)}`,
    `changed_sources=${JSON.stringify(plan.changedSources)}`,
    `escalation_reasons=${JSON.stringify(plan.escalationReasons)}`,
    `evidence_key=${plan.evidenceKey}`,
    '',
  ].join('\n')
}

interface PlannerOptions {
  event: string
  readiness: 'draft' | 'ready' | null
  base: string
  head: string
}

function parseOptions(args: string[]): PlannerOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      event: { type: 'string' },
      readiness: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
    },
  })
  if (values.event === undefined) throw new Error('missing required --event <name>')
  if (values.base === undefined) throw new Error('missing required --base <ref>')
  if (values.readiness !== undefined && values.readiness !== 'draft' && values.readiness !== 'ready') {
    throw new Error(`--readiness must be draft or ready, got ${JSON.stringify(values.readiness)}`)
  }
  return {
    event: values.event,
    readiness: values.readiness ?? null,
    base: values.base,
    head: values.head,
  }
}

interface ChangeScopeSubset {
  resolved: { baseSha: string; headSha: string }
  paths: { committed: string[] }
}

function parseChangeScope(json: string): ChangeScopeSubset {
  return JSON.parse(json) as ChangeScopeSubset
}

function repositoryRootFrom(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return resolve(cwd)
  }
}

function readRiskCatalog(root: string): CiRiskCatalog | null {
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(root, 'scripts/ci-risk-catalog.json'), 'utf8'))
    return isRiskCatalog(value) ? value : null
  } catch {
    return null
  }
}

function isRiskCatalog(value: unknown): value is CiRiskCatalog {
  if (!isRecord(value) || typeof value.formatVersion !== 'number' || !Array.isArray(value.rules)) return false
  return value.rules.every(rule => isRecord(rule)
    && typeof rule.pattern === 'string'
    && rule.pattern !== ''
    && typeof rule.area === 'string'
    && rule.area.startsWith('area/')
    && (rule.escalation === undefined || typeof rule.escalation === 'string'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function digestFile(root: string, relativePath: string): string | null {
  try {
    return sha256(readFileSync(resolve(root, relativePath)))
  } catch {
    return null
  }
}

function digestWorkflows(root: string): string | null {
  try {
    const directory = resolve(root, '.github/workflows')
    const files = readdirSync(directory).filter(file => file.endsWith('.yml') || file.endsWith('.yaml')).sort()
    const hash = createHash('sha256')
    for (const file of files) {
      hash.update(file)
      hash.update('\0')
      hash.update(readFileSync(resolve(directory, file)))
      hash.update('\0')
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    const json = renderCiPlan(process.argv.slice(2), process.cwd())
    process.stdout.write(json)
    if (process.env.GITHUB_OUTPUT !== undefined) {
      appendFileSync(process.env.GITHUB_OUTPUT, renderGitHubOutputs(JSON.parse(json) as CiPlan))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ci-plan: ${message}\n`)
    process.exitCode = 1
  }
}
