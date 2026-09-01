#!/usr/bin/env node
/**
 * Run the release-backed Sub2API flow in an isolated Desktop Host. The caller
 * supplies the public installer source manifest; this launcher owns the
 * temporary Harness home, Electron user data, build, and teardown.
 */
import { spawn, spawnSync } from 'node:child_process'
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { assertArtifactSecretsAbsent, credentialValues } from './artifact-secret-safety.mjs'
import { withPrivateTempDirectory } from './private-temp-directory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const repoRoot = join(desktopRoot, '..', '..')
const e2eRoot = join(desktopRoot, 'tests', 'e2e-sub2api')
const operatedPlatform = join(desktopRoot, 'tests', 'fixtures', 'operated-platform.json')
const sourceManifest = process.env.DSH_SUB2API_E2E_SOURCES
const sidecarHead = process.env.DSH_SUB2API_E2E_SIDECAR_SHA
const credentialsSource = process.env.DSH_SUB2API_E2E_CREDENTIALS_SOURCE
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
const artifactDir = join(repoRoot, '.artifacts', 'e2e-sub2api', stamp)

if (sourceManifest === undefined || !isAbsolute(sourceManifest)) {
  throw new Error('Sub2API Electron e2e requires absolute DSH_SUB2API_E2E_SOURCES')
}
if (sidecarHead === undefined || !/^[0-9a-f]{40}$/u.test(sidecarHead)) {
  throw new Error('Sub2API Electron e2e requires 40-hex DSH_SUB2API_E2E_SIDECAR_SHA')
}
if (credentialsSource === undefined || !isAbsolute(credentialsSource)) {
  throw new Error('Sub2API Electron e2e requires absolute DSH_SUB2API_E2E_CREDENTIALS_SOURCE')
}
await access(sourceManifest)
await access(credentialsSource)
await mkdir(artifactDir, { recursive: true })
const sourceDocument = publicSourceDocument(JSON.parse(await readFile(sourceManifest, 'utf8')))
const credentialDocument = load(await readFile(credentialsSource, 'utf8'))
const credentialSecrets = credentialValues(credentialDocument)
const providerSecret = record(record(credentialDocument)?.refs)?.ZAI_CODING_CN_API_KEY
if (typeof providerSecret !== 'string' || providerSecret.length === 0) {
  throw new Error('Sub2API Electron e2e credentials have no ZAI_CODING_CN_API_KEY')
}
const gestaltHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
if (!/^[0-9a-f]{40}$/u.test(gestaltHead)) throw new Error('Sub2API Electron e2e could not resolve Gestalt HEAD')
await writeFile(join(artifactDir, 'provenance.json'), JSON.stringify({
  gestaltHead,
  sidecarHead,
  sources: sourceDocument,
}, undefined, 2) + '\n')

/** Return a currently unused loopback port. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })
  if (port === 0) throw new Error('Sub2API Electron e2e could not reserve a CDP port')
  return port
}

function publicSourceDocument(value) {
  const source = record(value)
  if (source === undefined) throw new Error('Sub2API source manifest must contain an object')
  const keys = ['bundleUrl', 'bundleSha256SumsUrl', 'runtimePackUrl', 'runtimePackSha256SumsUrl']
  return Object.fromEntries(keys.map((key) => {
    const raw = source[key]
    if (typeof raw !== 'string') throw new Error(`Sub2API source manifest ${key} must be a URL`)
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw new Error(`Sub2API source manifest ${key} must be a public HTTPS URL without credentials, query, or fragment`)
    }
    return [key, url.toString()]
  }))
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Run one child process and return its exit code. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`${command} exited on ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

/** Remove runtime credential overrides that would shadow the isolated home. */
function isolatedEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([name]) => (
    !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name)
    && !name.startsWith('DSH_PLATFORM_')
    && !name.startsWith('DSH_REMOTE_RELAY_')
  )))
}

if (process.platform === 'linux' && process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined) {
  process.stdout.write('skipping Sub2API Electron e2e: no GUI display is available\n')
  process.exit(0)
}
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  throw new Error('Sub2API Electron e2e supports macOS and Linux with a GUI display')
}

const buildEnvironment = {
  ...isolatedEnvironment(process.env),
  DSH_DESKTOP_OPERATED_PLATFORM_CONFIG: operatedPlatform,
}
for (const args of [
  ['run', 'build:lib:host'],
  ['run', 'build:lib:client'],
  ['run', 'build:web'],
]) {
  const buildCode = await run('pnpm', args, { env: buildEnvironment })
  if (buildCode !== 0) process.exit(buildCode)
}
const mainBuildCode = await run(process.execPath, [join(desktopRoot, 'scripts', 'build-main.mjs')], {
  cwd: desktopRoot,
  env: buildEnvironment,
})
if (mainBuildCode !== 0) process.exit(mainBuildCode)

