# Agent Note: Structured CI evidence and bounded retries

Status: implemented

English | [中文](2026-08-24-structured-ci-evidence.zh.md)

## Problem

Workflow conclusions did not identify the selected evidence, first failed gate, stage duration, or failure class. Aggregate checks, cancelled superseded runs, and long observational jobs also polluted latency and success calculations. Retrying an entire failed workflow concealed whether the original failure was a product defect or infrastructure transport failure.

## Decision

The CI planner JSON and every instrumented gate aggregate are uploaded as versioned artifacts. A gate report retains declaration-order stage results, actual completion order for the first blocking failure, durations, blocking status, process facts, stable failure classification, and related artifact names. The classification catalog distinguishes product regressions, coverage, snapshots, generated drift, workflow policy, runner contamination, and transient infrastructure.

Automatic retry is an explicit command wrapper, not a workflow-wide retry. It permits exactly one second attempt only when the first command's complete diagnostics match the narrow transient-infrastructure allowlist. The report retains both attempts. Assertions, coverage failures, snapshot drift, generated drift, policy failures, process signals, and unclassified failures are never retried.

`ci:metrics` computes one repeatable baseline from complete workflow and job timestamps. It excludes aggregate and observational jobs from lane samples and excludes incomplete, cancelled, skipped, or stale runs from the run population. It publishes the included and excluded run ids beside success rate and p50/p95 queue, execution, and first-conclusion durations.

The 2026-08-24 baseline queried the latest 20 main CI runs. Runs 32667140424, 32666575103, and 32665585148 were valid samples: success rate was 66.7%; queue p50/p95 was 11/24 seconds; execution p50/p95 was 691/718 seconds; and first valid conclusion p50/p95 was 22/43 seconds. The small valid population is retained as evidence of prior cancellation and supersession noise, not filled with invalid samples.

## Alternatives considered

**Parse human console summaries after failure.** Rejected because buffered and streamed gates use different output paths, and a console transcript does not provide a versioned schema or comparable population.

**Retry every failed task once.** Rejected because it hides deterministic regressions and doubles expensive work without changing the evidence.

**Use workflow conclusion and wall time directly.** Rejected because an observational failure can fail the workflow after the required verdict succeeded, while aggregate jobs duplicate conclusions and superseded runs contribute no completed sample.

## Consequences

CI changes can compare identical metrics and inspect exact gate evidence without reconstructing logs. A missing report remains visible through artifact upload warnings when failure occurs before the gate runner starts. New retryable diagnostics require an explicit allowlist and test change. New aggregate or observational job names require a metrics fixture update before they can affect the population.
