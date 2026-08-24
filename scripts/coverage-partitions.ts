/** Coordinate parallel Vitest coverage partitions, exclusive resource-bound suites, and one merged report. */
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Environment variable selecting the number of instrumented coverage processes. */
export const COVERAGE_PARTITIONS_ENV = 'DSH_COVERAGE_PARTITIONS'

/** Environment variable bounding concurrently active coverage partition processes. */
export const COVERAGE_PARTITION_CONCURRENCY_ENV = 'DSH_COVERAGE_PARTITION_CONCURRENCY'

/** Optional comma-separated one-based partition indexes owned by this process. */
export const COVERAGE_PARTITION_INDEXES_ENV = 'DSH_COVERAGE_PARTITION_INDEXES'

/** Marker retaining partition blobs for a later cross-job merge. */
export const COVERAGE_PRESERVE_BLOBS_ENV = 'DSH_COVERAGE_PRESERVE_BLOBS'

/** Internal marker that suppresses reports and thresholds inside a partition process. */
export const COVERAGE_PARTITION_MODE_ENV = 'DSH_COVERAGE_PARTITION_MODE'

/** Internal marker selecting the serialized resource-bound coverage suites. */
export const COVERAGE_EXCLUSIVE_MODE_ENV = 'DSH_COVERAGE_EXCLUSIVE_MODE'

/** Environment variable overriding instrumented test and polling timeouts. */
export const COVERAGE_TEST_TIMEOUT_ENV = 'DSH_COVERAGE_TEST_TIMEOUT_MS'

/** Resource-bound suites that must not overlap other instrumented processes. */
export const coverageExclusiveSuites = [
  'packages/attachment/attachment-local/tests/normalization.spec.ts',
  'packages/session/session-persistence-sqlite/tests/differential.spec.ts',
  'packages/shell/pwsh-local/tests/executor.spec.ts',
  'packages/shell/pwsh-sandbox/tests/sandbox.spec.ts',
  'packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts',
  'packages/shell/tool-pwsh/tests/integration.spec.ts',
  'packages/shell/tool-pwsh/tests/loader.spec.ts',
  'packages/terminal/terminal-bash/tests/local.spec.ts',
] as const

/** One child command owned by the coverage coordinator. */
export interface CoverageCommand {
  /** Diagnostic identity. */
  label: string
  /** Executable launched without a platform shell. */
  command: string
  /** Arguments passed to the executable. */
  args: string[]
  /** Environment additions for the child. */
  env: Record<string, string | undefined>
  /** Working directory for the child. */
  cwd: string
  /** Blob the partition must produce; absent for the merge command. */
  blobPath?: string
}

/** Observable child-process completion. */
export interface CoverageCommandResult {
  /** Numeric process status, or `null` when a signal ended the child. */
  exitCode: number | null
  /** Terminating signal, or `null` after an ordinary exit. */
  signalCode: NodeJS.Signals | null
  /** Spawn failure recorded independently from process completion. */
  error?: string
  /** Bounded combined stdout/stderr tail repeated when the command fails. */
  outputTail?: string
}

/** Execute one coordinator command with inherited output. */
export type CoverageCommandRunner = (command: CoverageCommand) => Promise<CoverageCommandResult>

/** Construction inputs for {@link CoveragePartitionCoordinator}. */
export interface CoveragePartitionCoordinatorOptions {
  /** Repository root that owns coverage output. */
  root: string
  /** Number of single-worker Vitest shards. */
  partitions: number
  /** Maximum number of partition processes allowed to execute concurrently. */
  maxConcurrency?: number
  /** One-based partition indexes executed by this coordinator. */
  partitionIndexes?: readonly number[]
  /** Whether to merge this coordinator's complete blob set. */
  mergeReports?: boolean
  /** Whether blobs remain after completion for artifact upload. */
  preserveBlobs?: boolean
  /** pnpm JavaScript or executable entrypoint from `npm_execpath`. */
  pnpmEntrypoint: string
  /** Additional arguments shared by every partition. */
  vitestArgs?: string[]
  /** Child executor, injectable for scheduler tests. */
  runCommand?: CoverageCommandRunner
}

