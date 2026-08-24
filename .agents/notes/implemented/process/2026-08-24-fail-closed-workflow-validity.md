# Agent Note: Fail-closed GitHub Actions workflow validity

Status: implemented

English | [中文](2026-08-24-fail-closed-workflow-validity.zh.md)

## Problem

GitHub rejects a workflow before allocating any job when a job-construction field references a context that exists only after runner allocation. The resulting push run has no jobs or logs, so ordinary repository tests and later CI jobs cannot diagnose it. YAML parsing and repository topology assertions do not implement GitHub Actions expression semantics, while a general workflow linter may omit position-specific context restrictions.

## Decision

The pull-request `preflight` job runs the maintained actionlint image against every workflow before any other pull-request evidence job is admitted. Every other CI job depends on this result, and the required aggregate includes it.

`.github/actionlint.yaml` declares repository-owned runner labels and only the intentional disabled macOS reference job exception. Workflow files otherwise satisfy actionlint without ignored diagnostics.

The repository workflow test supplements actionlint with the job-construction restriction that caused the zero-job failure: job-level `env` values cannot reference `runner`. Values that need `runner.temp` belong in step-level `env` or step commands, after GitHub allocates the runner. The test exercises an invalid fixture and scans every workflow so a recurrence fails locally and in CI.

The Desktop Release workflow test also requires the dispatch default version to equal `apps/desktop/package.json`. GitHub can accept a workflow whose default input is stale, but the preparation job rejects that dispatch before packaging, so version alignment is part of workflow validity.

## Alternatives considered

**Rely only on GitHub parsing after push.** Rejected because an invalid workflow disables its own checks and produces a zero-job failure without an actionable log.

**Reimplement all GitHub Actions expression rules in repository tests.** Rejected because GitHub evolves the language and a local copy would drift. actionlint owns general workflow semantics; repository tests cover only confirmed gaps that affect this workflow inventory.

**Run workflow validation alongside the expensive jobs.** Rejected because the validator must prevent invalid input from consuming coverage, snapshot, platform, and artifact capacity.

## Consequences

Pull requests spend one short hosted preflight before allocating expensive evidence jobs. A workflow-lint failure blocks the required verdict and names the invalid file and location. Repository-specific context restrictions remain explicit tests rather than silent actionlint suppressions. A manual Desktop Release dry run remains the end-to-end proof that GitHub accepts the dispatch and Desktop Bundle packaging path; workflow validation does not publish a release.
