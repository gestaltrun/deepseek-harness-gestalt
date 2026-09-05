/**
 * Lifecycle owner for external mobilecli process trees. Every command runs
 * with the credential-scrubbed parent environment, and every requested stop
 * reaches bounded whole-tree quiescence or fails visibly.
 * @module @deepseek-ai/dsh-phone-runtime/server-process
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { childEnv } from '@deepseek-ai/dsh-subprocess'
import { PhoneDevicesError } from './errors.ts'

/** Stderr bytes retained for failure diagnostics. */
const STDERR_TAIL_BYTES = 4096

/** Milliseconds granted between `SIGTERM` and the escalating `SIGKILL`. */
export const TERM_ESCAPE_MS = 2_000

/** Bounded cross-generation diagnostic ring for tests and support triage. */
const DIAGNOSTIC_LINES = 40

/** Facts about how one owned process-tree launcher ended. */
export interface ServerExit {
  /** Exit code, or `null` when the process died by signal or never spawned. */
  readonly code: number | null
  /** Signal name when the process died by signal, otherwise `undefined`. */
  readonly signal?: NodeJS.Signals
}

/** Injectable process-tree operations used by native lifecycle tests. */
export interface ServerProcessInternals {
  readonly platform?: NodeJS.Platform
  readonly probeGroup?: (pid: number) => void
  readonly signalGroup?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  readonly taskkill?: (pid: number) => void
}

/** Failure to terminate an owned mobilecli process tree within its bounded policy. */
export class MobilecliProcessTreeError extends Error {
  override readonly name = 'MobilecliProcessTreeError'
}

/**
 * Keep at most the last {@link STDERR_TAIL_BYTES} bytes of accumulated output.
 * @param current - Previously retained tail.
 * @param addition - Newly received chunk.
 * @returns the retained tail.
 */
export function retainTail(current: string, addition: string): string {
  const joined = `${current}${addition}`
  return joined.length > STDERR_TAIL_BYTES ? joined.slice(joined.length - STDERR_TAIL_BYTES) : joined
}

/** Exit-and-stop handle used by one-shot agent and screenshot joins. */
export interface MobilecliTreeJoin {
  /** Settles exactly once with how the child ended. */
  readonly exit: Promise<ServerExit>
  /**
   * Bounded tree teardown. Callers may invoke this more than once; later
   * invocations observe the same settlement.
   * @returns quiescence of this tree generation.
   */
  stop(): Promise<void>
}

/**
 * Publish abort-driven `tree.stop()` immediately, join child exit, then halt if the budget aborted.
 * Callers keep halt classification and post-join error wrapping. This helper owns one memoized stop
 * publication (including already-aborted budgets), contains a synchronous `stop()` throw, and removes
 * the abort listener on every path. It does not invoke a second stop after exit.
 * @param tree - Spawned process tree exposing `exit` and `stop`.
 * @param budget - Fused caller-plus-ceiling signal.
 * @param halt - Public failure for an aborted run.
 * @returns the child's exit facts when the budget did not abort first.
 */
export async function awaitMobilecliTreeExit(
  tree: MobilecliTreeJoin,
  budget: AbortSignal,
  halt: () => PhoneDevicesError,
): Promise<ServerExit> {
  const stopped = Promise.withResolvers<void>()
  let stopPublished: Promise<void> | undefined
  const publishStop = (): Promise<void> => {
    if (stopPublished === undefined) {
      const publication = Promise.withResolvers<void>()
      stopPublished = publication.promise
      try {
        const stopping = tree.stop()
        void Promise.resolve(stopping).then(publication.resolve, publication.reject)
      } catch (error) {
        publication.reject(error)
      }
    }
    void stopPublished.then(stopped.resolve, stopped.reject)
    return stopPublished
  }
  const onAbort = (): void => {
    void publishStop()
  }
  budget.addEventListener('abort', onAbort, { once: true })
  try {
    if (budget.aborted) onAbort()
    const exit = await Promise.race([
      tree.exit,
      stopped.promise.then(() => tree.exit),
    ])
    if (budget.aborted) {
      await (stopPublished ?? publishStop())
      throw halt()
    }
    return exit
  } finally {
    budget.removeEventListener('abort', onAbort)
  }
}

function treePoll(): Promise<void> {
  return new Promise((resolveTimer) => { setTimeout(resolveTimer, 15) })
}

/**
 * One spawned mobilecli command tree. Construction starts the process
 * immediately; {@link MobilecliProcessTree.exit} settles exactly once whether
 * it starts, dies, or fails to spawn.
 */
