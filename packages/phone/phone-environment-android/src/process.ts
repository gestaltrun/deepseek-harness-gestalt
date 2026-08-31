import { spawn, type ChildProcess } from 'node:child_process'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const STOP_GRACE_MS = 2_000

/** Result of one bounded Android SDK command. */
export interface AndroidCommandResult {
  readonly code: number | null
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

/** Production process adapter with credential scrubbing, deadlines, and quiescent teardown. */
export const nodeAndroidCommandRunner: AndroidCommandRunner = {
  run: async (command, args, options) => {
    const child = spawn(command, [...args], {
      env: { ...scrubbedParentEnv(), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdin.end(options.input)
    return await settleChild(child, options.signal, options.timeoutMs)
  },
  spawn: (command, args, options) => {
    const child = spawn(command, [...args], {
      env: { ...scrubbedParentEnv(), ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const exit = settleChild(child, options.signal)
    return {
      pid: child.pid,
      exit,
      stop: async () => {
        if (child.exitCode === null && child.signalCode === null) terminate(child, 'SIGTERM')
        await Promise.race([exit, delay(STOP_GRACE_MS)])
        if (child.exitCode === null && child.signalCode === null) terminate(child, 'SIGKILL')
        await exit
      },
    }
  },
}

async function settleChild(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): Promise<AndroidCommandResult> {
  let stdout = ''
  let stderr = ''
  let escape: ReturnType<typeof setTimeout> | undefined
  child.stdout?.on('data', (chunk: Buffer) => { stdout = retain(stdout, chunk.toString('utf8')) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr = retain(stderr, chunk.toString('utf8')) })
  const abort = (): void => {
    terminate(child, 'SIGTERM')
    if (escape !== undefined) return
    escape = setTimeout(() => { terminate(child, 'SIGKILL') }, STOP_GRACE_MS)
    escape.unref()
  }
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs)
  timeout?.unref()
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => { resolve({ code, stdout, stderr }) })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (timeout !== undefined) clearTimeout(timeout)
    if (escape !== undefined) clearTimeout(escape)
  }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') child.kill(signal)
  else {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
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
