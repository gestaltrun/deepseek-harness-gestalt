#!/usr/bin/env node
/**
 * Gate for the repository's explicit pre-run dependency policy.
 *
 * `pnpm-workspace.yaml` sets `verifyDepsBeforeRun: error` so a `pnpm run` or
 * `pnpm exec` with cold or stale installed state fails loudly instead of
 * silently reinstalling (replaying a prior production-only install's flags)
 * and running install lifecycle before the requested script. This gate proves
 * the policy three ways: the repository declares it, the pinned pnpm honors
 * it for `run` and `exec` in an offline file-dependency fixture, and the
 * fixture without the policy still exhibits the implicit install the policy
 * exists to reject (the negative control — a YAML-only assertion could not).
 * A deliberate environment override still wins by pnpm's documented
 * precedence; the gate demonstrates that instead of claiming otherwise.
 * @module scripts/verify-dependency-policy
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** pnpm entrypoint this gate re-invokes; the launcher env names the real one. */
function pnpmCommand(): { command: string; args: string[] } {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('verify-dependency-policy: npm_execpath is unavailable; invoke through pnpm run.')
  }
  if (/\.[cm]?js$/iu.test(entrypoint)) return { command: process.execPath, args: [entrypoint] }
  return { command: entrypoint, args: [] }
}

/** One observed pnpm behavior sample from the fixture. */
interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Environment variable names pnpm's script launcher injects to stop recursive
 * pre-run checks (`pnpm_config_verify_deps_before_run: "false"`) and their
 * uppercase spelling. The fixture must be governed by its own workspace
 * configuration, so every invocation strips them unless a scenario sets the
 * override explicitly.
 */
const VERIFY_DEPS_ENV_KEYS = ['pnpm_config_verify_deps_before_run', 'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN']

function runPnpm(cwd: string, args: readonly string[], env: Record<string, string> = {}): RunOutcome {
  const { command, args: prefix } = pnpmCommand()
  const childEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !VERIFY_DEPS_ENV_KEYS.includes(key)) childEnv[key] = value
  }
  Object.assign(childEnv, env)
  const result = spawnSync(command, [...prefix, ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv,
    // Noninteractive: the policy's contract is that no TTY is required to fail.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The offline fixture: one local file dependency plus a check script. */
interface Fixture {
  dir: string
  /** Absolute path of the workspace manifest, for in-place policy edits. */
  workspacePath: string
}

function createFixture(parent: string, policy: 'error' | 'absent'): Fixture {
  const depDir = join(parent, 'dep')
  mkdirSync(depDir, { recursive: true })
  writeFileSync(join(depDir, 'package.json'), JSON.stringify({
    name: 'fixture-dep',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
  }))
  writeFileSync(join(depDir, 'index.js'), 'export const marker = "fixture-dep"\n')

  const repoDir = join(parent, 'repo')
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'fixture-repo',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      check: 'node -e "console.log(\'SCRIPT-RAN\')"',
      // Install-lifecycle sentinel: any implicit install executes this.
      postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'postinstall-ran.txt\', \'1\')"',
    },
    devDependencies: { 'fixture-dep': 'file:../dep' },
  }, null, 2) + '\n')
  const workspacePath = join(repoDir, 'pnpm-workspace.yaml')
  writeFileSync(workspacePath, policy === 'error' ? 'packages: []\nverifyDepsBeforeRun: error\n' : 'packages: []\n')
  return { dir: repoDir, workspacePath }
}