export class MobilecliProcessTree {
  /** Most recent child stderr/error lines across generations, oldest first. */
  static readonly diagnostics: string[] = []

  /**
   * Append one diagnostic line to the bounded cross-generation ring.
   * @param line - stderr or spawn-error text retained for triage.
   * @internal Test and support triage sink; bounded.
   */
  static record(line: string): void {
    MobilecliProcessTree.diagnostics.push(line)
    if (MobilecliProcessTree.diagnostics.length > DIAGNOSTIC_LINES) {
      MobilecliProcessTree.diagnostics.splice(0, MobilecliProcessTree.diagnostics.length - DIAGNOSTIC_LINES)
    }
  }

  private readonly child: ChildProcess
  private readonly platform: NodeJS.Platform
  private readonly probeGroup: (pid: number) => void
  private readonly signalGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  private readonly taskkill: (pid: number) => void
  private settled = false
  private spawnFailure: NodeJS.ErrnoException | undefined
  private readonly exitSettlement: PromiseWithResolvers<ServerExit>
  private stderrTail = ''
  private stopOutcome: Promise<void> | undefined

  /** Spawn one mobilecli command in a process tree owned through quiescent teardown. */
  constructor(options: {
    readonly executablePath: string
    readonly args: readonly string[]
    readonly environment?: Readonly<Record<string, string>> | undefined
    readonly captureStdout?: boolean
  }, internals: ServerProcessInternals = {}) {
    this.exitSettlement = Promise.withResolvers<ServerExit>()
    this.platform = internals.platform ?? process.platform
    this.probeGroup = internals.probeGroup ?? ((pid) => { process.kill(-pid, 0) })
    this.signalGroup = internals.signalGroup ?? ((pid, signal) => { process.kill(-pid, signal) })
    this.taskkill = internals.taskkill ?? ((pid) => {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: TERM_ESCAPE_MS,
        killSignal: 'SIGKILL',
      })
      if (result.error !== undefined) {
        throw new MobilecliProcessTreeError(`taskkill did not complete for pid ${String(pid)}: ${result.error.message}`)
      }
      if (result.status !== 0) {
        const diagnostic = result.stderr.trim()
        throw new MobilecliProcessTreeError(
          `taskkill failed for pid ${String(pid)} with status ${String(result.status)}${diagnostic.length > 0 ? `: ${diagnostic}` : ''}`,
        )
      }
    })
    this.child = spawn(
      options.executablePath,
      [...options.args],
      {
        env: childEnv(options.environment),
        stdio: ['ignore', options.captureStdout === true ? 'pipe' : 'ignore', 'pipe'],
        windowsHide: true,
        detached: this.platform !== 'win32',
      },
    )
    MobilecliProcessTree.record(`spawn pid=${String(this.child.pid)} path=${JSON.stringify(options.executablePath)} args=${JSON.stringify(options.args)}`)
    // Resolving twice is a no-op, so a late error after an unlucky close is
    // harmless without a guard branch.
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      this.spawnFailure = error
      this.stderrTail = retainTail(this.stderrTail, `spawn failed: ${error.message}`)
      MobilecliProcessTree.record(`spawn error: ${error.message}`)
      this.settled = true
      this.exitSettlement.resolve({ code: null })
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = retainTail(this.stderrTail, text)
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) MobilecliProcessTree.record(line.trim())
      }
    })
    this.child.once('close', (code, signal) => {
      if (this.settled) return
      this.settled = true
      MobilecliProcessTree.record(`close code=${String(code)} signal=${String(signal)}`)
      this.exitSettlement.resolve(signal === null ? { code } : { code, signal })
    })
  }

  /**
   * Await the single settlement of this child generation.
   * @returns how the process ended; a non-null code means a real process ran and exited.
   */
  get exit(): Promise<ServerExit> {
    return this.exitSettlement.promise
  }

  /** Direct launcher process whose stdio belongs to the command-specific adapter. */
  get process(): ChildProcess {
    return this.child
  }

  /** Spawn failure retained separately from a launched command's exit facts. */
  get error(): NodeJS.ErrnoException | undefined {
    return this.spawnFailure
  }

  /**
   * Whether this generation still runs; false after the first error or close
   * event. This answers whether `listDevices` may answer at all.
   */
  get alive(): boolean {
    return this.treeAlive()
  }

  /**
   * Latest retained stderr text, at most {@link STDERR_TAIL_BYTES} bytes, for
   * diagnostics when readiness or liveness fails.
   */
  get lastStderr(): string {
    return this.stderrTail
  }

  /**
   * Stop the complete tree and await quiescence. POSIX grants SIGTERM one
   * {@link TERM_ESCAPE_MS} grace before SIGKILL; Windows performs one bounded
   * forced tree termination while the launcher identity is still live.
   */
  async stop(): Promise<void> {
    this.stopOutcome ??= this.stopOnce()
    try {
      await this.stopOutcome
    } catch (error) {
      this.stopOutcome = undefined
      throw error
    }
  }

  private async stopOnce(): Promise<void> {
    const pid = this.child.pid
    if (this.platform === 'win32') {
      await this.stopWindows(pid)
      return
    }
    const gracefulFailures: unknown[] = []
    if (this.treeAlive()) this.trySignal('SIGTERM', gracefulFailures)
    let exited = await this.waitForTreeExit(TERM_ESCAPE_MS)
    const forceFailures: unknown[] = []
    if (!exited) {
      this.trySignal('SIGKILL', forceFailures)
      exited = await this.waitForTreeExit(TERM_ESCAPE_MS)
    }
    const failures = [...forceFailures]
    if (!exited) {
      failures.unshift(...gracefulFailures)
      failures.push(new MobilecliProcessTreeError(
        `mobilecli process tree ${String(pid ?? 'without-pid')} survived SIGTERM and SIGKILL`,
      ))
    }
    await this.finishStop(exited, pid, failures)
  }

  private async stopWindows(pid: number | undefined): Promise<void> {
    if (this.settled && pid !== undefined && pid > 0) {
      throw new MobilecliProcessTreeError(
        `mobilecli launcher ${String(pid)} exited before its Windows process tree could be stopped safely`,
      )
    }
    const failures: unknown[] = []
    if (this.treeAlive()) this.trySignal('SIGKILL', failures)
    const exited = await this.waitForTreeExit(TERM_ESCAPE_MS)
    if (!exited) {
      failures.push(new MobilecliProcessTreeError(
        `mobilecli Windows process tree ${String(pid ?? 'without-pid')} survived forced termination`,
      ))
    }
    await this.finishStop(exited, pid, failures)
  }

  private async finishStop(exited: boolean, pid: number | undefined, failures: unknown[]): Promise<void> {
    if (exited && !this.settled) {
      const childSettled = await this.waitForChildSettlement(TERM_ESCAPE_MS)
      if (!childSettled) {
        failures.push(new MobilecliProcessTreeError(
          `mobilecli process tree ${String(pid)} exited without child settlement`,
        ))
      }
    }
    if (exited && this.settled) {
      this.child.stdout?.destroy()
      this.child.stderr?.destroy()
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'mobilecli process-tree stop failed')
  }

  private trySignal(signal: 'SIGTERM' | 'SIGKILL', failures: unknown[]): void {
    try {
      this.signalTree(signal)
    } catch (error) {
      failures.push(error)
      MobilecliProcessTree.record(`${signal} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private treeAlive(): boolean {
    const pid = this.child.pid
    if (pid === undefined || pid <= 0) return !this.settled
    if (this.platform === 'win32') return !this.settled
    try {
      this.probeGroup(pid)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      if (code === 'EPERM') return true
      return !this.settled
    }
  }

  private signalTree(signal: 'SIGTERM' | 'SIGKILL'): void {
    const pid = this.child.pid
    if (pid === undefined || pid <= 0) return
    if (this.platform === 'win32') {
      this.taskkill(pid)
      return
    }
    try {
      this.signalGroup(pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      this.child.kill(signal)
    }
  }

  private async waitForTreeExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.treeAlive()) {
      if (Date.now() >= deadline) return false
      await treePoll()
    }
    return true
  }

  private async waitForChildSettlement(timeoutMs: number): Promise<boolean> {
    const timeout = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => { timeout.resolve(false) }, timeoutMs)
    try {
      return await Promise.race([
        this.exitSettlement.promise.then(() => true),
        timeout.promise,
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Owned `mobilecli server start` generation bound to one loopback port. */
export class MobilecliServerProcess extends MobilecliProcessTree {
  /** Spawn the server command immediately. */
  constructor(options: {
    readonly executablePath: string
    readonly port: number
    readonly environment?: Readonly<Record<string, string>> | undefined
  }, internals: ServerProcessInternals = {}) {
    super({
      executablePath: options.executablePath,
      args: ['server', 'start', '--listen', `127.0.0.1:${String(options.port)}`],
      environment: options.environment,
    }, internals)
  }
}
