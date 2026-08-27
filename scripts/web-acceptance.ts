/** Supervise one isolated built-Web acceptance environment for human or Ego testing. */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  readClientBuildRecord,
  repositoryCommitHash,
} from './client-build-environment.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const SIDEBAR_MODULE_ID = '@deepseek-ai/dsh-client-ui-sidebar'
const READY_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)\b/u
const ACCEPTANCE_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 15_000
const TERMINATION_GRACE_MS = 10_000

/** Public status printed for the current isolated acceptance Server. */
export interface WebAcceptanceStatus {
  /** Full repository commit served by this run. */
  commit: string
  /** Revision expected in the visible Sidebar footer. */
  visibleRevision: string
  /** Exact child process id. */
  pid: number
  /** Loopback URL announced after Loader settlement. */
  url: string
  /** Registered disposable Workspace id. */
  workspaceId: string
  /** Disposable Workspace path. */
  workspacePath: string
}

interface WorkspaceCreateValue {
  workspace: { workspaceId: string }
  created: boolean
}

interface WebBootGraph {
  entries: { id: string; url: string }[]
}

/** Reject a working tree whose acceptance evidence could not name one commit. */
export function assertCleanCommittedHead(root: string): string {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (status.trim().length > 0) {
    throw new Error('accept:web requires a clean committed worktree')
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

/** Parse the Server-injected boot graph without executing page JavaScript. */
export function parseBootGraph(html: string): WebBootGraph {
  const prefix = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(prefix)
  if (start < 0) throw new Error('accept:web: served page omitted window.__DSH_BOOT__')
  const valueStart = start + prefix.length
  const end = html.indexOf('</script>', valueStart)
  if (end < 0) throw new Error('accept:web: served boot graph script was unterminated')
  const parsed = JSON.parse(html.slice(valueStart, end)) as unknown
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as WebBootGraph).entries)) {
    throw new Error('accept:web: served boot graph had an invalid schema')
  }
  const entries = (parsed as WebBootGraph).entries
  if (!entries.every(entry => typeof entry.id === 'string' && typeof entry.url === 'string')) {
    throw new Error('accept:web: served boot graph entries had an invalid schema')
  }
  return { entries }
}

/** Verify that the served Sidebar bundle embeds the commit in the current build record. */
export async function verifyServedRevision(baseUrl: string, revision: string): Promise<void> {
  const page = await fetch(baseUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!page.ok) throw new Error(`accept:web: page request failed with HTTP ${page.status}`)
  const graph = parseBootGraph(await page.text())
  const sidebar = graph.entries.find(entry => entry.id === SIDEBAR_MODULE_ID)
  if (sidebar === undefined) throw new Error(`accept:web: served boot graph omitted ${SIDEBAR_MODULE_ID}`)
  const bundle = await fetch(new URL(sidebar.url, baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!bundle.ok) throw new Error(`accept:web: Sidebar bundle request failed with HTTP ${bundle.status}`)
  if (!(await bundle.text()).includes(revision)) {
    throw new Error(`accept:web: served Sidebar bundle does not contain revision ${revision}`)
  }
}

/** Copy only the two model configuration files explicitly approved for acceptance. */
export function copyModelConfiguration(sourceHome: string, targetHome: string): string[] {
  const copied: string[] = []
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const source = join(sourceHome, name)
    if (!existsSync(source)) continue
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
      throw new Error(`accept:web refuses non-regular model configuration: ${source}`)
    }
    const target = join(targetHome, name)
    copyFileSync(source, target)
    chmodSync(target, 0o600)
    copied.push(name)
  }
  return copied
}

async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `accept-web-${method}`, method, payload }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`accept:web: ${method} failed over HTTP ${response.status}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) {
    throw new Error(`accept:web: ${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  }
  return body.result.value
}

function ensureCurrentBuild(root: string): string {
  const expected = { DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(root, {}) }
  try {
    readClientBuildRecord(root, expected)
  } catch {
    const invocation = pnpmInvocation(['run', 'build'], process.env)
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      env: scrubbedParentEnv(),
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`accept:web: build exited with ${String(result.status ?? result.signal)}`)
    readClientBuildRecord(root, expected)
  }
  return expected.DSH_CLIENT_COMMIT_HASH
}

function logChildOutput(child: ChildProcessWithoutNullStreams, logFd: number): void {
  const write = (chunk: Buffer): void => { writeSync(logFd, chunk) }
  child.stdout.on('data', write)
  child.stderr.on('data', write)
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      child.stdout.off('data', consume)
      child.stderr.off('data', consume)
      child.off('exit', onExit)
    }
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const timeout = setTimeout(() => {
      finish(() => { reject(new Error('accept:web: Server did not become ready within 90 seconds')) })
    }, ACCEPTANCE_TIMEOUT_MS)
    const consume = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-16_384)
      const readyUrl = READY_LINE.exec(output)?.[1]
      if (readyUrl !== undefined) {
        finish(() => { resolveReady(readyUrl) })
      }
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(() => { reject(new Error(`accept:web: Server exited before readiness (${String(code ?? signal)})`)) })
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('exit', onExit)
  })
}

