import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { childEnv } from '@deepseek-ai/dsh-subprocess'

const STOP_GRACE_MS = 2_000

/** Result of one bounded Android SDK command. */
export interface AndroidCommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly callerAborted: boolean
  readonly terminationError?: string
  readonly stdout: string
  readonly stderr: string
}

/** Spawn options shared by command and emulator process owners. */
export interface AndroidCommandOptions {
  readonly env: Readonly<Record<string, string>>
  readonly input?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Long-running Emulator generation owned by the Android environment Provider. */
export interface AndroidOwnedProcess {
  readonly pid: number | undefined
  readonly exit: Promise<AndroidCommandResult>
  stop(): Promise<void>
}

/** Process adapter used by production and official-layout fixtures. */
export interface AndroidCommandRunner {
  run(command: string, args: readonly string[], options: AndroidCommandOptions): Promise<AndroidCommandResult>
  spawn(command: string, args: readonly string[], options: AndroidCommandOptions): AndroidOwnedProcess
}

/** Injectable platform edge for deterministic process-tree tests. */
export interface AndroidProcessInternals {
  readonly platform?: NodeJS.Platform
  readonly taskkill?: (pid: number, force: boolean) => void
  /** Test-only stop grace; production uses two seconds per phase. */
  readonly stopGraceMs?: number
}

interface TerminationState { error: Error | undefined }

/** Executable and argv admitted to Node's direct process spawn. */
export interface AndroidSpawnSpec {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Resolve Windows SDK batch launchers through `cmd.exe`; native binaries stay
 * direct children on every platform. Android package ids and manager switches
 * are fixed product inputs, while unsafe command-expansion characters in an
 * installation path fail before reaching the shell.
 * @param command - absolute SDK tool path.
 * @param args - fixed manager or emulator arguments.
 * @param platform - target platform; production uses the current host.
 * @param commandProcessor - Windows command interpreter selected by the Host.
 * @returns the direct executable and argument vector for Node spawn.
 */
export function androidSpawnSpec(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  commandProcessor = process.env.ComSpec ?? 'cmd.exe',
): AndroidSpawnSpec {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(command)) return { command, args }
  const values = [command, ...args]
  for (const value of values) {
    if (/[\r\n"%!]/u.test(value)) {
      throw new Error('Android SDK batch command contains a Windows command-expansion character')
    }
  }
  const commandLine = `"${values.map(value => `"${value}"`).join(' ')}"`
  return { command: commandProcessor, args: ['/d', '/s', '/c', commandLine] }
}

/**
 * Create a process adapter with credential scrubbing, deadlines, and quiescent tree teardown.
 * @param internals - injectable platform and Windows tree-termination edges.
 * @returns the Android SDK and Emulator process adapter.
 */
export function createNodeAndroidCommandRunner(internals: AndroidProcessInternals = {}): AndroidCommandRunner {
  const platform = internals.platform ?? process.platform
  const taskkill = internals.taskkill ?? runTaskkill
  const stopGraceMs = internals.stopGraceMs ?? STOP_GRACE_MS
  return {
    run: async (command, args, options) => {
      const request = androidSpawnSpec(command, args, platform)
      const child = spawn(request.command, [...request.args], {
        env: childEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      })
      child.stdin.end(options.input)
      return await settleChild(child, options.signal, options.timeoutMs, platform, taskkill, stopGraceMs)
    },
    spawn: (command, args, options) => {
      const request = androidSpawnSpec(command, args, platform)
      const child = spawn(request.command, [...request.args], {
        env: childEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      })
      const termination: TerminationState = { error: undefined }
      const exit = settleChild(child, options.signal, undefined, platform, taskkill, stopGraceMs, termination)
      return {
        pid: child.pid,
        exit,
        stop: async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            await exit
            return
          }
          clearTerminationError(termination)
          if (child.exitCode === null && child.signalCode === null) {
            recordTerminationError(termination, terminate(child, 'SIGTERM', platform, taskkill))
          }
          let outcome = await boundedExit(exit, stopGraceMs)
          if (outcome === undefined && child.exitCode === null && child.signalCode === null) {
            recordTerminationError(termination, terminate(child, 'SIGKILL', platform, taskkill))
            outcome = await boundedExit(exit, stopGraceMs)
          }
          if (outcome === undefined) {
            throw new Error(termination.error?.message ?? `Android process ${String(child.pid)} did not exit after forced termination`)
          }
          if (outcome.terminationError !== undefined) throw new Error(outcome.terminationError)
        },
      }
    },
  }
}

