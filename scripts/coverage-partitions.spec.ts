import { access, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COVERAGE_PARTITION_MODE_ENV,
  COVERAGE_EXCLUSIVE_MODE_ENV,
  COVERAGE_PARTITION_CONCURRENCY_ENV,
  COVERAGE_PARTITION_INDEXES_ENV,
  COVERAGE_PRESERVE_BLOBS_ENV,
  COVERAGE_PARTITIONS_ENV,
  COVERAGE_TEST_TIMEOUT_ENV,
  CoveragePartitionCoordinator,
  coverageExclusiveSuites,
  coverageTestTimeoutArgs,
  forwardedCoverageArgs,
  parseCoveragePartitionConcurrency,
  parseCoveragePartitionCount,
  parseCoveragePartitionIndexes,
  type CoverageCommand,
  type CoverageCommandResult,
} from './coverage-partitions.ts'

const passed: CoverageCommandResult = { exitCode: 0, signalCode: null }

afterEach(() => vi.restoreAllMocks())

async function writeBlob(command: CoverageCommand): Promise<void> {
  if (command.blobPath === undefined) return
  await mkdir(dirname(command.blobPath), { recursive: true })
  await writeFile(command.blobPath, '{}')
}

async function temporaryRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-coverage-partitions-'))
}

function successfulCommandRecorder(commands: CoverageCommand[]) {
  return vi.fn(async (command: CoverageCommand) => {
    commands.push(command)
    await writeBlob(command)
    return passed
  })
}

describe('coverage partition count', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['2', 2],
    ['3', 3],
  ])('parses %j as %j', (raw, expected) => {
    expect(parseCoveragePartitionCount(raw)).toBe(expected)
  })

  it.each(['0', '1', '2.5', '02', 'many'])('rejects %j', (raw) => {
    expect(() => parseCoveragePartitionCount(raw))
      .toThrow(`${COVERAGE_PARTITIONS_ENV} must be an integer greater than 1`)
  })
})

describe('coverage partition concurrency', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['1', 1],
    ['3', 3],
  ])('parses %j as %j', (raw, expected) => {
    expect(parseCoveragePartitionConcurrency(raw)).toBe(expected)
  })

  it.each(['0', '-1', '1.5', '01', 'many'])('rejects %j', (raw) => {
    expect(() => parseCoveragePartitionConcurrency(raw))
      .toThrow(`${COVERAGE_PARTITION_CONCURRENCY_ENV} must be a positive integer`)
  })
})

describe('coverage partition indexes', () => {
  it('parses an explicit cross-job subset', () => {
    expect(parseCoveragePartitionIndexes('1,3,8', 8)).toEqual([1, 3, 8])
    expect(parseCoveragePartitionIndexes(undefined, 8)).toBeUndefined()
  })

  it.each(['0,1', '1,9', '1,1', '01,2', '1,two'])('rejects %j', (raw) => {
    expect(() => parseCoveragePartitionIndexes(raw, 8))
      .toThrow(`${COVERAGE_PARTITION_INDEXES_ENV} must contain unique integers within 1..8`)
  })
})

