import { spawn, type ChildProcess } from 'node:child_process'
import { childEnv } from '@deepseek-ai/dsh-subprocess'

const STOP_GRACE_MS = 2_000

/** Independent exit facts from one bounded Xcode or simctl command. */
export interface IosCommandResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Spawn options for one Xcode or simctl command. */
export interface IosCommandOptions {
  readonly env: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Injectable process adapter used by production and official-layout fixtures. */
export interface IosCommandRunner {
  run(command: string, args: readonly string[], options: IosCommandOptions): Promise<IosCommandResult>
}

/** Create the direct-spawn iOS command adapter with credential scrubbing and quiescent cancellation. */
export function createNodeIosCommandRunner(): IosCommandRunner {
  return {
    run: async (command, args, options) => {
      options.signal?.throwIfAborted()
      const child = spawn(command, [...args], {
        env: childEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      })
      return await settleChild(child, options.signal, options.timeoutMs)
    },
  }
}

/** Production Xcode and simctl process adapter. */
export const nodeIosCommandRunner: IosCommandRunner = createNodeIosCommandRunner()

async function settleChild(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): Promise<IosCommandResult> {
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let escape: ReturnType<typeof setTimeout> | undefined
  child.stdout?.on('data', (chunk: Buffer) => { stdout = retain(stdout, chunk.toString('utf8')) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr = retain(stderr, chunk.toString('utf8')) })
  const terminate = (force: boolean): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const abort = (): void => {
    terminate(false)
    if (escape !== undefined) return
    escape = setTimeout(() => { terminate(true) }, STOP_GRACE_MS)
    escape.unref()
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted === true) abort()
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    abort()
  }, timeoutMs)
  timeout?.unref()
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, exitSignal) => { resolve({ code, signal: exitSignal, timedOut, stdout, stderr }) })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (timeout !== undefined) clearTimeout(timeout)
    if (escape !== undefined) clearTimeout(escape)
  }
}

function retain(current: string, addition: string): string {
  const joined = `${current}${addition}`
  return joined.length > 16_384 ? joined.slice(-16_384) : joined
}
