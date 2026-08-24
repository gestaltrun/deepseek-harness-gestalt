# Agent Note: Merge Queue candidate evidence

Status: implemented

English | [中文](2026-08-24-merge-queue-candidate-evidence.zh.md)

## Problem

A ready pull request proved its head against the base observed when the run started. A later base update could change the integrated tree without producing one complete conclusion over that exact candidate. Draft feedback also shared the same workflow topology as merge admission even though iteration and admission have different latency and confidence requirements.

## Decision

The CI workflow listens to `merge_group` and checks out GitHub's synthetic candidate merge commit. Preflight reads the event's `base_sha` and `head_sha`; the planner always selects exhaustive evidence for this non-PR event and marks every lane required. Pull-request metadata policy is skipped because a merge-group payload is not a pull request.

Every exhaustive worker accepts a planner-selected merge-group lane. The candidate uses hosted runners rather than repository failover overrides that are scoped to a pull-request author. Coverage, assembled snapshots and artifacts, supported Node versions, both SDK projections, the release-shaped Python runtime, Wine, all native Windows partitions, and macOS Electron must succeed.

`candidate verdict` is the only merge-group conclusion intended for branch protection. It runs with `always()`, requires an exhaustive plan, and rejects every failed, cancelled, or unexpectedly skipped required dependency. The Draft and ready pull-request verdict remains `all checks passed`; a known low-risk Draft still selects only impacted evidence.

After the dependency verdict succeeds, the job checks out the candidate tree, installs the pinned pnpm and Node toolchain, and performs an immutable dependency installation before completing the attestation with the repository CLI. Worker-job setup does not cross the GitHub Actions job boundary; the verdict's toolchain preparation is therefore part of the proof path and is pinned by the workflow contract test.

## Alternatives considered

**Treat a ready PR head as the merge proof.** Rejected because it does not identify the exact tree formed after newer base commits or queue peers.

**Require every matrix job directly in branch protection.** Rejected because job names and matrices evolve; one stable verdict owns the complete dependency inventory and fail-closed semantics.

**Run candidate proof on every Draft synchronization.** Rejected because the impacted planner already provides bounded iteration feedback and admission requires a distinct event over the candidate tree.

## Consequences

Merge Queue may admit only a tree whose complete platform and artifact inventory has one successful verdict. Adding or renaming an exhaustive job requires updating the candidate dependency and contract test. Pull-request feedback remains independent, so Draft updates do not launch merge-only exhaustive proof.