/** Parse an optional coverage partition count. */
export function parseCoveragePartitionCount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 2 || String(parsed) !== raw) {
    throw new Error(`${COVERAGE_PARTITIONS_ENV} must be an integer greater than 1, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

/** Parse an optional coverage partition process limit. */
export function parseCoveragePartitionConcurrency(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`${COVERAGE_PARTITION_CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

/** Parse an optional comma-separated subset of one-based coverage partitions. */
export function parseCoveragePartitionIndexes(
  raw: string | undefined,
  partitions: number,
): number[] | undefined {
  if (raw === undefined || raw === '') return undefined
  const parts = raw.split(',')
  const indexes = parts.map(value => Number.parseInt(value, 10))
  if (indexes.length === 0
    || indexes.some((index, offset) => !Number.isSafeInteger(index) || String(index) !== parts[offset])
    || new Set(indexes).size !== indexes.length
    || indexes.some(index => index < 1 || index > partitions)) {
    throw new Error(`${COVERAGE_PARTITION_INDEXES_ENV} must contain unique integers within 1..${String(partitions)}.`)
  }
  return indexes
}

/** Resolve the paired Vitest timeout arguments used by coverage partitions. */
export function coverageTestTimeoutArgs(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return []
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return [`--testTimeout=${raw}`, `--expect.poll.timeout=${raw}`]
}

/** Remove pnpm's package-script separator before forwarding Vitest arguments. */
export function forwardedCoverageArgs(args: readonly string[]): string[] {
  return [...args.slice(args[0] === '--' ? 1 : 0)]
}

/** Run instrumented partitions plus exclusive suites, validate their blobs, and merge once. */
export class CoveragePartitionCoordinator {
  private readonly root: string
  private readonly partitions: number
  private readonly maxConcurrency: number
  private readonly partitionIndexes: readonly number[]
  private readonly mergeReports: boolean
  private readonly preserveBlobs: boolean
  private readonly pnpmEntrypoint: string
  private readonly vitestArgs: string[]
  private readonly runCommand: CoverageCommandRunner
  private readonly temporaryRoot: string
  private readonly blobsRoot: string

  /** Create a coordinator from validated process-independent inputs. */
  public constructor(options: CoveragePartitionCoordinatorOptions) {
    if (!Number.isSafeInteger(options.partitions) || options.partitions < 2) {
      throw new Error(`coverage partitions must be an integer greater than 1, got ${String(options.partitions)}.`)
    }
    this.root = options.root
    this.partitions = options.partitions
    this.maxConcurrency = options.maxConcurrency ?? options.partitions
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new Error(`coverage partition concurrency must be a positive integer, got ${String(this.maxConcurrency)}.`)
    }
    this.partitionIndexes = options.partitionIndexes ?? Array.from(
      { length: options.partitions },
      (_, index) => index + 1,
    )
    if (this.partitionIndexes.length === 0
      || new Set(this.partitionIndexes).size !== this.partitionIndexes.length
      || this.partitionIndexes.some(index => !Number.isSafeInteger(index)
        || index < 1
        || index > options.partitions)) {
      throw new Error(`coverage partition indexes must be unique integers within 1..${String(options.partitions)}.`)
    }
    this.mergeReports = options.mergeReports ?? true
    this.preserveBlobs = options.preserveBlobs ?? false
    this.pnpmEntrypoint = options.pnpmEntrypoint
    this.vitestArgs = options.vitestArgs ?? []
    this.runCommand = options.runCommand ?? runCoverageCommand
    this.temporaryRoot = join(this.root, 'coverage', '.partitioned')
    this.blobsRoot = join(this.temporaryRoot, 'blobs')
  }

  /**
   * Run every partition, then exclusive resource-bound suites, before one merged threshold check.
   * @returns zero only when every partition and the merge command succeed.
   */
  public async run(): Promise<number> {
    await removeOwnedTree(join(this.root, 'coverage'))
    await mkdir(this.blobsRoot, { recursive: true })

    try {
      const commands = this.partitionIndexes.map(index => this.partitionCommand(index))
      const results = new Array<CoverageCommandResult>(commands.length)
      let nextIndex = 0
      const worker = async (): Promise<void> => {
        while (nextIndex < commands.length) {
          const index = nextIndex
          nextIndex += 1
          const command = commands[index]
          if (command === undefined) throw new Error(`coverage partition ${String(index + 1)} is missing.`)
          console.log(`coverage-partitions: start ${command.label}`)
          let result = await this.runCommand(command)
          if (isIsolatedVitestWorkerExit(result)) {
            console.warn(`coverage-partitions: retry ${command.label} after an unexpected Vitest worker exit`)
            if (command.blobPath !== undefined) await removeOwnedFile(command.blobPath)
            result = await this.runCommand(command)
          }
          results[index] = result
          if (commandFailed(result)) {
            console.error(`coverage-partitions: FAIL ${command.label} (${commandFailureReason(result)})`)
            if (result.outputTail !== undefined && result.outputTail !== '') {
              console.error(`coverage-partitions: output tail for ${command.label}:\n${result.outputTail}`)
            }
          }
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(this.maxConcurrency, commands.length) },
        worker,
      ))
      const exclusiveCommand = this.partitionIndexes.includes(1)
        ? this.exclusiveCommand()
        : undefined
      if (exclusiveCommand !== undefined) {
        console.log(`coverage-partitions: start ${exclusiveCommand.label}`)
        const result = await this.runCommand(exclusiveCommand)
        results.push(result)
        commands.push(exclusiveCommand)
        if (commandFailed(result)) {
          console.error(`coverage-partitions: FAIL ${exclusiveCommand.label} (${commandFailureReason(result)})`)
          if (result.outputTail !== undefined && result.outputTail !== '') {
            console.error(`coverage-partitions: output tail for ${exclusiveCommand.label}:\n${result.outputTail}`)
          }
        }
      }
      await this.assertCompleteBlobSet(commands)

      if (!this.mergeReports) return results.some(commandFailed) ? 1 : 0
      const mergeCommand = this.mergeCommand()
      console.log(`coverage-partitions: start ${mergeCommand.label}`)
      const mergeResult = await this.runCommand(mergeCommand)
      return results.some(commandFailed) || commandFailed(mergeResult) ? 1 : 0
    } finally {
      if (!this.preserveBlobs) await removeOwnedTree(this.temporaryRoot)
    }
  }

  private partitionCommand(index: number): CoverageCommand {
    const blobPath = join(this.blobsRoot, `partition-${index}.json`)
    const reportsDirectory = join(this.temporaryRoot, `coverage-${index}`)
    const invocation = pnpmInvocation([
      'exec',
      'vitest',
      'run',
      '--coverage',
      '--coverage.reportOnFailure',
      '--maxWorkers=1',
      `--shard=${index}/${this.partitions}`,
      '--reporter=default',
      '--reporter=blob',
      `--outputFile.blob=${this.relativePath(blobPath)}`,
      `--coverage.reportsDirectory=${this.relativePath(reportsDirectory)}`,
      ...this.vitestArgs,
    ], { npm_execpath: this.pnpmEntrypoint })
    return {
      label: `partition ${index}/${this.partitions}`,
      ...invocation,
      env: {
        [COVERAGE_PARTITION_CONCURRENCY_ENV]: undefined,
        [COVERAGE_PARTITION_INDEXES_ENV]: undefined,
        [COVERAGE_PARTITIONS_ENV]: undefined,
        [COVERAGE_PARTITION_MODE_ENV]: '1',
        [COVERAGE_EXCLUSIVE_MODE_ENV]: undefined,
        [COVERAGE_PRESERVE_BLOBS_ENV]: undefined,
      },
      cwd: this.root,
      blobPath,
    }
  }

  private mergeCommand(): CoverageCommand {
    const invocation = pnpmInvocation([
      'exec',
      'vitest',
      `--merge-reports=${this.relativePath(this.blobsRoot)}`,
      '--coverage',
    ], { npm_execpath: this.pnpmEntrypoint })
    return {
      label: 'merged coverage report',
      ...invocation,
      env: {
        [COVERAGE_PARTITION_CONCURRENCY_ENV]: undefined,
        [COVERAGE_PARTITION_INDEXES_ENV]: undefined,
        [COVERAGE_PARTITIONS_ENV]: undefined,
        [COVERAGE_PARTITION_MODE_ENV]: undefined,
        [COVERAGE_EXCLUSIVE_MODE_ENV]: undefined,
        [COVERAGE_PRESERVE_BLOBS_ENV]: undefined,
      },
      cwd: this.root,
    }
  }

  private exclusiveCommand(): CoverageCommand {
    const blobPath = join(this.blobsRoot, 'exclusive-resource-bound.json')
    const reportsDirectory = join(this.temporaryRoot, 'coverage-exclusive-resource-bound')
    const invocation = pnpmInvocation([
      'exec',
      'vitest',
      'run',
      '--coverage',
      '--coverage.reportOnFailure',
      '--maxWorkers=1',
      '--reporter=default',
      '--reporter=blob',
      `--outputFile.blob=${this.relativePath(blobPath)}`,
      `--coverage.reportsDirectory=${this.relativePath(reportsDirectory)}`,
      ...coverageExclusiveSuites,
      ...this.vitestArgs,
    ], { npm_execpath: this.pnpmEntrypoint })
    return {
      label: 'exclusive resource-bound coverage',
      ...invocation,
      env: {
        [COVERAGE_PARTITION_CONCURRENCY_ENV]: undefined,
        [COVERAGE_PARTITION_INDEXES_ENV]: undefined,
        [COVERAGE_PARTITIONS_ENV]: undefined,
        [COVERAGE_PARTITION_MODE_ENV]: undefined,
        [COVERAGE_EXCLUSIVE_MODE_ENV]: '1',
        [COVERAGE_PRESERVE_BLOBS_ENV]: undefined,
      },
      cwd: this.root,
      blobPath,
    }
  }

  private relativePath(path: string): string {
    return relative(this.root, path).split(sep).join('/')
  }

  private async assertCompleteBlobSet(commands: CoverageCommand[]): Promise<void> {
    const expected = commands.map((command) => {
      if (command.blobPath === undefined) throw new Error(`${command.label} has no blob path.`)
      return this.relativePath(command.blobPath)
    }).sort()
    const actual = (await readdir(this.blobsRoot))
      .map(name => this.relativePath(join(this.blobsRoot, name)))
      .sort()
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error(`coverage partitions produced ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`)
    }
  }
}

