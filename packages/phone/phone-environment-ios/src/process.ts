import { spawn, type ChildProcess } from 'node:child_process'
import { childEnv } from '@deepseek-ai/dsh-subprocess'

const STOP_GRACE_MS = 2_000
const DEFAULT_STDOUT_MAX_BYTES = 16_384
const STDERR_TAIL_BYTES = 16_384

/** Independent exit facts from one bounded Xcode or simctl command. */
export interface IosCommandResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly terminationError?: string
  readonly stdout: string
  readonly stderr: string
}

/** Spawn options for one Xcode or simctl command. */
export interface IosCommandOptions {
  readonly env: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** Maximum stdout bytes retained before the child is terminated fail-loud. */
  readonly stdoutMaxBytes?: number
}

/** Injectable process adapter used by production and official-layout fixtures. */
export interface IosCommandRunner {
  run(command: string, args: readonly string[], options: IosCommandOptions): Promise<IosCommandResult>
}

/** Injectable process-tree edges for bounded termination tests. */
export interface IosProcessInternals {
  /** Test-only grace per termination phase; production uses two seconds. */
  readonly stopGraceMs?: number
  /** Test-only process-group signal edge. */
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Create the direct-spawn iOS command adapter with credential scrubbing and quiescent cancellation.
 * @param internals - injectable stop grace and process-group signal edge.
 * @returns the production-capable Xcode and simctl command runner.
 */
export function createNodeIosCommandRunner(internals: IosProcessInternals = {}): IosCommandRunner {
  const stopGraceMs = internals.stopGraceMs ?? STOP_GRACE_MS
  const killProcessGroup = internals.killProcessGroup ?? ((pid, signal) => { process.kill(-pid, signal) })
  return {
    run: async (command, args, options) => {
      options.signal?.throwIfAborted()
      const stdoutMaxBytes = options.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
      if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes < 1) {
        throw new TypeError('iOS command stdoutMaxBytes must be a positive safe integer')
      }
      const child = spawn(command, [...args], {
        env: childEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      })
      return await settleChild(
        child, options.signal, options.timeoutMs, stdoutMaxBytes,
        stopGraceMs, killProcessGroup,
      )
    },
  }
}

/** Production Xcode and simctl process adapter. */
export const nodeIosCommandRunner: IosCommandRunner = createNodeIosCommandRunner()

async function settleChild(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  stdoutMaxBytes: number,
  stopGraceMs: number,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
): Promise<IosCommandResult> {
  const stdoutChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrTail = Buffer.alloc(0)
  let timedOut = false
  let escape: ReturnType<typeof setTimeout> | undefined
  let abandon: ReturnType<typeof setTimeout> | undefined
  let resolvePending: ((result: IosCommandResult) => void) | undefined
  let terminationError: Error | undefined
  const resultOf = (code: number | null, exitSignal: NodeJS.Signals | null): IosCommandResult => ({
    code, signal: exitSignal, timedOut,
    ...(terminationError === undefined ? {} : { terminationError: terminationError.message }),
    stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
    stderr: decodeUtf8Tail(stderrTail),
  })
  const recordTerminationError = (error: unknown): void => {
    if (terminationError !== undefined || error === undefined) return
    terminationError = error instanceof Error
      ? error
      : new Error('iOS process termination failed with a non-Error reason', { cause: error })
  }
  const terminate = (exitSignal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try { killProcessGroup(child.pid, exitSignal) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') recordTerminationError(error)
    }
  }
  const abort = (): void => {
    terminate('SIGTERM')
    if (escape !== undefined) return
    escape = setTimeout(() => {
      terminate('SIGKILL')
      abandon = setTimeout(() => {
        recordTerminationError(new Error(`iOS process ${String(child.pid)} did not exit after forced termination`))
        resolvePending?.(resultOf(null, null))
      }, stopGraceMs)
      abandon.unref()
    }, stopGraceMs)
    escape.unref()
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    if (terminationError !== undefined) return
    if (stdoutBytes + chunk.byteLength > stdoutMaxBytes) {
      recordTerminationError(new Error(`iOS command stdout exceeded ${String(stdoutMaxBytes)} bytes`))
      abort()
      return
    }
    stdoutChunks.push(chunk)
    stdoutBytes += chunk.byteLength
  })
  child.stderr?.on('data', (chunk: Buffer) => { stderrTail = retainTail(stderrTail, chunk, STDERR_TAIL_BYTES) })
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
      resolvePending = resolve
      child.once('close', (code, exitSignal) => { resolve(resultOf(code, exitSignal)) })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (timeout !== undefined) clearTimeout(timeout)
    if (escape !== undefined) clearTimeout(escape)
    if (abandon !== undefined) clearTimeout(abandon)
    resolvePending = undefined
  }
}

function retainTail(current: Buffer, addition: Buffer, maxBytes: number): Buffer {
  const joined = Buffer.concat([current, addition], current.byteLength + addition.byteLength)
  return joined.byteLength > maxBytes ? joined.subarray(joined.byteLength - maxBytes) : joined
}

function decodeUtf8Tail(value: Buffer): string {
  let start = 0
  while (start < value.byteLength) {
    if ((value.readUInt8(start) & 0xc0) !== 0x80) break
    start += 1
  }
  return value.subarray(start).toString('utf8')
}
