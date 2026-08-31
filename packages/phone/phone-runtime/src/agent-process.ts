/**
 * One-shot runner for the external mobilecli `agent status` and `agent
 * install` commands against the user's installed executable. The runner never
 * downloads or vendors agent artifacts — the upstream command owns that — and
 * every run is bounded by a validated ceiling plus the caller's signal, with
 * failures normalized onto the public vocabulary and classified onto the
 * structured real-device arms where the output names one.
 * @module @deepseek-ai/dsh-phone-runtime/agent-process
 */

import { spawn } from 'node:child_process'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { deadline, TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { realDeviceIssueError } from './classify.ts'
import { PhoneDevicesError } from './errors.ts'
import { normalizeOperationError } from './rpc.ts'
import { retainTail, TERM_ESCAPE_MS } from './server-process.ts'
import type { PhoneAgentInfo } from './types.ts'

/** One parsed upstream agent command answer. */
export interface MobilecliAgentAnswer {
  /** True only when the upstream `status` field is `ok`. */
  readonly ok: boolean
  /** Upstream human-readable message, empty when the answer carries none. */
  readonly message: string
  /** Installed agent identity; absent while the answer reports none. */
  readonly agent?: PhoneAgentInfo
}

/** Inputs for one agent command run. */
export interface MobilecliAgentRunOptions {
  /** Absolute mobilecli executable path resolved at Service construction. */
  readonly executablePath: string
  /** Full argument vector starting at the `agent` subcommand. */
  readonly args: readonly string[]
  /** Caller's optional cancellation signal, fused with the run ceiling. */
  readonly signal: AbortSignal | undefined
  /** Validated ceiling bounding the child run, in milliseconds. */
  readonly timeoutMs: number
  /** Non-sensitive runtime environment selected with the executable generation. */
  readonly environment?: Readonly<Record<string, string>>
}

/**
 * Run one mobilecli agent command to child-exit quiescence and parse its
 * trailing JSON answer. A zero exit without parsable agent JSON is a protocol
 * failure; a non-zero exit is classified onto a structured real-device arm
 * when the output names one, and `PHONE_UPSTREAM` otherwise.
 * @param options - Executable path, argument vector, cancellation, and ceiling.
 * @returns the parsed upstream answer.
 * @throws {@link PhoneDevicesError} with `PHONE_ABORTED` when the caller's signal
 *   won, `PHONE_TIMEOUT` when the ceiling elapsed, `PHONE_REAL_DEVICE_ISSUE`
 *   carrying the matched arm, `PHONE_UPSTREAM` for other non-zero exits,
 *   `PHONE_PROTOCOL` for unparseable answers, and `PHONE_UNAVAILABLE` when the
 *   executable cannot start.
 */
export async function runMobilecliAgent(options: MobilecliAgentRunOptions): Promise<MobilecliAgentAnswer> {
  if (options.signal?.aborted === true) {
    throw new PhoneDevicesError('PHONE_ABORTED', 'cancelled before the agent command was sent')
  }
  const label = options.args[1] === 'install' ? 'agent install' : 'agent status'
  const budget = deadline(options.signal, options.timeoutMs, label)
  return await new Promise<MobilecliAgentAnswer>((resolveRun, rejectRun) => {
    const child = spawn(options.executablePath, [...options.args], {
      env: { ...scrubbedParentEnv(), ...options.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdoutTail = ''
    let stderrTail = ''
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      settle()
    }
    const onAbort = (): void => {
      child.kill('SIGTERM')
      const escape = setTimeout(() => {
        child.kill('SIGKILL')
      }, TERM_ESCAPE_MS)
      escape.unref()
    }
    // The pre-abort rejection above guarantees the budget cannot be aborted
    // before this listener attaches: there is no await between the two lines.
    budget.signal.addEventListener('abort', onAbort, { once: true })
    // stdio pipes both output streams, so the readable halves are always present.
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutTail = retainTailWith(stdoutTail, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = retainTailWith(stderrTail, chunk)
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      budget[Symbol.dispose]()
      finish(() => {
        rejectRun(new PhoneDevicesError('PHONE_UNAVAILABLE', `the mobilecli agent command could not start: ${error.message}`, { cause: error }))
      })
    })
    child.once('close', (code) => {
      budget[Symbol.dispose]()
      finish(() => {
        if (budget.signal.aborted) {
          rejectRun(agentHalt(budget.signal.reason, label, options.timeoutMs))
          return
        }
        if (code === 0) {
          const answer = parseAgentAnswer(stdoutTail)
          if (answer !== undefined) {
            resolveRun(answer)
            return
          }
          rejectRun(new PhoneDevicesError(
            'PHONE_PROTOCOL',
            `mobilecli ${label} answered no parsable agent JSON\n${tailsOf(stdoutTail, stderrTail)}`,
          ))
          return
        }
        const issueError = realDeviceIssueError(`${stdoutTail}\n${stderrTail}`)
        if (issueError !== undefined) {
          rejectRun(issueError)
          return
        }
        rejectRun(new PhoneDevicesError(
          'PHONE_UPSTREAM',
          `mobilecli ${label} failed with exit code ${String(code)}\n${tailsOf(stdoutTail, stderrTail)}`,
        ))
      })
    })
  })
}

/**
 * Translate the abort winner of a halted agent run onto the public vocabulary.
 * @param reason - Fused budget signal's abort reason.
 * @param label - Human-readable command label for the timeout message.
 * @param timeoutMs - Ceiling the run was bounded by.
 * @returns the normalized public failure.
 */
function agentHalt(reason: unknown, label: string, timeoutMs: number): PhoneDevicesError {
  if (reason instanceof TimeoutReason) {
    return new PhoneDevicesError(
      'PHONE_TIMEOUT',
      `mobilecli ${label} exceeded its ${String(timeoutMs)}ms ceiling`,
      { cause: reason },
    )
  }
  return normalizeOperationError(reason)
}

function retainTailWith(current: string, chunk: Buffer): string {
  return retainTail(current, chunk.toString('utf8'))
}

function tailsOf(stdoutTail: string, stderrTail: string): string {
  const combined = `${stdoutTail.trim()}\n${stderrTail.trim()}`.trim()
  return combined.length > 0 ? combined : '(no output)'
}

/**
 * Parse the last JSON object on the agent command's stdout into an answer.
 * @param stdoutTail - Retained stdout tail.
 * @returns the parsed answer, or `undefined` when stdout carries none.
 */
function parseAgentAnswer(stdoutTail: string): MobilecliAgentAnswer | undefined {
  const lines = [...stdoutTail.split('\n')].reverse()
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.startsWith('{')) continue
    let parsed: {
      status?: unknown
      data?: { message?: unknown; agent?: { version?: unknown; bundleId?: unknown } | null } | null
    }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      // A later-prefix line can still carry the answer, so scanning continues.
      continue
    }
    if (typeof parsed.status !== 'string') continue
    const message = typeof parsed.data?.message === 'string' ? parsed.data.message : ''
    const rawAgent = parsed.data?.agent
    const agent = typeof rawAgent === 'object' && rawAgent !== null
      && typeof rawAgent.version === 'string' && typeof rawAgent.bundleId === 'string'
      ? { version: rawAgent.version, bundleId: rawAgent.bundleId }
      : undefined
    return { ok: parsed.status === 'ok', message, ...(agent !== undefined ? { agent } : {}) }
  }
  return undefined
}