describe('coverage partition timeout', () => {
  it('applies one configured timeout to tests and polling', () => {
    expect(coverageTestTimeoutArgs('30000')).toEqual([
      '--testTimeout=30000',
      '--expect.poll.timeout=30000',
    ])
  })

  it('keeps Vitest defaults when the timeout is absent', () => {
    expect(coverageTestTimeoutArgs(undefined)).toEqual([])
  })

  it('rejects invalid timeout input', () => {
    expect(() => coverageTestTimeoutArgs('0'))
      .toThrow(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer`)
  })
})

describe('coverage forwarded arguments', () => {
  it('removes one package-script separator', () => {
    expect(forwardedCoverageArgs(['--', 'scripts/example.spec.ts'])).toEqual(['scripts/example.spec.ts'])
  })

  it('preserves direct arguments and a subsequent Vitest separator', () => {
    expect(forwardedCoverageArgs(['--testNamePattern=example'])).toEqual(['--testNamePattern=example'])
    expect(forwardedCoverageArgs(['--', '--', 'example'])).toEqual(['--', 'example'])
  })
})

describe('coverage partition coordinator', () => {
  it('runs resource-bound coverage once after concurrent partitions', async () => {
    const root = await temporaryRoot()
    const commands: CoverageCommand[] = []
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 3,
      maxConcurrency: 3,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand: successfulCommandRecorder(commands),
    })

    await expect(coordinator.run()).resolves.toBe(0)
    expect(commands.map(command => command.label)).toEqual([
      'partition 1/3',
      'partition 2/3',
      'partition 3/3',
      'exclusive resource-bound coverage',
      'merged coverage report',
    ])
    const exclusive = commands[3]
    if (exclusive === undefined) throw new Error('exclusive coverage command was not observed')
    expect(exclusive.args).toEqual(expect.arrayContaining([
      '--coverage',
      '--coverage.reportOnFailure',
      '--maxWorkers=1',
      ...coverageExclusiveSuites,
    ]))
    expect(coverageExclusiveSuites).toContain(
      'packages/attachment/attachment-local/tests/normalization.spec.ts',
    )
    expect(coverageExclusiveSuites).toContain(
      'packages/session/session-persistence-sqlite/tests/differential.spec.ts',
    )
    expect(exclusive.args.some(argument => argument.startsWith('--shard='))).toBe(false)
    expect(exclusive.env).toMatchObject({
      [COVERAGE_PARTITION_MODE_ENV]: undefined,
      [COVERAGE_EXCLUSIVE_MODE_ENV]: '1',
    })
  })

  it('assigns exclusive coverage to the subset that owns partition one', async () => {
    const root = await temporaryRoot()
    const commands: CoverageCommand[] = []
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 8,
      partitionIndexes: [1, 2, 3, 4],
      mergeReports: false,
      preserveBlobs: true,
      maxConcurrency: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand: successfulCommandRecorder(commands),
    })

    await expect(coordinator.run()).resolves.toBe(0)
    expect(commands.map(command => command.label)).toEqual([
      'partition 1/8',
      'partition 2/8',
      'partition 3/8',
      'partition 4/8',
      'exclusive resource-bound coverage',
    ])
    await expect(access(join(root, 'coverage/.partitioned/blobs/exclusive-resource-bound.json')))
      .resolves.toBeUndefined()
  })

  it('retains an explicit subset without merging it', async () => {
    const root = await temporaryRoot()
    const commands: CoverageCommand[] = []
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 8,
      partitionIndexes: [5, 6, 7, 8],
      mergeReports: false,
      preserveBlobs: true,
      maxConcurrency: 4,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand: successfulCommandRecorder(commands),
    })

    await expect(coordinator.run()).resolves.toBe(0)
    expect(commands.map(command => command.label)).toEqual([
      'partition 5/8',
      'partition 6/8',
      'partition 7/8',
      'partition 8/8',
    ])
    await expect(access(join(root, 'coverage/.partitioned/blobs/partition-8.json')))
      .resolves.toBeUndefined()
  })

  it('limits concurrently active partition processes without changing the shard count', async () => {
    const root = await temporaryRoot()
    let active = 0
    let peak = 0
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      if (command.blobPath === undefined) return passed
      active += 1
      peak = Math.max(peak, active)
      await writeBlob(command)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 3,
      maxConcurrency: 1,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)

    expect(peak).toBe(1)
    expect(runCommand.mock.calls.map(([command]) => command.label)).toEqual([
      'partition 1/3',
      'partition 2/3',
      'partition 3/3',
      'exclusive resource-bound coverage',
      'merged coverage report',
    ])
  })

  it('runs every single-worker partition before one merged threshold check', async () => {
    const root = await temporaryRoot()
    const commands: CoverageCommand[] = []
    const runCommand = successfulCommandRecorder(commands)
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 3,
      pnpmEntrypoint: '/pnpm.cjs',
      vitestArgs: ['--testTimeout=30000'],
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)

    expect(commands.map(command => command.label)).toEqual([
      'partition 1/3',
      'partition 2/3',
      'partition 3/3',
      'exclusive resource-bound coverage',
      'merged coverage report',
    ])
    for (const [index, command] of commands.slice(0, 3).entries()) {
      expect(command.command).toBe(process.execPath)
      expect(command.args[0]).toBe('/pnpm.cjs')
      expect(command.args).toEqual(expect.arrayContaining([
        '--coverage',
        '--coverage.reportOnFailure',
        '--maxWorkers=1',
        `--shard=${index + 1}/3`,
        '--reporter=default',
        '--reporter=blob',
        '--testTimeout=30000',
      ]))
      expect(command.env).toEqual({
        [COVERAGE_PARTITION_CONCURRENCY_ENV]: undefined,
        [COVERAGE_PARTITION_INDEXES_ENV]: undefined,
        [COVERAGE_PARTITIONS_ENV]: undefined,
        [COVERAGE_PARTITION_MODE_ENV]: '1',
        [COVERAGE_PRESERVE_BLOBS_ENV]: undefined,
      })
    }
    const mergeCommand = commands[4]
    if (mergeCommand === undefined) throw new Error('coverage merge command was not observed')
    expect(mergeCommand.args).toContain('--coverage')
    expect(mergeCommand.args.some(argument => argument.startsWith('--merge-reports='))).toBe(true)
    expect(mergeCommand.env).toEqual({
      [COVERAGE_PARTITION_CONCURRENCY_ENV]: undefined,
      [COVERAGE_PARTITION_INDEXES_ENV]: undefined,
      [COVERAGE_PARTITIONS_ENV]: undefined,
      [COVERAGE_PARTITION_MODE_ENV]: undefined,
      [COVERAGE_PRESERVE_BLOBS_ENV]: undefined,
    })
  })

  it('runs a native pnpm entrypoint directly', async () => {
    const root = await temporaryRoot()
    const commands: CoverageCommand[] = []
    const runCommand = successfulCommandRecorder(commands)
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/tools/pnpm',
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)
    expect(commands).toHaveLength(4)
    for (const command of commands) {
      expect(command.command).toBe('/tools/pnpm')
      expect(command.args[0]).toBe('exec')
    }
  })

  it('merges normal test failures and returns their failed status', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      return command.label === 'partition 2/2'
        ? { exitCode: 1, signalCode: null, outputTail: 'specific Vitest failure' }
        : passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(1)
    expect(reported).toHaveBeenCalledWith('coverage-partitions: FAIL partition 2/2 (exit 1)')
    expect(reported).toHaveBeenCalledWith(
      'coverage-partitions: output tail for partition 2/2:\nspecific Vitest failure',
    )
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it('merges an exclusive-suite failure and returns its failed status', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      return command.label === 'exclusive resource-bound coverage'
        ? { exitCode: 1, signalCode: null, outputTail: 'specific PowerShell failure' }
        : passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(1)
    expect(reported).toHaveBeenCalledWith(
      'coverage-partitions: FAIL exclusive resource-bound coverage (exit 1)',
    )
    expect(reported).toHaveBeenCalledWith(
      'coverage-partitions: output tail for exclusive resource-bound coverage:\nspecific PowerShell failure',
    )
    expect(runCommand.mock.calls.map(([command]) => command.label)).toEqual([
      'partition 1/2',
      'partition 2/2',
      'exclusive resource-bound coverage',
      'merged coverage report',
    ])
  })

  it('retries one partition once after an isolated Vitest worker exit', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let firstPartitionRuns = 0
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      if (command.label === 'partition 1/2' && firstPartitionRuns++ === 0) {
        return {
          exitCode: 1,
          signalCode: null,
          outputTail: [
            'Error: [vitest-pool]: Worker forks emitted error.',
            'Caused by: Error: Worker exited unexpectedly',
          ].join('\n'),
        }
      }
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      maxConcurrency: 1,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)
    expect(reported).toHaveBeenCalledWith(
      'coverage-partitions: retry partition 1/2 after an unexpected Vitest worker exit',
    )
    expect(runCommand.mock.calls.map(([command]) => command.label)).toEqual([
      'partition 1/2',
      'partition 1/2',
      'partition 2/2',
      'exclusive resource-bound coverage',
      'merged coverage report',
    ])
  })

  it('rejects a missing partition blob before merge', async () => {
    const root = await temporaryRoot()
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      if (command.label !== 'partition 2/2') await writeBlob(command)
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).rejects.toThrow('coverage partitions produced')
    expect(runCommand).toHaveBeenCalledTimes(3)
  })

  it('reports signal termination before missing-blob validation', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      if (command.label === 'partition 1/2') await writeBlob(command)
      return command.label === 'partition 2/2'
        ? { exitCode: null, signalCode: 'SIGTERM' as const }
        : passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).rejects.toThrow('coverage partitions produced')
    expect(reported).toHaveBeenCalledWith('coverage-partitions: FAIL partition 2/2 (signal SIGTERM)')
  })

  it('waits for every partition after one spawn failure', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let secondFinished = false
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      if (command.label === 'partition 1/2') {
        return { exitCode: null, signalCode: null, error: 'spawn unavailable' }
      }
      if (command.label === 'partition 2/2') secondFinished = true
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(1)
    expect(reported).toHaveBeenCalledWith('coverage-partitions: FAIL partition 1/2 (spawn unavailable)')
    expect(secondFinished).toBe(true)
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it('unlinks a link-shaped coverage path without touching its target', async () => {
    const root = await temporaryRoot()
    const target = await temporaryRoot()
    const marker = join(target, 'marker.txt')
    await writeFile(marker, 'owned elsewhere')
    await symlink(target, join(root, 'coverage'), process.platform === 'win32' ? 'junction' : 'dir')
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)
    await expect(access(marker)).resolves.toBeUndefined()
  })
})