const runExitCode = await withPrivateTempDirectory(join(tmpdir(), 'dsh445-e2e-'), async (runRoot) => {
const dshHome = join(runRoot, 'dsh-home')
const userData = join(runRoot, 'electron-user-data')
const webProfile = join(dshHome, 'profiles', 'web')
const smokeFile = join(artifactDir, 'main-smoke.log')
const cdpPort = await freePort()
await mkdir(dshHome, { recursive: true, mode: 0o700 })
await mkdir(userData, { recursive: true, mode: 0o700 })
await mkdir(webProfile, { recursive: true, mode: 0o700 })
await cp(credentialsSource, join(dshHome, '.credentials.yaml'))
await chmod(join(dshHome, '.credentials.yaml'), 0o600)
await writeFile(smokeFile, '')
await writeFile(join(dshHome, 'settings.yaml'), [
  'ui-onboarding:',
  '  welcomeNoticeVersion: "2026-08-13.1"',
  '',
].join('\n'), { mode: 0o600 })
await writeFile(join(webProfile, 'cordis.yml'), '[]\n', { mode: 0o600 })
await writeFile(join(webProfile, 'package.json'), JSON.stringify({
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, undefined, 2) + '\n', { mode: 0o600 })

const env = {
  ...isolatedEnvironment(process.env),
  CI: 'true',
  LANG: 'zh_CN.UTF-8',
  LANGUAGE: 'zh_CN',
  DSH_HOME: dshHome,
  DSH_NODE: process.execPath,
  DSH_DESKTOP_OPERATED_PLATFORM_CONFIG: operatedPlatform,
  DSH_DESKTOP_SUB2API_SOURCES: sourceManifest,
  DSH_SUB2API_E2E_RUN_ROOT: runRoot,
  DSH_SUB2API_E2E_USER_DATA: userData,
  DSH_SUB2API_E2E_CDP_PORT: String(cdpPort),
  DSH_SUB2API_E2E_ARTIFACT_DIR: artifactDir,
  DSH_DESKTOP_SMOKE_FILE: smokeFile,
  ELECTRON_ENABLE_LOGGING: '1',
}

const wdio = join(desktopRoot, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js')
let exitCode = 1
try {
  exitCode = await run(process.execPath, [wdio, 'run', join(e2eRoot, 'wdio.conf.ts')], {
    cwd: desktopRoot,
    env,
  })
} finally {
  const teardownErrors = []
  let ownedProcesses = []
  try { ownedProcesses = await readOwnedProcesses(artifactDir, exitCode === 0) } catch (error) { teardownErrors.push(error) }
  let rootProcesses = []
  try { rootProcesses = runRootProcesses(runRoot) } catch (error) { teardownErrors.push(error) }
  const cleanupProcesses = uniqueProcesses([...ownedProcesses, ...rootProcesses])
  const naturalSurvivors = await waitForNaturalProcessExit(cleanupProcesses)
  if (naturalSurvivors.length > 0) {
    teardownErrors.push(new Error(`product teardown left process(es) running: ${naturalSurvivors.map(item => item.pid).join(', ')}`))
  }
  let environmentProcessesStopped = false
  try { await terminateOwnedProcesses(cleanupProcesses) } catch (error) { teardownErrors.push(error) }
  try {
    await verifyOwnedProcessesStopped(cleanupProcesses)
    await verifyRunRootProcessesStopped(runRoot)
    environmentProcessesStopped = true
  } catch (error) { teardownErrors.push(error) }
  await captureArtifact(join(dshHome, 'sub2api', 'run'), join(artifactDir, 'run'), exitCode === 0, teardownErrors)
  await captureArtifact(join(dshHome, 'sub2api', 'data', 'logs'), join(artifactDir, 'data', 'logs'), false, teardownErrors)
  await captureArtifact(
    join(webProfile, 'node_modules', 'dsh-sub2api-sidecar', 'package.json'),
    join(artifactDir, 'installed-sidecar-package.json'),
    exitCode === 0,
    teardownErrors,
  )
  await captureArtifact(
    join(dshHome, 'sub2api', 'runtime', 'SHA256SUMS'),
    join(artifactDir, 'installed-runtime-sha256sums.txt'),
    exitCode === 0,
    teardownErrors,
  )
  let artifactsSecretFree = true
  try {
    await assertArtifactSecretsAbsent(artifactDir, credentialSecrets)
  } catch (error) {
    artifactsSecretFree = false
    teardownErrors.push(error)
    try {
      await rm(artifactDir, { recursive: true, force: true })
      await mkdir(artifactDir, { recursive: true })
    } catch (purgeError) {
      teardownErrors.push(new Error(`secret-bearing artifact purge failed: ${String(purgeError)}`))
    }
  }
  let runtimeRootRemoved = false
  await rm(runRoot, { recursive: true, force: true })
  try {
    await assertMissing(runRoot)
    runtimeRootRemoved = true
  } catch (error) { teardownErrors.push(error) }
  let cdpPortClosed = false
  try {
    await assertPortClosed(cdpPort)
    cdpPortClosed = true
  } catch (error) { teardownErrors.push(error) }
  await writeFile(join(artifactDir, 'cleanup.json'), JSON.stringify({
    productProcessesStoppedNaturally: naturalSurvivors.length === 0,
    forcedCleanupApplied: naturalSurvivors.length > 0,
    environmentProcessesStopped,
    artifactsSecretFree,
    runtimeRootRemoved,
    cdpPortClosed,
  }, undefined, 2) + '\n')
  if (teardownErrors.length > 0) throw new AggregateError(teardownErrors, 'Sub2API Electron e2e teardown failed')
}
return exitCode
})
process.exit(runExitCode)

async function readOwnedProcesses(dir, required) {
  let owned
  try {
    owned = JSON.parse(await readFile(join(dir, 'owned-processes.json'), 'utf8'))
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return []
    throw new Error(`owned-processes.json is required and valid: ${String(error)}`)
  }
  if (!Array.isArray(owned.processes) || owned.processes.some(item => (
    !Number.isSafeInteger(item?.pid) || item.pid <= 0 || typeof item.signature !== 'string' || item.signature.length === 0
  ))) {
    throw new Error('owned-processes.json contains an invalid process identity')
  }
  return owned.processes
}

async function verifyOwnedProcessesStopped(processes) {
  for (const process of processes) {
    await waitUntil(() => !processMatches(process), `owned process ${String(process.pid)} survived cleanup`)
  }
}

async function waitForNaturalProcessExit(processes) {
  const owned = processes.filter(item => item.pid !== process.pid)
  try {
    await waitUntil(() => owned.every(item => !processMatches(item)), 'product processes did not stop naturally', 10_000)
  } catch {
    // A natural-shutdown timeout is represented by the live PID set below.
  }
  return owned.filter(item => processMatches(item))
}

function runRootProcesses(root) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`process listing failed: ${result.stderr.trim()}`)
  const rows = result.stdout.trim().split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
  const pids = new Set(rows.filter(row => row.command.includes(root)).map(row => row.pid))
  for (;;) {
    const before = pids.size
    for (const row of rows) if (pids.has(row.ppid)) pids.add(row.pid)
    if (pids.size === before) return [...pids].map(processIdentity).filter(item => item !== undefined)
  }
}

