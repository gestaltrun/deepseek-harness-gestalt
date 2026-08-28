/**
 * Lifecycle owner of the spawned external `mobilecli server start` child
 * process. The process is bound to an explicit loopback address, runs with the
 * credential-scrubbed parent environment, and every teardown reaches child-exit
 * quiescence before returning.
 * @module @deepseek-ai/dsh-phone-runtime/server-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Stderr bytes retained for failure diagnostics. */
const STDERR_TAIL_BYTES = 4096

/** Milliseconds granted between `SIGTERM` and the escalating `SIGKILL`. */
const TERM_ESCAPE_MS = 2_000

/** Bounded cross-generation diagnostic ring for tests and support triage. */
const DIAGNOSTIC_LINES = 40

/** Facts about how one child generation ended. */
export interface ServerExit {
  /** Exit code, or `null` when the process died by signal or never spawned. */
  readonly code: number | null
  /** Signal name when the process died by signal, otherwise `undefined`. */
  readonly signal?: NodeJS.Signals
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveTimer) => {
    const timer = setTimeout(resolveTimer, ms)
    timer.unref()
  })
}

/**
 * One spawned mobilecli server child generation. Construction starts the
 * process immediately; {@link MobilecliServerProcess.exit} settles exactly once
 * whether it starts, dies, or fails to spawn.
 */
export class MobilecliServerProcess {
  /** Most recent child stderr/error lines across generations, oldest first. */
  static readonly diagnostics: string[] = []

  /** @internal Test and support triage sink; bounded. */
  static record(line: string): void {
    MobilecliServerProcess.diagnostics.push(line)
    if (MobilecliServerProcess.diagnostics.length > DIAGNOSTIC_LINES) {
      MobilecliServerProcess.diagnostics.splice(0, MobilecliServerProcess.diagnostics.length - DIAGNOSTIC_LINES)
    }
  }

  private readonly child: ChildProcess
  private settled = false
  private readonly exitSettlement: PromiseWithResolvers<ServerExit>
  private stderrTail = ''

  /**
   * Spawn `mobilecli server start --listen 127.0.0.1:<port>`.
   * @param options - Absolute executable path and the validated loopback port.
   */
  constructor(options: { readonly executablePath: string; readonly port: number }) {
    this.exitSettlement = Promise.withResolvers<ServerExit>()
    this.child = spawn(
      options.executablePath,
      ['server', 'start', '--listen', `127.0.0.1:${String(options.port)}`],
      {
        env: scrubbedParentEnv(),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    )
    MobilecliServerProcess.record(`spawn pid=${String(this.child.pid)} path=${JSON.stringify(options.executablePath)} port=${String(options.port)}`)
    // Resolving twice is a no-op, so a late error after an unlucky close is
    // harmless without a guard branch.
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      this.stderrTail = retainTail(this.stderrTail, `spawn failed: ${error.message}`)
      MobilecliServerProcess.record(`spawn error: ${error.message}`)
      this.settled = true
      this.exitSettlement.resolve({ code: null })
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = retainTail(this.stderrTail, text)
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) MobilecliServerProcess.record(line.trim())
      }
    })
    this.child.once('close', (code, signal) => {
      if (this.settled) return
      this.settled = true
      MobilecliServerProcess.record(`close code=${String(code)} signal=${String(signal)}`)
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

  /**
   * Whether this generation still runs; false after the first error or close
   * event. This answers whether `listDevices` may answer at all.
   */
  get alive(): boolean {
    return !this.settled
  }

  /**
   * Latest retained stderr text, at most {@link STDERR_TAIL_BYTES} bytes, for
   * diagnostics when readiness or liveness fails.
   */
  get lastStderr(): string {
    return this.stderrTail
  }

  /**
   * Stop the child and wait until it is gone: `SIGTERM`, then one `SIGKILL`
   * escape after {@link TERM_ESCAPE_MS}, then full exit quiescence.
   */
  async stop(): Promise<void> {
    const child = this.child
    if (!this.settled) child.kill('SIGTERM')
    await Promise.race([this.exitSettlement.promise, delay(TERM_ESCAPE_MS)])
    if (!this.settled) child.kill('SIGKILL')
    await this.exitSettlement.promise
    child.stderr?.destroy()
  }
}
