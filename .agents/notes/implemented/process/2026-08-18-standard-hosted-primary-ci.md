# Agent Note: Standard GitHub-hosted runners for primary CI

Status: implemented

English | [中文](2026-08-18-standard-hosted-primary-ci.zh.md)

## Problem

Pull-request CI cannot produce a result when a job resolves to an unprovisioned custom runner label. The three primary Linux jobs and the independent native Windows job used larger-runner labels that were absent from the repository, so their runs remained queued even while standard GitHub-hosted capacity was available.

## Decision

The three primary Node 24 Linux jobs resolve to `ubuntu-latest` by default, and the native Windows job resolves to `windows-latest` by default. The `DSH_CI_FAILOVER_LINUX` and `DSH_CI_FAILOVER_WINDOWS` repository variables still select the platform-specific self-hosted pools for trusted non-Dependabot pull requests. The [failover runbook](2026-07-26-ci-failover-runbook.md) owns that operation.

Standard-runner defaults bound process fan-out: Linux static work uses four top-level workers, coverage uses two top-level workers and two instrumented workers, consumer checks use four top-level workers and eight snapshot workers, and native Windows uses one top-level gate worker, one coverage worker, and one publint worker ([serial-gate decision](2026-08-23-hosted-windows-serial-gates.md)). The self-hosted branches retain their pool-specific inner-worker limits.

Custom larger-runner labels remain only in manually dispatched benchmark matrices. [CI workflow tests](../../../../scripts/ci-workflow.spec.ts) require standard default labels for the pull-request jobs and reject custom larger-runner labels in those selectors.

## Alternatives considered

**Use custom larger runners by default.** Larger runners reduce wall-clock time when provisioned, but a missing custom label leaves every matching job queued without a verdict. Manual benchmarks retain the performance-comparison path without making custom allocation a pull-request prerequisite.

**Use self-hosted runners by default.** This avoids custom hosted labels but makes an in-house machine the primary availability dependency. Explicit platform switches keep self-hosted capacity available for an incident without putting it on the normal path.

**Fall back automatically after a queue timeout.** GitHub Actions resolves `runs-on` before queueing and does not re-evaluate a job onto another label after a wait. Recovery therefore requires a new run after changing the corresponding repository variable.

## Consequences

Pull-request CI starts without repository-specific larger-runner provisioning, at the cost of longer Linux and native Windows execution on standard machines. Jobs already queued against an old custom label do not retarget; they must be cancelled and retriggered after a workflow with the standard selectors is available.

The first standard-runner execution also made pre-existing module-graph drift and undeclared external binaries in the committed Noise security proof visible. The generated graph is current, the proof's generated TypeScript declarations are excluded from unused-source analysis, and its environment-provided build tools are registered as ignored binaries; switching runner pools does not weaken the static gates.
