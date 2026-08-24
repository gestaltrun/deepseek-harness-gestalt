/** Execute Draft evidence for changed packages and their reverse consumers. */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { renderCiPlan, type CiPlan } from './ci-plan.ts'
import { collectPackageGraph, type PackageGraphNode } from './package-graph.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Command selected for one impacted Draft. */
export interface CiImpactCommand {
  command: string
  args: string[]
  displayCommand: string
  packages: string[]
  changedSources: string[]
}

/**
 * Select package tests and explicit changed-source coverage for an impacted plan.
 * @param plan - Planner output whose Draft impact lane was selected.
 * @param graph - Current package dependency graph.
 * @param sourceExists - Filesystem predicate used to omit deleted source files from coverage.
 * @returns Shell-free Vitest command and its evidence inventory.
 */
export function planCiImpact(
  plan: CiPlan,
  graph: readonly PackageGraphNode[],
  sourceExists: (path: string) => boolean,
): CiImpactCommand {
  if (plan.level !== 'impacted' || !plan.lanes.some(lane => lane.id === 'draft-impact')) {
    throw new Error('ci-impact requires an impacted plan with the draft-impact lane')
  }
  const affected = new Set(plan.affectedPackages)
  const packageDirs = graph
    .filter(pkg => affected.has(pkg.short))
    .map(pkg => pkg.rel)
    .sort()
  if (packageDirs.length !== affected.size) {
    throw new Error('ci-impact cannot resolve every affected package in the current graph')
  }
  const changedSources = plan.changedSources.filter(sourceExists).sort()
  const vitestArgs = [
    'vitest',
    'run',
    ...changedSources.length === 0
      ? []
      : ['--coverage', ...changedSources.map(path => `--coverage.include=${path}`)],
    ...packageDirs,
  ]
  return {
    ...pnpmInvocation(['exec', ...vitestArgs]),
    displayCommand: `pnpm exec ${vitestArgs.join(' ')}`,
    packages: [...plan.affectedPackages],
    changedSources,
  }
}

interface Options {
  base: string
  head: string
  planOnly: boolean
}

function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      'plan-only': { type: 'boolean', default: false },
    },
  })
  if (values.base === undefined) throw new Error('missing required --base <ref>')
  return { base: values.base, head: values.head, planOnly: values['plan-only'] }
}

function main(args: string[], cwd: string): number {
  const options = parseOptions(args)
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  const plan = JSON.parse(renderCiPlan([
    '--event', 'pull_request',
    '--readiness', 'draft',
    '--base', options.base,
    '--head', options.head,
  ], root)) as CiPlan
  const graph = collectPackageGraph(root, [], 'ci-impact')
  const command = planCiImpact(plan, graph, path => existsSync(resolve(root, path)))
  process.stdout.write(`${JSON.stringify({
    formatVersion: 1,
    level: plan.level,
    evidenceKey: plan.evidenceKey,
    packages: command.packages,
    changedSources: command.changedSources,
    command: command.displayCommand,
  }, null, 2)}\n`)
  if (options.planOnly) return 0
  const result = spawnSync(command.command, command.args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.cwd())
  } catch (error) {
    process.stderr.write(`ci-impact: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
