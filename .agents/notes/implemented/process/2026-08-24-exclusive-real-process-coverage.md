# Agent Note: Exclusive real-process coverage

Status: implemented

English | [中文](2026-08-24-exclusive-real-process-coverage.zh.md)

## Problem

Single-worker Vitest partitions isolate JavaScript test workers, but concurrently active partitions can still launch several external PowerShell trees on one hosted runner. A four-partition Linux run exposed two simultaneous real-PowerShell failures and established a two-process bound. A later two-process run still returned a null exit outcome from a basic `Write-Output` command while every non-PowerShell lane passed. Lowering the whole coverage coordinator to one process would remove useful parallelism from hundreds of tests to protect six external-process suites.

## Decision

Partitioned coverage excludes the six test files that launch real PowerShell processes from every ordinary shard. After all ordinary shards settle, the coordinator runs those files once in a dedicated instrumented Vitest command with one worker and no overlapping partition process. The exclusive command writes its own blob, keeps thresholds disabled like a partial shard, and preserves ordinary failed-test output and coverage through `coverage.reportOnFailure`.

The coordinator owning partition one owns the exclusive command. A single-job Linux run therefore executes it once before the merged threshold check. Split native Windows coverage assigns it to the shard job containing partition one; that job uploads the exclusive blob beside its partition blobs, and the existing merge job downloads the complete set. The final merge remains the only owner of repository-wide per-file 100% thresholds.

The exclusive inventory contains the real-process files for `pwsh-local`, `pwsh-sandbox`, `tool-pwsh`, `tool-pwsh-persistent`, and the PowerShell half of `terminal-bash`. Pure tests that share those files move with the suites; no test becomes uninstrumented or optional. Hosts without PowerShell retain the existing explicit source exclusions and skip behavior, while CI keeps `DSH_TEST_REQUIRE_PWSH=1` and fails if the executable is unavailable.

## Verification

`scripts/coverage-partitions.spec.ts` pins ordering after concurrent partitions, one-worker instrumented arguments, absence of a shard selector, partition-one ownership across workflow subsets, exclusive blob publication, failure diagnostics, failed-test merging, and the final threshold merge. The existing config and workflow contracts continue to pin PowerShell availability, fixed partition counts, bounded ordinary concurrency, and cross-job blob merging.

## Alternatives considered

**Serialize every coverage partition.** Rejected because the resource constraint belongs to external PowerShell trees, not to the ordinary test inventory. It would roughly double hosted Linux coverage latency while adding no isolation to the affected suites beyond what the exclusive command provides.

**Retry a null PowerShell exit outcome.** Rejected because it would conceal an indeterminate real-process result and make product behavior tests pass without a verified successful command. The suite stays fail-closed; scheduling prevents competing instrumented partitions from creating the starvation condition.

**Run the PowerShell suites uninstrumented beside coverage.** Rejected because these suites own executable branches in the PowerShell providers. Their blob must contribute to the same per-file threshold proof.

## Consequences

Ordinary coverage retains its measured two-process hosted Linux and two-process-per-worker native Windows schedules. The exclusive tail adds one Vitest startup and the actual PowerShell suite duration, but it replaces overlapping external-process work rather than serializing the complete inventory. Adding another real-process suite requires an explicit decision whether it shares this exclusive resource class.
