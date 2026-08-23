# Agent Note: Native Windows complete lane serializes top-level gates

Status: implemented

English | [中文](2026-08-23-hosted-windows-serial-gates.zh.md)

## Problem

The native Windows complete lane runs the full build, runtime, coverage, heavy-test, and publication inventory on one host. Two top-level gate workers let the instrumented coverage inventory overlap the exempt-heavy inventory. Serializing those gates removed that overlap, but the instrumented gate still started all eight single-worker shards together on standard hosted Windows. Both schedules exhausted the runner: unrelated process hooks and polling tests exceeded their owned budgets, completed branches disappeared from V8 coverage, and the failing test set changed between otherwise identical runs. Raising individual timeouts could not make an overloaded run deterministic.

## Decision

`windows-native` sets `DSH_GATE_CONCURRENCY=1` on hosted `windows-latest` and on the `dsh-win-ci` failover pool. The complete inventory remains unchanged and executes one ready top-level gate at a time. It keeps eight in-job coverage shards but sets `DSH_COVERAGE_PARTITION_CONCURRENCY=1` on standard hosted capacity; the 16-core failover pool retains its measured eight-way shard fan-out. `DSH_COVERAGE_MAX_WORKERS`, 30-second coverage test budgets, full-history checkout, and the 120-minute job deadline remain independent bounds.

The prior [two-worker decision](../../archived/process/2026-08-20-hosted-windows-two-gate-workers.md) is historical evidence for the wall-clock trade-off. The complete lane keeps its full supported-source denominator; serialization changes scheduling, not coverage or platform support.

## Alternatives considered

**Keep two top-level workers and raise test timeouts.** The overlapping inventories produced empty or partial observations, hook teardown failures, and different missing coverage branches across runs. Larger budgets retain the resource race and make failures slower.

**Raise `DSH_COVERAGE_MAX_WORKERS`.** Additional instrumented workers increase memory and process pressure. Earlier Windows runs already showed worker exits and Node lexer failures above the single hosted coverage worker.

**Remove coverage or heavy tests from the complete lane.** That shortens the job by deleting native Windows evidence rather than making the same evidence reliable.

**Split the inventory into more workflow jobs.** Separate runners could restore parallelism, but they repeat checkout and installation and require a new aggregation topology. The serial in-job schedule is the smallest change that preserves the current inventory and failure ownership.

## Consequences

The hosted lane takes roughly the sum of its two coverage inventories and runs the eight instrumented shards sequentially, so latency increases while remaining bounded by the 120-minute job deadline. In return, one instrumented process owns the runner at a time, coverage reflects completed tests, and test-owned timeouts again indicate local defects rather than scheduler starvation. The required Wine job and `all-checks-passed` graph are unchanged; `windows-native` remains an independent native-kernel signal.
