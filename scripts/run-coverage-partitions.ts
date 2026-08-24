/** CLI entry for partitioned Vitest coverage. */
import { resolve } from 'node:path'
import {
  COVERAGE_PARTITION_CONCURRENCY_ENV,
  COVERAGE_PARTITION_INDEXES_ENV,
  COVERAGE_PRESERVE_BLOBS_ENV,
  COVERAGE_PARTITIONS_ENV,
  COVERAGE_TEST_TIMEOUT_ENV,
  CoveragePartitionCoordinator,
  coverageTestTimeoutArgs,
  forwardedCoverageArgs,
  parseCoveragePartitionConcurrency,
  parseCoveragePartitionCount,
  parseCoveragePartitionIndexes,
} from './coverage-partitions.ts'

const partitions = parseCoveragePartitionCount(process.env[COVERAGE_PARTITIONS_ENV])
if (partitions === undefined) {
  throw new Error(`${COVERAGE_PARTITIONS_ENV} is required by partitioned coverage.`)
}
const maxConcurrency = parseCoveragePartitionConcurrency(process.env[COVERAGE_PARTITION_CONCURRENCY_ENV])
const partitionIndexes = parseCoveragePartitionIndexes(
  process.env[COVERAGE_PARTITION_INDEXES_ENV],
  partitions,
)
const preserveBlobsRaw = process.env[COVERAGE_PRESERVE_BLOBS_ENV]
if (!(preserveBlobsRaw === undefined || preserveBlobsRaw === '' || preserveBlobsRaw === '1')) {
  throw new Error(`${COVERAGE_PRESERVE_BLOBS_ENV} must be '1' or unset.`)
}
const pnpmEntrypoint = process.env.npm_execpath
if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
  throw new Error('partitioned coverage must be invoked through a pnpm package script.')
}

const coordinator = new CoveragePartitionCoordinator({
  root: resolve(import.meta.dirname, '..'),
  partitions,
  ...maxConcurrency === undefined ? {} : { maxConcurrency },
  ...partitionIndexes === undefined ? {} : {
    partitionIndexes,
    mergeReports: false,
    preserveBlobs: preserveBlobsRaw === '1',
  },
  pnpmEntrypoint,
  vitestArgs: [
    ...coverageTestTimeoutArgs(process.env[COVERAGE_TEST_TIMEOUT_ENV]),
    ...forwardedCoverageArgs(process.argv.slice(2)),
  ],
})
process.exitCode = await coordinator.run()
