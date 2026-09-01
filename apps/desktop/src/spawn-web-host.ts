/**
 * Start the bundled Web Host as a child Node process and wait for its URL.
 * @module @deepseek-ai/dsh-desktop/spawn-web-host
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { webUrlFromOutput } from './web-url.ts'

/** How we invoke `dsh web`. */
export interface WebHostCommand {
  /** Node executable (never Electron's execPath). */
  readonly node: string
  /** argv after the node executable, including the dsh bin. */
  readonly args: readonly string[]
  /** Process cwd: the Launch Directory. */
  readonly cwd: string
  /** Extra environment. */
  readonly env?: NodeJS.ProcessEnv
  /** Abort startup and terminate the child before rejecting. */
  readonly signal?: AbortSignal
}

/** A running Web Host plus the loopback URL it printed. */
export interface RunningWebHost {
  /** Child process. */
  readonly child: ChildProcess
  /** Resolves whenever the child exits, including before a consumer attaches. */
  readonly exited: Promise<void>
  /** Request termination and resolve after the child exits. */
  readonly stop: () => Promise<void>
  /** Loopback URL including the assigned port. */
  readonly url: string
}

const SENSITIVE_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu

/** Remove inherited or supplied credential values from child diagnostics. */
export function redactWebHostDiagnostic(output: string, environment: NodeJS.ProcessEnv): string {
  let redacted = output
  const secrets = Object.entries(environment)
    .flatMap(([name, value]) => (
      SENSITIVE_ENVIRONMENT_NAME.test(name) && value !== undefined && value.length > 0 ? [value] : []
    ))
    .sort((left, right) => right.length - left.length)
  for (const secret of new Set(secrets)) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted
    .replaceAll(/([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .replaceAll(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
}

/** Return a bounded credential-free child diagnostic. */
export function webHostDiagnosticSummary(output: string, environment: NodeJS.ProcessEnv): string {
  const redacted = redactWebHostDiagnostic(output.trim(), environment)
  if (redacted.length <= 800) return redacted
  return `${redacted.slice(0, 398)}\n…\n${redacted.slice(-398)}`
}

/**
 * Spawn `dsh web` and resolve when it prints the loopback URL.
 * @param command - node, args, cwd.
 * @param timeoutMs - fail if the URL line does not appear.
 * @returns the child and URL.
 */
export function spawnWebHost(
  command: WebHostCommand,
  timeoutMs = 30_000,
): Promise<RunningWebHost> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ...command.env }
    const child = spawn(command.node, [...command.args], {
      cwd: command.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => {
        command.signal?.removeEventListener('abort', onAbort)
        resolveExit()
      })
    })
    let stopPromise: Promise<void> | undefined
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await exited
      })()
      return stopPromise
    }
    let buffer = ''
    let settled = false
    const terminateBeforeReady = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void stop().then(() => { reject(error) })
    }
    const onAbort = (): void => {
      if (settled) {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        return
      }
      terminateBeforeReady(new Error('dsh web startup aborted'))
    }
    command.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      const tail = webHostDiagnosticSummary(buffer, environment)
      terminateBeforeReady(new Error(
        `dsh web did not print a loopback URL within ${String(timeoutMs)}ms`
        + (tail.length === 0 ? '' : `\n${tail}`),
      ))
    }, timeoutMs)
    if (command.signal?.aborted === true) onAbort()
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const url = webUrlFromOutput(buffer)
      if (url === undefined || settled) return
      settled = true
      clearTimeout(timer)
      resolve({ child, exited, stop, url })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const tail = webHostDiagnosticSummary(buffer, environment)
      reject(new Error(
        'dsh web exited before announcing a URL (code ' + String(code) + ', signal ' + String(signal) + ')'
        + (tail.length === 0 ? '' : '\n' + tail),
      ))
    })
  })
}
