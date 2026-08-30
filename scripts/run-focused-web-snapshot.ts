#!/usr/bin/env node
/** Build once and run one explicit Web snapshot file in replay mode. */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import { pnpmInvocation } from './pnpm-invocation.ts'

const WEB_SNAPSHOT_FILE = /^(?:apps\/web\/tests\/.+\.(?:e2e|snapshot)\.ts|apps\/(?:mobile|platform)\/tests\/.+\.snapshot\.ts)$/u

/** One shell-free child invocation owned by the focused runner. */
export interface FocusedWebCommand {
  command: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
}

/** Dependencies for running the focused workflow. */
export interface FocusedWebRunOptions {
  root: string
  environment: NodeJS.ProcessEnv
  run?: (command: FocusedWebCommand) => Promise<number>
}

/**
 * Resolve one explicit file from the Web snapshot inventory.
 * @param args - positional CLI arguments after the package script name.
 * @param root - repository root used for containment and existence checks.
 * @returns the normalized repository-relative file path.
 */
export function resolveFocusedWebSnapshotFile(args: readonly string[], root: string): string {
  const positional = args[0] === '--' ? args.slice(1) : args
  if (positional.length !== 1) {
    throw new Error('test:web:focus requires exactly one repository-relative Web snapshot file')
  }
  const input = positional[0]
  if (input === undefined || input === '' || isAbsolute(input)) {
    throw new Error('test:web:focus requires one repository-relative Web snapshot file')
  }
  const absolute = resolve(root, input)
  const normalized = relative(root, absolute).replaceAll('\\', '/')
  if (normalized.startsWith('../') || !WEB_SNAPSHOT_FILE.test(normalized)) {
    throw new Error(`test:web:focus does not accept ${JSON.stringify(input)}`)
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`test:web:focus file does not exist: ${normalized}`)
  }
  return normalized
}

/**
 * Build the repository once, then execute one Web snapshot file in replay mode.
 * @param file - validated repository-relative Web snapshot file.
 * @param options - repository environment and optional command executor.
 * @returns the failing child status, or zero when both commands pass.
 */
export async function runFocusedWebSnapshot(
  file: string,
  options: FocusedWebRunOptions,
): Promise<number> {
  const execute = options.run ?? runCommand
  const build = pnpmInvocation(['run', 'build'], options.environment)
  const buildStatus = await execute({
    ...build,
    cwd: options.root,
    environment: options.environment,
  })
  if (buildStatus !== 0) return buildStatus

  const testEnvironment = Object.fromEntries(Object.entries(options.environment).filter(([name, value]) =>
    value !== undefined
    && !SENSITIVE_ENV_PATTERN.test(name)
    && !name.toUpperCase().startsWith(DSH_ENV_PREFIX)))
  testEnvironment.DSH_SNAPSHOT = 'replay'
  const test = pnpmInvocation([
    'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts', file,
  ], testEnvironment)
  return await execute({
    ...test,
    cwd: options.root,
    environment: testEnvironment,
  })
}

function runCommand(command: FocusedWebCommand): Promise<number> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.environment,
      stdio: 'inherit',
    })
    child.once('error', rejectRun)
    child.once('exit', (status, signal) => {
      if (signal !== null) console.error(`test:web:focus child terminated by ${signal}`)
      resolveRun(signal === null ? status ?? 1 : 1)
    })
  })
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..')
  const file = resolveFocusedWebSnapshotFile(process.argv.slice(2), root)
  process.exitCode = await runFocusedWebSnapshot(file, {
    root,
    environment: process.env,
  })
}

if (import.meta.main) await main()
