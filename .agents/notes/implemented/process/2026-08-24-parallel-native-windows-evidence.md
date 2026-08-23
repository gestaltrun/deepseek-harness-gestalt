# Agent Note: Parallel native Windows evidence

Status: implemented

English | [中文](2026-08-24-parallel-native-windows-evidence.zh.md)

## Problem

The complete native Windows inventory ran serially in one hosted job. A successful observed run spent 44 minutes and 1 second from job start to completion, so reviewers waited long after the required Wine verdict and one late gate could hide the status of every remaining surface. Raising in-process concurrency had previously exposed Windows worker and fixture instability.

## Decision

The native inventory is partitioned by independent artifact ownership into three ordinary Windows jobs. `native build and runtime` owns the workspace build, production site, Electron runtime, built-output doc typecheck, package publication checks, NodeNext declarations, built package invariants, and built binary smokes. `native coverage` owns both complete coverage gates with the unchanged per-file 100% thresholds and eight isolated single-worker shards. `native static portability` owns source static policy, documentation checks other than the already-owned site and built doc typecheck, module graph, Knip, and duplication.

The coverage job runs four shard processes concurrently on `windows-latest` and eight on the existing failover pool. Its exempt-heavy gate shares a two-gate top-level budget with partitioned coverage. Each job has its own immutable install and 20-minute timeout, so setup duplication buys independent clocks without sharing mutable build output.

`windows node 24 / native verdict` runs after all three partitions and fails when any partition fails, is cancelled, or is skipped. The partition jobs and verdict keep ordinary unmasked conclusions. The verdict remains outside the required `all checks passed` aggregate, while the Wine job remains required and unchanged.

The complete local aggregate is the exact concatenation of the three partition inventories. A gate-inventory test rejects duplicate or missing ids, removal of coverage thresholds, loss of built-output doc typecheck, or accidental conversion to allowed failure.

## Alternatives considered

**Increase top-level concurrency inside one job.** Rejected because the gates would still share one job clock and mutable tree, and prior high-concurrency trials reproduced worker and linker failures.

**Drop duplicated Linux evidence from native Windows.** Rejected because platform-specific filesystem, process, declaration, documentation, and package behavior would disappear rather than become faster.

**Make the native verdict required for branch protection.** Rejected because Wine remains the bounded required win32 signal and Windows capacity must not block every merge.

## Consequences

The native verdict can conclude at the duration of the slowest partition instead of the sum of all inventories. Each partition publishes its own structured gate report, so a failure identifies its first gate and completed sibling evidence. Hosted CI must demonstrate a successful native verdict within 15 minutes before the latency target is considered met; local topology alone is not proof.
