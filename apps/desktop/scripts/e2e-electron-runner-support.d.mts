import type { Writable } from 'node:stream'

export interface RunLoggedOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly logFile: string
  readonly signal?: AbortSignal
  readonly stdout?: Writable
  readonly stderr?: Writable
  readonly terminateGraceMs?: number
}

export function runLogged(command: string, args: readonly string[], options: RunLoggedOptions): Promise<number>

export function quiesceRecordedProcesses(file: string, requiredKeys: readonly string[]): Promise<{
  readonly pids: readonly number[]
  readonly forced: readonly number[]
}>

export interface CleanupStep {
  readonly name: string
  readonly run: () => void | Promise<void>
}

export interface CleanupOutcome {
  readonly name: string
  readonly ok: boolean
  readonly error?: string
}

export function settleCleanupSteps(steps: readonly CleanupStep[]): Promise<{
  readonly outcomes: readonly CleanupOutcome[]
  readonly errors: readonly Error[]
}>

export class PortHandoffCollision extends Error {}

export interface ElectronE2ePorts {
  readonly fakePort: number
  readonly cdpPort: number
}

export function withDistinctPortHandoff<T>(
  run: (ports: ElectronE2ePorts, attempt: number) => T | Promise<T>,
): Promise<T>

export function readOwnedFakeProcess(port: number, ownerToken: string): Promise<{ readonly pid: number }>

export function runWithVerifiedPortHandoff<T>(
  name: string,
  run: (
    ports: ElectronE2ePorts,
    attempt: number,
  ) => Promise<{ readonly value: T; readonly runnerLog: string }>,
): Promise<T>