function waitWithin(promise: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => { rejectWait(new Error(message)) }, timeoutMs)
    promise.then(
      () => { clearTimeout(timeout); resolveWait() },
      (error: unknown) => {
        clearTimeout(timeout)
        rejectWait(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function stopChild(child: ChildProcessWithoutNullStreams, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  try {
    await waitWithin(closed, TERMINATION_GRACE_MS, 'SIGTERM grace expired')
  } catch {
    child.kill('SIGKILL')
    await waitWithin(closed, TERMINATION_GRACE_MS, 'accept:web: Server did not close after SIGKILL')
  }
}

async function assertUrlClosed(url: string): Promise<void> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) })
  } catch {
    return
  }
  throw new Error(`accept:web: Server URL remained reachable after process exit: ${url}`)
}

/** Own one disposable Web Server and Workspace until `stop()` completes. */
export class WebAcceptanceSupervisor {
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private statusValue: WebAcceptanceStatus | undefined
  private readonly tempRoot: string
  private readonly dshHome: string
  private readonly workspace: string
  private readonly agentsHome: string
  private readonly bundledSkills: string
  private readonly logFd: number
  private readonly commit: string
  private readonly revision: string
  private stopped = false
  private stopping: Promise<void> | undefined
  private logClosed = false
  private shutdownRequested = false

  constructor(
    private readonly root: string,
    options: { copyModelConfig?: boolean } = {},
  ) {
    this.commit = assertCleanCommittedHead(root)
    this.revision = ensureCurrentBuild(root)
    const commitAfterBuild = assertCleanCommittedHead(root)
    if (commitAfterBuild !== this.commit) {
      throw new Error(`accept:web: HEAD changed during build from ${this.commit} to ${commitAfterBuild}`)
    }
    if (!this.commit.startsWith(this.revision)) {
      throw new Error(`accept:web: build revision ${this.revision} does not match HEAD ${this.commit}`)
    }
    this.tempRoot = mkdtempSync(join(tmpdir(), 'dsh-web-acceptance-'))
    chmodSync(this.tempRoot, 0o700)
    this.dshHome = join(this.tempRoot, 'home')
    this.workspace = join(this.tempRoot, 'workspace')
    this.agentsHome = join(this.tempRoot, 'agents')
    this.bundledSkills = join(this.tempRoot, 'bundled-skills')
    for (const directory of [this.dshHome, this.workspace, this.agentsHome, this.bundledSkills]) {
      mkdirSync(directory, { mode: 0o700 })
    }
    this.logFd = openSync(join(this.tempRoot, 'server.log'), 'a', 0o600)
    if (options.copyModelConfig === true) {
      try {
        copyModelConfiguration(resolveDshHome(), this.dshHome)
      } catch (error) {
        closeSync(this.logFd)
        removeFixtureSafely(this.tempRoot)
        throw error
      }
    }
  }