/** Spawn one pnpm-backed command without a platform shell. */
function runCoverageCommand(command: CoverageCommand): Promise<CoverageCommandResult> {
  return new Promise((resolveCommand) => {
    let outputTail = ''
    const env = { ...process.env }
    for (const [name, value] of Object.entries(command.env)) {
      if (value === undefined) Reflect.deleteProperty(env, name)
      else env[name] = value
    }
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      process.stdout.write(chunk)
      outputTail = appendOutputTail(outputTail, chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      outputTail = appendOutputTail(outputTail, chunk)
    })
    child.once('error', (error: Error) => {
      resolveCommand({ exitCode: null, signalCode: null, error: error.message, outputTail })
    })
    child.once('close', (exitCode, signalCode) => {
      resolveCommand({ exitCode, signalCode, outputTail })
    })
  })
}

function appendOutputTail(previous: string, chunk: string): string {
  const combined = previous + chunk
  return combined.length <= 65_536 ? combined : combined.slice(-65_536)
}

function commandFailed(result: CoverageCommandResult): boolean {
  return result.exitCode !== 0 || result.signalCode !== null || result.error !== undefined
}

function commandFailureReason(result: CoverageCommandResult): string {
  const facts = [
    result.error,
    result.exitCode === null ? undefined : `exit ${result.exitCode}`,
    result.signalCode === null ? undefined : `signal ${result.signalCode}`,
  ].filter((fact): fact is string => fact !== undefined)
  return facts.join(', ') || 'no exit code or signal'
}

function isIsolatedVitestWorkerExit(result: CoverageCommandResult): boolean {
  const output = result.outputTail ?? ''
  return result.exitCode === 1
    && result.signalCode === null
    && result.error === undefined
    && output.includes('[vitest-pool]: Worker forks emitted error.')
    && output.includes('Worker exited unexpectedly')
    && !output.includes('Failed Tests')
}

async function removeOwnedFile(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  })
}

async function removeOwnedTree(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await unlink(path)
    return
  }
  await rm(path, { recursive: true, force: true })
}
