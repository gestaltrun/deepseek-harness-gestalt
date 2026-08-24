# Agent Note: Hosted CI cache producer

Status: implemented

English | [中文](2026-08-24-hosted-ci-cache-producer.zh.md)

## Problem

Pull-request jobs restored dependency and browser caches, but no default-branch owner produced their namespace. Old merge-ref entries could survive temporarily, then evict and turn every restore cold without a visible explanation. Broad fallback keys also risked crossing a Node, pnpm, architecture, or lockfile change, while caching workspace dependencies would import mutable build state.

## Decision

`CI cache producer` runs on each master push, daily, and by manual dispatch for hosted Linux x64 and Windows x64. It pins Node 24 and pnpm 11.7.0, configures the platform's content-addressed pnpm store, performs an immutable install, provisions Playwright Chromium, and saves only those two owned cache directories.

PowerShell setup assigns `PNPM_CONFIG_STORE_DIR` in the current process before resolving `pnpm store path`, then also exports it through `GITHUB_ENV` for later steps. The cache action therefore owns the same versioned directory that the following install populates; writing only to `GITHUB_ENV` would leave the current resolution on the temporary `pnpm/action-setup` store, which is removed during post-job cleanup.

Producer and consumer keys share the exact form: repository namespace, OS, architecture, Node, pnpm, cache kind, and lockfile digest. Restore fallback removes only the final lockfile digest, so it never crosses an environment component. Pull-request workers use restore-only actions and retain unconditional install and Playwright provisioning, making a miss or stale lockfile a cold but correct path.

Gate reports parse a versioned cache-evidence array supplied by the workflow and record each cache id, primary key, matched key, and exact-hit boolean. Workflow contract tests pin producer triggers, platform matrix, keys, fallback prefixes, clean installs, consumer restores, PowerShell current-process configuration before path resolution, and the absence of `node_modules` cache paths.

## Alternatives considered

**Let pull requests save their own caches.** Rejected because merge-ref cache scope does not establish a stable default-branch producer and upload latency belongs outside the feedback-critical path.

**Use broad OS-only restore prefixes.** Rejected because architecture, Node, or pnpm changes could reuse an incompatible store.

**Cache workspace `node_modules`.** Rejected because linked workspaces and generated outputs are mutable state rather than content-addressed dependency downloads.

## Consequences

Warm installs and browser setup have an explicit producer and auditable consumer outcome. Cold caches remain a supported path, not a failure. The first hosted runs provide the before/after setup samples; future Node, pnpm, or platform changes create a new namespace automatically.