/** Deterministically stale state: manifest gains a dependency the lockfile knows but node_modules does not. */
function makeStale(fixture: Fixture): void {
  const manifestPath = join(fixture.dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown as {
    devDependencies: Record<string, string>
  }
  manifest.devDependencies['fixture-extra'] = 'file:../dep'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const add = runPnpm(fixture.dir, ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'])
  if (add.exitCode !== 0) throw new Error(`fixture lockfile update failed: ${add.stderr}`)
}

/** Cheap content fingerprint for before/after equality; not cryptographic. */
function contentFingerprint(path: string): string {
  const content = readFileSync(path, 'utf8')
  return `${String(content.length)}:${String(content.replace(/\s/g, '').length)}`
}

/**
 * Assert the policy-governed fixture behaves as specified.
 * @param fixture - offline fixture with the error policy installed and warm.
 * @returns violation messages; empty means the policy holds.
 */
function checkPolicyBehavior(fixture: Fixture): string[] {
  const failures: string[] = []
  const lockfile = join(fixture.dir, 'pnpm-lock.yaml')
  const postinstallMarker = join(fixture.dir, 'postinstall-ran.txt')

  // Stale state, noninteractive, both entrypoints: fail loudly, mutate nothing.
  makeStale(fixture)
  const before = contentFingerprint(lockfile)
  for (const [label, args] of [['run', ['run', 'check']], ['exec', ['exec', 'node', '-e', 'console.log("SCRIPT-RAN")']]] as const) {
    for (const [envLabel, env] of [['default env', {}], ['CI=true', { CI: 'true' }]] as const) {
      rmSync(postinstallMarker, { force: true })
      const outcome = runPnpm(fixture.dir, args, env)
      const combined = outcome.stdout + outcome.stderr
      if (outcome.exitCode === 0) failures.push(`${label} ${envLabel}: stale state must fail, got exit 0`)
      if (!combined.includes('ERR_PNPM_VERIFY_DEPS_BEFORE_RUN')) {
        failures.push(`${label} ${envLabel}: expected ERR_PNPM_VERIFY_DEPS_BEFORE_RUN, got: ${combined.slice(0, 200)}`)
      }
      if (combined.includes('Packages:')) failures.push(`${label} ${envLabel}: implicit install ran`)
      if (existsSync(postinstallMarker)) failures.push(`${label} ${envLabel}: install lifecycle ran implicitly`)
    }
  }
  if (contentFingerprint(lockfile) !== before) failures.push('stale-state rejection must leave the lockfile unchanged')
  const sentinel = join(fixture.dir, 'node_modules', 'fixture-dep', 'index.js')
  if (!existsSync(sentinel)) failures.push('existing dev dependency was pruned by the rejection')

  // A deliberate environment override wins — documented precedence, not a defect.
  rmSync(postinstallMarker, { force: true })
  const overridden = runPnpm(fixture.dir, ['run', 'check'], { pnpm_config_verify_deps_before_run: 'install' })
  if (overridden.exitCode !== 0 || !existsSync(postinstallMarker)) {
    failures.push('environment override pnpm_config_verify_deps_before_run=install must win by pnpm precedence and implicitly install')
  }

  // Explicit preparation with a frozen-lockfile install restores the same check.
  const repair = runPnpm(fixture.dir, ['install', '--frozen-lockfile', '--ignore-scripts'])
  if (repair.exitCode !== 0) failures.push(`frozen prepare failed: ${repair.stderr.slice(0, 200)}`)
  const afterRepair = runPnpm(fixture.dir, ['run', 'check'])
  if (afterRepair.exitCode !== 0 || !afterRepair.stdout.includes('SCRIPT-RAN')) {
    failures.push('check must succeed after explicit frozen prepare')
  }

  // Cold worktree: fail loudly with no implicit install, then prepare and pass.
  rmSync(join(fixture.dir, 'node_modules'), { recursive: true, force: true })
  const cold = runPnpm(fixture.dir, ['run', 'check'])
  if (cold.exitCode === 0) failures.push('cold state must fail, got exit 0')
  if (!existsSync(lockfile)) failures.push('cold rejection must not consume the lockfile')
  const coldRepair = runPnpm(fixture.dir, ['install', '--frozen-lockfile', '--ignore-scripts'])
  if (coldRepair.exitCode !== 0) failures.push(`cold frozen prepare failed: ${coldRepair.stderr.slice(0, 200)}`)
  const afterCold = runPnpm(fixture.dir, ['run', 'check'])
  if (afterCold.exitCode !== 0) failures.push('check must succeed after cold frozen prepare')
  return failures
}

/**
 * Negative control: the same fixture without the policy silently installs.
 * @param fixture - offline fixture whose policy line will be removed.
 * @returns true when pnpm's default policy exhibits the implicit install.
 */
function exhibitsDefaultInstall(fixture: Fixture): boolean {
  writeFileSync(fixture.workspacePath, 'packages: []\n')
  const baseline = runPnpm(fixture.dir, ['install', '--frozen-lockfile', '--ignore-scripts'])
  if (baseline.exitCode !== 0) throw new Error(`negative-control prepare failed: ${baseline.stderr}`)
  makeStale(fixture)
  const postinstallMarker = join(fixture.dir, 'postinstall-ran.txt')
  rmSync(postinstallMarker, { force: true })
  const outcome = runPnpm(fixture.dir, ['run', 'check'])
  return outcome.exitCode === 0 && existsSync(postinstallMarker)
}

function main(): void {
  const failures: string[] = []
  const declared = /(^|\n)verifyDepsBeforeRun:\s*error\s*(\n|$)/.test(
    readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
  )
  if (!declared) failures.push('pnpm-workspace.yaml must declare verifyDepsBeforeRun: error')

  const policyDir = mkdtempSync(join(tmpdir(), 'dsh-dep-policy-'))
  const controlDir = mkdtempSync(join(tmpdir(), 'dsh-dep-policy-control-'))
  try {
    const policyFixture = createFixture(policyDir, 'error')
    const prepare = runPnpm(policyFixture.dir, ['install', '--ignore-scripts'])
    if (prepare.exitCode !== 0) throw new Error(`fixture prepare failed: ${prepare.stderr}`)
    failures.push(...checkPolicyBehavior(policyFixture))

    const controlFixture = createFixture(controlDir, 'absent')
    const controlPrepare = runPnpm(controlFixture.dir, ['install', '--ignore-scripts'])
    if (controlPrepare.exitCode !== 0) throw new Error(`control prepare failed: ${controlPrepare.stderr}`)
    if (!exhibitsDefaultInstall(controlFixture)) {
      failures.push('negative control: pnpm default no longer implicitly installs; this gate is not observing real behavior')
    }
  } finally {
    rmSync(policyDir, { recursive: true, force: true })
    rmSync(controlDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    process.stderr.write('verify-dependency-policy: violations:\n')
    for (const failure of failures) process.stderr.write(`  ${failure}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-dependency-policy: error policy declared, honored by run/exec offline, negative control confirmed.\n')
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main()
}
