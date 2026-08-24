# Agent Note: Draft impacted evidence

Status: implemented

English | [中文](2026-08-24-draft-impacted-evidence.zh.md)

## Problem

Every Draft change paid for the complete platform, artifact, SDK, and Windows matrix even when the repository could identify a small package change and its consumers. Path-only filtering was insufficient because it could omit downstream packages, changed-source coverage, or assembled behavior while silently treating unknown inputs as low risk.

## Decision

The CI Planner has two levels. A ready pull request and every non-pull-request event select `exhaustive`. A Draft selects `impacted` only when the diff, package graph, and risk catalog are available, every path is known, and no escalation rule matches.

The package graph maps changed package paths to direct packages and closes transitively over reverse peer-dependency consumers. The Draft impact command runs Vitest over those package directories. Existing changed source files are explicit coverage includes, so repository 100% per-file thresholds apply without measuring unrelated source. Test-only or documentation-only package changes run the same package and reverse-consumer tests without inventing a repository-wide coverage requirement.

Documentation paths select the static documentation lane. GUI and model-visible paths select the assembled consumer lane in addition to package impact. Electron Browser Runtime paths select the macOS runtime lane. Workflow, lockfile, toolchain, vendor, protocol, session lifecycle, agent-loop, build-system, cross-product-area, empty, unavailable, and unknown changes select exhaustive evidence.

The stable aggregate verdict evaluates only lanes selected by the plan. In an impacted Draft it requires preflight, package impact when present, and the assembled consumer lane when selected. In an exhaustive plan it requires the complete blocking inventory. A selected lane that fails, is cancelled, or is skipped fails the verdict; an unselected lane remains skipped without becoming a false failure.

## Alternatives considered

**Filter only by changed directories.** Rejected because direct paths do not identify reverse consumers and cannot prove behavior at package interfaces.

**Run package tests without explicit coverage includes.** Rejected because a changed but unloaded source file could disappear from the coverage population.

**Use impacted routing for ready review.** Rejected because the merge candidate requires complete integration and platform evidence independent of Draft iteration history.

## Consequences

Low-risk Draft iterations obtain focused evidence without consuming the full matrix. The same planner and impact command are available locally from explicit base and head refs. Package manifest changes alter the graph used for that decision; graph unavailability escalates. Adding a new product-visible or high-risk path requires a risk fixture that proves its assembled lane or exhaustive escalation.
