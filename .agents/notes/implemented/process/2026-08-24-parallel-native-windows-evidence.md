# Agent Note: Parallel native Windows evidence

Status: implemented

English | [中文](2026-08-24-parallel-native-windows-evidence.zh.md)

## Problem

The complete native Windows inventory ran serially in one hosted job. A successful observed run spent 44 minutes and 1 second from job start to completion, so reviewers waited long after the required Wine verdict and one late gate could hide the status of every remaining surface. Raising in-process concurrency had previously exposed Windows worker and fixture instability.

## Decision

The native inventory is partitioned by independent artifact ownership into three ordinary Windows jobs. `native build and runtime` owns the workspace build, production site, Electron runtime, built-output doc typecheck, package publication checks, NodeNext declarations, built package invariants, and built binary smokes. `native coverage` owns both complete coverage gates with the unchanged per-file 100% thresholds and eight isolated single-worker shards. `native static portability` owns source static policy, documentation checks other than the already-owned site and built doc typecheck, module graph, Knip, and duplication.

Two standard hosted Windows workers each own four of eight single-worker coverage partitions, run two partition processes at a time, and publish only their Vitest blobs. Four concurrent partition processes across the two workers retain parallel coverage without starving SQLite and subprocess tests inside one runner. A third Windows worker runs the coverage-exempt heavy inventory independently. After both blob owners succeed, a hosted Linux reducer downloads the complete self-contained report set and applies the repository-wide thresholds without executing tests or product code. The existing failover pool owns the same Windows shard and exempt-heavy work; the data-only reducer remains hosted Linux. Build/runtime and static portability remain independent standard hosted jobs. Each execution job has its own immutable install and 20-minute timeout, so setup duplication buys independent clocks without sharing mutable build output.

`windows node 24 / native verdict` runs after build/runtime, both coverage shards, coverage-exempt heavy suites, coverage reduction, and static portability. It fails when any owner fails, is cancelled, or is skipped. The owner jobs and verdict keep ordinary unmasked conclusions. The verdict remains outside the required `all checks passed` aggregate, while the Wine job remains required and unchanged.

The complete local aggregate is the exact concatenation of the three partition inventories. A gate-inventory test rejects duplicate or missing ids, removal of coverage thresholds, loss of built-output doc typecheck, or accidental conversion to allowed failure.

## Alternatives considered

**Increase top-level concurrency inside one job.** Rejected because the gates would still share one job clock and mutable tree, and prior high-concurrency trials reproduced worker and linker failures.

**Keep coverage reduction on Windows.** Rejected because Vitest blob reduction executes no platform code, while a second Windows setup serialized threshold calculation and the coverage-exempt suites after both shard owners.

**Drop duplicated Linux evidence from native Windows.** Rejected because platform-specific filesystem, process, declaration, documentation, and package behavior would disappear rather than become faster.

**Make the native verdict required for branch protection.** Rejected because Wine remains the bounded required win32 signal and Windows capacity must not block every merge.

## Consequences

The native verdict can conclude after the slowest Windows execution owner plus one data-only reduction instead of paying a second Windows execution tail. Each owner publishes its own structured gate report, so a failure identifies its first gate and completed sibling evidence. Hosted CI must demonstrate a successful native verdict within 15 minutes before the latency target is considered met; local topology alone is not proof.