async function terminateOwnedProcesses(processes) {
  const live = processes.filter(item => item.pid !== process.pid && processMatches(item))
  for (const item of live) signalProcess(item.pid, 'SIGTERM')
  try {
    await waitUntil(() => live.every(item => !processMatches(item)), 'owned processes ignored SIGTERM', 5_000)
    return
  } catch {
    // The subprocess contract escalates after a grace period; the E2E owner
    // mirrors that contract for a runner or Electron crash.
  }
  for (const item of live) if (processMatches(item)) signalProcess(item.pid, 'SIGKILL')
  await waitUntil(() => live.every(item => !processMatches(item)), 'owned processes ignored SIGKILL', 5_000)
}

function signalProcess(pid, signal) {
  try { process.kill(pid, signal) } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function verifyRunRootProcessesStopped(root) {
  await waitUntil(() => !spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout.includes(root),
    `a process still references ${root}`)
}

async function waitUntil(condition, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise(resolve => { setTimeout(resolve, 100) })
  if (!condition()) throw new Error(message)
}

async function captureArtifact(source, destination, required, errors) {
  try {
    await cp(source, destination, {
      recursive: true,
      filter: path => !/\.s\.PGSQL\.\d+(?:\.lock)?$/u.test(path) && path !== join(source, 'admin-password'),
    })
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return
    errors.push(new Error(`artifact capture failed for ${source}: ${String(error)}`))
  }
}

function processIdentity(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  const signature = result.stdout.trim()
  return signature === '' ? undefined : { pid, signature }
}

function processMatches(process) {
  return processIdentity(process.pid)?.signature === process.signature
}

function uniqueProcesses(processes) {
  return [...new Map(processes.map(process => [`${String(process.pid)}\0${process.signature}`, process])).values()]
}

async function assertMissing(path) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`temporary path survived cleanup: ${path}`)
}

async function assertPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`CDP port ${String(port)} is still open`)) })
    socket.once('error', () => { resolve() })
  })
}
