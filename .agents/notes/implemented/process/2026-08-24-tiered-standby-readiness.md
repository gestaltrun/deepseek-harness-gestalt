# Agent Note: Tiered standby readiness

Status: implemented

English | [中文](2026-08-24-tiered-standby-readiness.zh.md)

## Problem

The persistent Linux and Windows standby pools ran complete unsharded inventories after every master push. Those long drills could overlap ordinary merge traffic, while retained workspace outputs and dependency trees made a green result depend on mutable runner state. Their failures also looked like product regressions even when the required hosted path remained healthy.

## Decision

Every master push runs one bounded smoke on each standby platform. Each job cleans all ignored and untracked workspace state, rebuilds `node_modules` with optional dependencies enabled, and retains only a content-addressed pnpm store outside the checkout. Repository-owned `supportedArchitectures` pins ordinary installs to the current OS, CPU, and libc so a persistent runner's global pnpm configuration cannot expand the dependency tree to every platform. Standby installs do not use pnpm's `--force` option because that option deliberately installs optional dependencies which do not satisfy the current environment; a clean checkout already guarantees a rebuilt modules directory. The isolated Wine snapshot explicitly adds Windows to that matrix. Immediately after installation, each standby job executes the current Codex and Claude Code payloads; missing optional downloads therefore fail before a build or exhaustive inventory starts. The smoke then proves optional dependency imports, the official package and Web builds, Browser Runtime behavior, and platform-specific filesystem, process, session, or Electron fixtures. Each job has a 20-minute timeout and publishes a structured readiness report with the independent failover switch in its summary.

Complete unsharded Linux and Windows inventories run daily and through the explicit `standby-exhaustive` workflow dispatch. They perform the same clean install before running the existing serial aggregates with a 120-minute timeout. Their reports override failure classification to `failover-readiness`; the bounded smoke gates carry that failure domain directly. CI metrics therefore retain the evidence without counting a standby failure as a product regression.

The Linux and Windows failover variables remain independent. A responder checks the latest platform smoke and exhaustive artifact before setting only the affected platform variable to `selfhosted` and rerunning the blocked pull request.

## Alternatives considered

**Run both complete inventories on every master push.** Rejected because repeated long serial work delays readiness conclusions and competes with the pool it is meant to keep available.

**Run only the daily complete inventories.** Rejected because a broken checkout, install, build, Browser Runtime, or platform fixture could remain undiscovered for a day after a master change.

**Retain `node_modules` and build outputs between drills.** Rejected because those mutable trees can conceal missing optional dependencies or make the result depend on a previous checkout. Only content-addressed dependency downloads and controlled machine tools survive.

## Consequences

Each master change gets bounded platform readiness evidence, while the slower completeness proof has an explicit daily and manual owner. A first master push and manual exhaustive dispatch must demonstrate both platforms on their real runners; local execution proves the Linux smoke inventory but cannot substitute for that hosted evidence.
