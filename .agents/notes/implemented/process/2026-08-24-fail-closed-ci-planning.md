# Agent Note: Fail-closed CI planning and preflight

Status: implemented

English | [中文](2026-08-24-fail-closed-ci-planning.zh.md)

## Problem

Pull-request workflow routing was encoded directly in job conditions, while tracker policy, generated-state checks, and local change inspection used separate inputs. A missing base, unknown path, stale catalog, or malformed PR could therefore produce inconsistent local and hosted decisions or consume expensive runner capacity before rejection.

## Decision

`planCi(input)` owns a versioned deterministic plan over the event, PR readiness, resolved base and head, changed paths, module-graph digest, versioned risk catalog, lockfile digest, workflow digest, and toolchain digest. Its output identifies affected areas, escalation reasons, required and observational lanes, and an evidence key derived from the normalized input. Unknown or unavailable input selects exhaustive evidence and records why.

The pull-request workflow admits all evidence jobs through one `preflight` verdict. A plan worker validates workflow semantics, computes the plan, and requires PR metadata to include every affected area. Three generated-state workers partition the generated catalogs, translation pairing, module graph, and workspace constraints over independent immutable installs. The verdict fails unless the plan worker and every generated-state partition succeed, then forwards only the plan worker's routing and proof outputs to evidence jobs.

`pnpm ci:plan` is the local projection of the same planner. `pnpm pr:create` is the supported publication path: it verifies the same-repository Issue and creates a Draft PR with one declared kind plus the union of declared and planner-selected areas.

## Alternatives considered

**Keep independent path filters in workflow jobs.** Rejected because duplicated routing rules drift and cannot explain one repository-wide decision.

**Treat unavailable inputs as an empty diff.** Rejected because a shallow checkout, deleted ref, or new path would silently weaken evidence.

**Validate PR metadata only after a PR becomes ready.** Rejected because Draft iteration is the cheapest point to correct missing Issue, kind, and area metadata.

## Consequences

Every pull request receives one inspectable plan before expensive work starts. Planner or repository uncertainty increases evidence instead of reducing it. Adding a new change surface requires extending the risk catalog and its plan fixtures; adding a new generated projection requires adding its check to exactly one preflight partition. The complete local `check:ci:preflight` aggregate remains the union of those partitions. The [Draft impact decision](2026-08-24-draft-impacted-evidence.md) owns the narrower plan level without changing this fail-closed input and evidence-key contract.