/** Production process adapter with credential scrubbing, deadlines, and quiescent teardown. */
export const nodeAndroidCommandRunner: AndroidCommandRunner = createNodeAndroidCommandRunner()

async function settleChild(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs?: number,
  platform: NodeJS.Platform = process.platform,
  taskkill: (pid: number, force: boolean) => void = runTaskkill,
  stopGraceMs = STOP_GRACE_MS,
  termination: TerminationState = { error: undefined },
): Promise<AndroidCommandResult> {
  let stdout = ''
  let stderr = ''
  let escape: ReturnType<typeof setTimeout> | undefined
  let abandon: ReturnType<typeof setTimeout> | undefined
  let resolvePending: ((result: AndroidCommandResult) => void) | undefined
  let timedOut = false
  let callerAborted = false
  child.stdout?.on('data', (chunk: Buffer) => { stdout = retain(stdout, chunk.toString('utf8')) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr = retain(stderr, chunk.toString('utf8')) })
  const terminateGracefully = (): void => {
    recordTerminationError(termination, terminate(child, 'SIGTERM', platform, taskkill))
    if (escape !== undefined) return
    escape = setTimeout(() => {
      recordTerminationError(termination, terminate(child, 'SIGKILL', platform, taskkill))
      abandon = setTimeout(() => {
        recordTerminationError(termination, new Error(
          `Android process ${String(child.pid)} did not exit after forced termination`,
        ))
        resolvePending?.(resultOf(null, null))
      }, stopGraceMs)
      abandon.unref()
    }, stopGraceMs)
    escape.unref()
  }
  const resultOf = (exitCode: number | null, exitSignal: NodeJS.Signals | null): AndroidCommandResult => ({
    exitCode, signal: exitSignal, timedOut, callerAborted,
    ...(termination.error === undefined ? {} : { terminationError: termination.error.message }),
    stdout, stderr,
  })
  const abort = (): void => { callerAborted = true; terminateGracefully() }
  const expire = (): void => { timedOut = true; terminateGracefully() }
  if (signal?.aborted === true) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = timeoutMs === undefined ? undefined : setTimeout(expire, timeoutMs)
  timeout?.unref()
  try {
    return await new Promise((resolve, reject) => {
      resolvePending = resolve
      child.once('error', reject)
      child.once('close', (exitCode, exitSignal) => {
        resolve(resultOf(exitCode, exitSignal))
      })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (timeout !== undefined) clearTimeout(timeout)
    if (escape !== undefined) clearTimeout(escape)
    if (abandon !== undefined) clearTimeout(abandon)
    resolvePending = undefined
  }
}

function terminate(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  taskkill: (pid: number, force: boolean) => void,
): Error | undefined {
  if (child.pid === undefined) return undefined
  if (platform === 'win32') {
    try {
      taskkill(child.pid, signal === 'SIGKILL')
      return undefined
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }
  else {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return error instanceof Error ? error : new Error(String(error))
      }
    }
  }
  return undefined
}

function runTaskkill(pid: number, force: boolean): void {
  const result = spawnSync('taskkill', windowsTaskkillArgs(pid, force), {
    stdio: 'ignore', windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`taskkill exited with ${String(result.status)}${result.signal === null ? '' : ` by ${result.signal}`}`)
  }
}

/**
 * Build the Windows whole-tree termination request used for normal and forced
 * emulator teardown.
 * @param pid - direct child process id.
 * @param force - include `/F` after the normal teardown grace elapses.
 * @returns taskkill arguments targeting the complete child tree.
 */
export function windowsTaskkillArgs(pid: number, force: boolean): readonly string[] {
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
}

function retain(current: string, addition: string): string {
  const joined = `${current}${addition}`
  return joined.length > 8_192 ? joined.slice(-8_192) : joined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

async function boundedExit(exit: Promise<AndroidCommandResult>, ms: number): Promise<AndroidCommandResult | undefined> {
  return await Promise.race([exit, delay(ms).then(() => undefined)])
}

function recordTerminationError(state: TerminationState, error: Error | undefined): void {
  if (error !== undefined && state.error === undefined) state.error = error
}

function clearTerminationError(state: TerminationState): void {
  state.error = undefined
}
