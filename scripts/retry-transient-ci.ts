/** Run one command with at most one retry for classified infrastructure transport failures. */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { isTransientInfrastructureFailure } from './ci-evidence.ts'

/** One command attempt retained by the transient retry report. */
export interface AttemptEvidence {
  attempt: 1 | 2
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  classification: 'transient-infrastructure' | null
}

/** Complete evidence for a command and its optional bounded retry. */
export interface RetryEvidence {
  formatVersion: 1
  command: string
  attempts: AttemptEvidence[]
  retried: boolean
  status: 'passed' | 'failed'
}

/**
 * Execute one command and retry it once only after an exact transient classification.
 * @param command - Executable to start without a shell.
 * @param args - Literal executable arguments.
 * @param execute - Injectable attempt runner.
 * @returns Complete attempt evidence and final exit status.
 */
export async function runWithTransientRetry(
  command: string,
  args: string[],
  execute: (command: string, args: string[]) => Promise<AttemptEvidence>,
): Promise<{ evidence: RetryEvidence; exitCode: number }> {
  const attempts: AttemptEvidence[] = []
  const first = await execute(command, args)
  attempts.push(first)
  if (first.exitCode === 0 && first.signalCode === null) {
    return {
      evidence: { formatVersion: 1, command, attempts, retried: false, status: 'passed' },
      exitCode: 0,
    }
  }
  if (first.classification !== 'transient-infrastructure') {
    return {
      evidence: { formatVersion: 1, command, attempts, retried: false, status: 'failed' },
      exitCode: first.exitCode ?? 1,
    }
  }
  const second = await execute(command, args)
  attempts.push(second)
  const passed = second.exitCode === 0 && second.signalCode === null
  return {
    evidence: { formatVersion: 1, command, attempts, retried: true, status: passed ? 'passed' : 'failed' },
    exitCode: passed ? 0 : (second.exitCode ?? 1),
  }
}

async function executeAttempt(command: string, args: string[], attempt: 1 | 2): Promise<AttemptEvidence> {
  let diagnostics = ''
  const outcome = await new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolveExit) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      diagnostics += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      diagnostics += chunk
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      diagnostics += `\n${error.message}`
      resolveExit({ exitCode: null, signalCode: null })
    })
    child.on('close', (exitCode, signalCode) => {
      resolveExit({ exitCode, signalCode })
    })
  })
  return {
    attempt,
    ...outcome,
    classification: isTransientInfrastructureFailure(diagnostics) ? 'transient-infrastructure' : null,
  }
}

async function main(args: string[]): Promise<number> {
  const separator = args.indexOf('--')
  if (separator < 0 || separator === args.length - 1) {
    throw new Error('expected --report <path> -- <command> [args...]')
  }
  const { values } = parseArgs({
    args: args.slice(0, separator),
    allowPositionals: false,
    strict: true,
    options: { report: { type: 'string' } },
  })
  if (values.report === undefined) throw new Error('missing required --report <path>')
  const command = args[separator + 1]
  if (command === undefined) throw new Error('missing command after --')
  const commandArgs = args.slice(separator + 2)
  let attempt = 0
  const result = await runWithTransientRetry(command, commandArgs, async (attemptCommand, attemptArgs) => {
    attempt += 1
    return executeAttempt(attemptCommand, attemptArgs, attempt === 1 ? 1 : 2)
  })
  const reportPath = resolve(values.report)
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(result.evidence, null, 2)}\n`)
  return result.exitCode
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`retry-transient-ci: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
