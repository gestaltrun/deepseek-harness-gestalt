#!/usr/bin/env node
/** Verify that repository checks reject unprepared dependencies without mutation. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmInvocation } from './pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')
const timeoutMs = 45_000
const maxBuffer = 4 * 1024 * 1024

interface Outcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error: Error | undefined
}

interface Fixture {
  root: string
  repo: string
  lockfile: string
  lifecycleMarker: string
  runMarker: string
  baseSentinel: string
  extraSentinel: string
  env: NodeJS.ProcessEnv
}

type Policy = 'error' | 'absent'
type Entry = 'run' | 'exec'
type EnvironmentClass = 'local' | 'ci'

export const fixtureWorkspaceSettings = 'packages: []\npackageImportMethod: copy\n'

/** Unlink links within an owned fixture without traversing their targets. */
export function unlinkFixtureLinks(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!stat.isDirectory()) return
  for (const name of readdirSync(path)) unlinkFixtureLinks(join(path, name))
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readBytes(path: string): Buffer {
  return readFileSync(path)
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.equals(right)
}

function controlledEnvironment(fixtureRoot: string, environmentClass: EnvironmentClass): NodeJS.ProcessEnv {
  const home = join(fixtureRoot, 'home')
  const store = join(fixtureRoot, 'store')
  const cache = join(fixtureRoot, 'cache')
  const config = join(fixtureRoot, 'userconfig')
  const global = join(fixtureRoot, 'global')
  const corepack = join(fixtureRoot, 'corepack')
  for (const path of [home, store, cache, global, corepack]) mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(config, '')
  const systemPath = process.env.PATH?.split(delimiter).filter(entry => entry !== '') ?? []
  const windowsEnvironment = process.platform === 'win32'
    ? {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      PATHEXT: process.env.PATHEXT,
    }
    : {}
  return {
    ...windowsEnvironment,
    PATH: [...new Set([dirname(process.execPath), ...systemPath])].join(delimiter),
    HOME: home,
    XDG_CACHE_HOME: cache,
    COREPACK_HOME: corepack,
    npm_config_cache: cache,
    npm_config_userconfig: config,
    pnpm_config_store_dir: store,
    pnpm_config_global_dir: global,
    pnpm_config_global_bin_dir: join(global, 'bin'),
    pnpm_config_enable_global_virtual_store: 'false',
    pnpm_config_offline: 'true',
    pnpm_config_verify_deps_before_run: undefined,
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: undefined,
    CI: environmentClass === 'ci' ? 'true' : undefined,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}

function runPnpm(
  fixture: Fixture,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv = {},
): Outcome {
  const invocation = pnpmInvocation(args)
  const env = Object.fromEntries(
    Object.entries({ ...fixture.env, ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: fixture.repo,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer,
    killSignal: 'SIGKILL',
  })
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

function describeOutcome(outcome: Outcome): string {
  const output = `${outcome.stdout}${outcome.stderr}`.trim().slice(0, 800)
  const error = outcome.error === undefined ? '' : ` error=${outcome.error.message}`
  return `exit=${String(outcome.exitCode)} signal=${String(outcome.signal)}${error} output=${JSON.stringify(output)}`
}

function requireSuccess(label: string, outcome: Outcome): void {
  if (outcome.error !== undefined || outcome.signal !== null || outcome.exitCode !== 0) {
    throw new Error(`${label}: ${describeOutcome(outcome)}`)
  }
}

export function fixtureScripts(): Record<string, string> {
  return { check: 'node check.cjs', postinstall: 'node postinstall.cjs' }
}

function createFixture(policy: Policy, environmentClass: EnvironmentClass): Fixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-dependency-policy-'))
  const depRoot = join(fixtureRoot, 'deps')
  const repo = join(fixtureRoot, 'repo')
  mkdirSync(depRoot, { recursive: true })
  mkdirSync(repo, { recursive: true })

  for (const name of ['fixture-base', 'fixture-extra']) {
    const dep = join(depRoot, name)
    mkdirSync(dep)
    writeFileSync(join(dep, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', main: 'index.js' }, null, 2)}\n`)
    writeFileSync(join(dep, 'index.js'), `module.exports = ${JSON.stringify(name)}\n`)
  }

  const lifecycleMarker = join(repo, 'postinstall-ran.txt')
  const runMarker = join(repo, 'requested-script-ran.txt')
  writeFileSync(join(repo, 'check.cjs'), "require('node:fs').writeFileSync('requested-script-ran.txt','run')\n")
  writeFileSync(join(repo, 'postinstall.cjs'), "require('node:fs').writeFileSync('postinstall-ran.txt','install')\n")
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({
    name: 'dependency-policy-fixture',
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@11.7.0',
    scripts: fixtureScripts(),
    devDependencies: {
      'fixture-base': 'file:../deps/fixture-base',
    },
  }, null, 2)}\n`)
  writeFileSync(
    join(repo, 'pnpm-workspace.yaml'),
    policy === 'error' ? `${fixtureWorkspaceSettings}verifyDepsBeforeRun: error\n` : fixtureWorkspaceSettings,
  )

  return {
    root: fixtureRoot,
    repo,
    lockfile: join(repo, 'pnpm-lock.yaml'),
    lifecycleMarker,
    runMarker,
    baseSentinel: join(repo, 'node_modules', 'fixture-base', 'index.js'),
    extraSentinel: join(repo, 'node_modules', 'fixture-extra', 'index.js'),
    env: controlledEnvironment(fixtureRoot, environmentClass),
  }
}

function entryArgs(entry: Entry): string[] {
  return entry === 'run'
    ? ['run', 'check']
    : ['exec', process.execPath, '-e', "require('node:fs').writeFileSync('requested-script-ran.txt','exec')"]
}

function clearMarkers(fixture: Fixture): void {
  rmSync(fixture.lifecycleMarker, { force: true })
  rmSync(fixture.runMarker, { force: true })
}

/** Remove one owned fixture with Node's bounded Windows EPERM retry. */
export function removeFixtureRoot(path: string, remove: typeof rmSync = rmSync): void {
  remove(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export function finishFixture(primaryError: unknown, cleanup: () => void): void {
  try {
    cleanup()
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      throw new AggregateError([primaryError, cleanupError], 'dependency policy fixture failed and cleanup also failed')
    }
    throw cleanupError
  }
  if (primaryError instanceof Error) throw primaryError
  if (primaryError !== undefined) throw new Error('dependency policy fixture failed with a non-Error value')
}

function useFixture(
  policy: Policy,
  environmentClass: EnvironmentClass,
  run: (fixture: Fixture) => void,
): void {
  const fixture = createFixture(policy, environmentClass)
  let primaryError: unknown
  try {
    run(fixture)
  } catch (error) {
    primaryError = error
  }
  finishFixture(primaryError, () => {
    unlinkFixtureLinks(fixture.root)
    removeFixtureRoot(fixture.root)
  })
}

function addLockedExtraDependency(fixture: Fixture): void {
  const manifestPath = join(fixture.repo, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    devDependencies: Record<string, string>
  }
  manifest.devDependencies['fixture-extra'] = 'file:../deps/fixture-extra'
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  requireSuccess(
    'create stale lockfile',
    runPnpm(fixture, ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts']),
  )
  clearMarkers(fixture)
}

function prepareWarmStale(fixture: Fixture): void {
  requireSuccess(
    'create warm lockfile',
    runPnpm(fixture, ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts']),
  )
  requireSuccess('prepare warm fixture', runPnpm(fixture, ['install', '--frozen-lockfile']))
  if (!existsSync(fixture.baseSentinel)) throw new Error('warm prepare did not install the dev dependency sentinel')
  clearMarkers(fixture)
  addLockedExtraDependency(fixture)
  if (existsSync(fixture.extraSentinel)) throw new Error('stale fixture unexpectedly installed the added dependency')
}

function prepareCold(fixture: Fixture): void {
  requireSuccess(
    'prepare cold lockfile',
    runPnpm(fixture, ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts']),
  )
  rmSync(join(fixture.repo, 'node_modules'), { recursive: true, force: true })
  clearMarkers(fixture)
}

function assertRejectedWithoutMutation(
  failures: string[],
  label: string,
  fixture: Fixture,
  entry: Entry,
): void {
  const lockBefore = readBytes(fixture.lockfile)
  const manifestBefore = readBytes(join(fixture.repo, 'package.json'))
  const outcome = runPnpm(fixture, entryArgs(entry))
  const output = `${outcome.stdout}${outcome.stderr}`
  if (outcome.error !== undefined || outcome.signal !== null) {
    failures.push(`${label}: pnpm did not exit normally: ${describeOutcome(outcome)}`)
  }
  if (outcome.exitCode === 0) failures.push(`${label}: unprepared ${entry} exited successfully`)
  if (!output.includes('ERR_PNPM_VERIFY_DEPS_BEFORE_RUN')) {
    failures.push(`${label}: missing ERR_PNPM_VERIFY_DEPS_BEFORE_RUN: ${describeOutcome(outcome)}`)
  }
  if (existsSync(fixture.runMarker)) failures.push(`${label}: requested ${entry} command ran`)
  if (existsSync(fixture.lifecycleMarker)) failures.push(`${label}: install lifecycle ran`)
  if (!sameBytes(readBytes(fixture.lockfile), lockBefore)) failures.push(`${label}: lockfile bytes changed`)
  if (!sameBytes(readBytes(join(fixture.repo, 'package.json')), manifestBefore)) failures.push(`${label}: manifest bytes changed`)
}

function verifyPolicyRejection(
  failures: string[],
  state: 'stale' | 'cold',
  entry: Entry,
  environmentClass: EnvironmentClass,
): void {
  useFixture('error', environmentClass, (fixture) => {
    if (state === 'stale') prepareWarmStale(fixture)
    else prepareCold(fixture)
    assertRejectedWithoutMutation(failures, `${state} ${entry} ${environmentClass}`, fixture, entry)
    if (state === 'stale') {
      if (!existsSync(fixture.baseSentinel)) failures.push(`${state} ${entry} ${environmentClass}: dev dependency was pruned`)
      if (existsSync(fixture.extraSentinel)) failures.push(`${state} ${entry} ${environmentClass}: stale dependency was implicitly installed`)
    } else if (existsSync(join(fixture.repo, 'node_modules'))) {
      failures.push(`${state} ${entry} ${environmentClass}: cold rejection created node_modules`)
    }
  })
}

function verifyExplicitRecovery(
  failures: string[],
  state: 'stale' | 'cold',
  entry: Entry,
  environmentClass: EnvironmentClass,
): void {
  useFixture('error', environmentClass, (fixture) => {
    if (state === 'stale') prepareWarmStale(fixture)
    else prepareCold(fixture)
    assertRejectedWithoutMutation(failures, `recovery ${state} ${entry} ${environmentClass}`, fixture, entry)
    const lockBefore = readBytes(fixture.lockfile)
    const prepare = runPnpm(fixture, ['install', '--frozen-lockfile'])
    if (prepare.error !== undefined || prepare.signal !== null || prepare.exitCode !== 0) {
      failures.push(`recovery ${state} ${entry} ${environmentClass}: frozen install failed: ${describeOutcome(prepare)}`)
      return
    }
    if (!sameBytes(readBytes(fixture.lockfile), lockBefore)) failures.push(`recovery ${state} ${entry} ${environmentClass}: frozen install changed lockfile bytes`)
    if (!existsSync(fixture.baseSentinel)) failures.push(`recovery ${state} ${entry} ${environmentClass}: dev dependency sentinel missing after install`)
    if (state === 'stale' && !existsSync(fixture.extraSentinel)) failures.push(`recovery ${state} ${entry} ${environmentClass}: added dependency missing after install`)
    if (!existsSync(fixture.lifecycleMarker)) failures.push(`recovery ${state} ${entry} ${environmentClass}: explicit install did not run lifecycle evidence`)
    clearMarkers(fixture)
    const run = runPnpm(fixture, entryArgs(entry))
    if (run.error !== undefined || run.signal !== null || run.exitCode !== 0 || !existsSync(fixture.runMarker)) {
      failures.push(`recovery ${state} ${entry} ${environmentClass}: prepared command failed: ${describeOutcome(run)}`)
    }
    if (existsSync(fixture.lifecycleMarker)) failures.push(`recovery ${state} ${entry} ${environmentClass}: prepared command reran install lifecycle`)
    if (!sameBytes(readBytes(fixture.lockfile), lockBefore)) failures.push(`recovery ${state} ${entry} ${environmentClass}: prepared command changed lockfile bytes`)
  })
}

function verifyDefaultNegativeControl(failures: string[]): void {
  useFixture('absent', 'local', (fixture) => {
    prepareWarmStale(fixture)
    const lockBefore = readBytes(fixture.lockfile)
    const outcome = runPnpm(fixture, entryArgs('run'))
    if (outcome.error !== undefined || outcome.signal !== null || outcome.exitCode !== 0) {
      failures.push(`default-install negative control did not complete: ${describeOutcome(outcome)}`)
    }
    if (!existsSync(fixture.runMarker)) failures.push('default-install negative control did not run the requested script')
    if (!existsSync(fixture.lifecycleMarker)) failures.push('default-install negative control did not run postinstall')
    if (!existsSync(fixture.extraSentinel)) failures.push('default-install negative control did not install the stale dependency')
    if (!sameBytes(readBytes(fixture.lockfile), lockBefore)) failures.push('default-install negative control changed the prepared lockfile')
  })
}

function verifyOverride(
  failures: string[],
  kind: 'environment' | 'cli',
): void {
  useFixture('error', 'local', (fixture) => {
    prepareWarmStale(fixture)
    const outcome = kind === 'environment'
      ? runPnpm(fixture, entryArgs('run'), { pnpm_config_verify_deps_before_run: 'install' })
      : runPnpm(fixture, ['--config.verify-deps-before-run=install', ...entryArgs('run')])
    if (outcome.error !== undefined || outcome.signal !== null || outcome.exitCode !== 0) {
      failures.push(`${kind} override did not supersede workspace policy: ${describeOutcome(outcome)}`)
    }
    if (!existsSync(fixture.lifecycleMarker) || !existsSync(fixture.runMarker) || !existsSync(fixture.extraSentinel)) {
      failures.push(`${kind} override did not exhibit explicit install precedence`)
    }
  })
}

function verifySameLengthHashNegativeCase(failures: string[]): void {
  const left = Buffer.from('lock-A')
  const right = Buffer.from('lock-B')
  if (left.length !== right.length) throw new Error('same-length hash fixture is malformed')
  if (hashBytes(left) === hashBytes(right)) failures.push('byte hashing failed to distinguish same-length content')
}

function main(): void {
  const failures: string[] = []
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  if (!/(^|\n)verifyDepsBeforeRun:\s*error\s*(\n|$)/u.test(workspace)) {
    failures.push('pnpm-workspace.yaml must declare verifyDepsBeforeRun: error')
  }

  verifySameLengthHashNegativeCase(failures)
  for (const state of ['stale', 'cold'] as const) {
    for (const entry of ['run', 'exec'] as const) {
      for (const environmentClass of ['local', 'ci'] as const) {
        verifyPolicyRejection(failures, state, entry, environmentClass)
      }
    }
  }
  verifyExplicitRecovery(failures, 'stale', 'run', 'local')
  verifyExplicitRecovery(failures, 'cold', 'exec', 'ci')
  verifyDefaultNegativeControl(failures)
  verifyOverride(failures, 'environment')
  verifyOverride(failures, 'cli')

  if (failures.length > 0) {
    process.stderr.write('verify-dependency-policy: violations:\n')
    for (const failure of failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('verify-dependency-policy: run/exec reject stale and cold state without mutation; frozen recovery, default install, and overrides confirmed.\n')
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) main()