  /** Start the built Server and register the disposable Workspace. */
  async start(port = 0): Promise<WebAcceptanceStatus> {
    if (this.shutdownRequested) throw new Error('accept:web: Supervisor is stopping')
    if (this.child !== undefined) throw new Error('accept:web: Server is already running')
    const currentCommit = assertCleanCommittedHead(this.root)
    if (currentCommit !== this.commit) {
      throw new Error(`accept:web: current HEAD ${currentCommit} differs from accepted commit ${this.commit}`)
    }
    readClientBuildRecord(this.root, { DSH_CLIENT_COMMIT_HASH: this.revision })
    const child = spawn(process.execPath, [
      join(this.root, 'apps/cli/lib/bin.js'),
      'web', '--no-open', '--port', String(port),
    ], {
      cwd: this.workspace,
      env: {
        ...scrubbedParentEnv(),
        DSH_HOME: this.dshHome,
        DSH_AGENTS_HOME: this.agentsHome,
        DSH_BUNDLED_SKILL_DIR: this.bundledSkills,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.childClosed = new Promise<void>(resolveClosed => child.once('close', () => { resolveClosed() }))
    logChildOutput(child, this.logFd)
    const url = await waitForReady(child)
    this.assertNotStopping()
    await verifyServedRevision(url, this.revision)
    this.assertNotStopping()
    const created = await rpc<WorkspaceCreateValue>(url, 'workspace.create', { path: this.workspace })
    this.assertNotStopping()
    if (child.pid === undefined) throw new Error('accept:web: Server did not expose a process id')
    this.statusValue = {
      commit: this.commit,
      visibleRevision: this.revision,
      pid: child.pid,
      url,
      workspaceId: created.workspace.workspaceId,
      workspacePath: this.workspace,
    }
    return this.statusValue
  }

  /** Return the current Server identity. */
  status(): WebAcceptanceStatus {
    if (this.statusValue === undefined) throw new Error('accept:web: Server is not running')
    return this.statusValue
  }

  /** Restart the exact owned child while retaining the isolated Home and Workspace. */
  async restart(port = 0): Promise<WebAcceptanceStatus> {
    if (this.shutdownRequested) throw new Error('accept:web: Supervisor is stopping')
    if (this.child === undefined || this.childClosed === undefined) throw new Error('accept:web: Server is not running')
    const currentCommit = assertCleanCommittedHead(this.root)
    if (currentCommit !== this.commit) {
      throw new Error(`accept:web: current HEAD ${currentCommit} differs from accepted commit ${this.commit}`)
    }
    readClientBuildRecord(this.root, { DSH_CLIENT_COMMIT_HASH: this.revision })
    const oldUrl = this.statusValue?.url
    await stopChild(this.child, this.childClosed)
    if (oldUrl !== undefined) await assertUrlClosed(oldUrl)
    this.child = undefined
    this.childClosed = undefined
    this.statusValue = undefined
    return this.start(port)
  }

  /** Stop the exact owned child and delete only its disposable root. */
  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.shutdownRequested = true
    this.stopping ??= this.stopOnce().finally(() => { this.stopping = undefined })
    return this.stopping
  }

  private async stopOnce(): Promise<void> {
    const errors: unknown[] = []
    const status = this.statusValue
    if (status !== undefined) {
      try {
        await rpc(status.url, 'workspace.delete', { workspaceId: status.workspaceId })
      } catch (error) {
        errors.push(error)
      }
    }
    if (this.child !== undefined && this.childClosed !== undefined) {
      try {
        await stopChild(this.child, this.childClosed)
        if (status !== undefined) await assertUrlClosed(status.url)
        this.child = undefined
        this.childClosed = undefined
      } catch (error) {
        errors.push(error)
      }
    }
    this.statusValue = undefined
    if (this.child === undefined && !this.logClosed) {
      try {
        closeSync(this.logFd)
        this.logClosed = true
      } catch (error) {
        errors.push(error)
      }
    }
    if (this.child === undefined && this.logClosed) {
      try { removeFixtureSafely(this.tempRoot) } catch (error) { errors.push(error) }
    }
    this.stopped = this.child === undefined && !existsSync(this.tempRoot)
    if (errors.length > 0) throw new AggregateError(errors, 'accept:web cleanup failed')
  }

  /** Force-kill only the exact owned Server after a repeated termination signal. */
  forceStop(): void {
    this.child?.kill('SIGKILL')
  }

  private assertNotStopping(): void {
    if (this.shutdownRequested) throw new Error('accept:web: Supervisor is stopping')
  }
}

function printStatus(status: WebAcceptanceStatus): void {
  console.log(JSON.stringify(status, null, 2))
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'copy-model-config': { type: 'boolean', default: false } },
    allowPositionals: false,
  })
  const root = resolve(import.meta.dirname, '..')
  const supervisor = new WebAcceptanceSupervisor(root, { copyModelConfig: values['copy-model-config'] })
  let lines: ReturnType<typeof createInterface> | undefined
  let signalCount = 0
  const onTerminationSignal = (): void => {
    signalCount += 1
    if (signalCount > 1) {
      supervisor.forceStop()
      process.exit(1)
    }
    lines?.close()
    void supervisor.stop().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
  }
  process.on('SIGINT', onTerminationSignal)
  process.on('SIGTERM', onTerminationSignal)
  try {
    printStatus(await supervisor.start())
    console.log('accept:web commands: status | restart [port] | stop')
    lines = createInterface({ input: process.stdin, terminal: process.stdin.isTTY })
    for await (const raw of lines) {
      const [command, portText, extra] = raw.trim().split(/\s+/u)
      try {
        if (command === '' || command === undefined) continue
        if (command === 'status' && portText === undefined) printStatus(supervisor.status())
        else if (command === 'restart' && extra === undefined) {
          const port = portText === undefined ? 0 : Number(portText)
          if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('restart port must be 0..65535')
          printStatus(await supervisor.restart(port))
        } else if (command === 'stop' && portText === undefined) {
          lines.close()
        } else {
          throw new Error('expected status, restart [port], or stop')
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    process.off('SIGINT', onTerminationSignal)
    process.off('SIGTERM', onTerminationSignal)
    await supervisor.stop()
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
