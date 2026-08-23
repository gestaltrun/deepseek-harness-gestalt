# Agent Note: Browser revision arbitration

Status: implemented

English | [中文](2026-08-19-browser-control-arbitration.zh.md)

## Problem

A person and Agent-driven operations may affect the same real tab. Without a shared revision, an Agent mutation based on a stale observation can overwrite a later page state or lose the Session, Profile, browser instance, and tab identity expected by the caller.

## Decision

Every open or unavailable page state carries the revision later mutations must match. Providers serialize every mutation and reject a stale `expectedRevision` with `BROWSER_REVISION_CONFLICT`; the conflict names the current revision and tells the Agent to observe again. `navigate`, `focus`, synthetic Agent `input`, and `close` advance the revision, while `observe` and `screenshot` are read-only. Session, Profile, browser instance, and tab identities stay stable across mutations.

`dsh-browser-workspace` persists each tab's latest revision on the Session `browser/workspace` snapshot so Session switch and reload restore the optimistic-concurrency fact. Browser tools do not set `ask` or a permission classifier; existing approval and permission capabilities apply only when a composition attaches them.

Reported ownership and its takeover/return operations are superseded by [removing reported Browser control and Workspace Dock state](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md). Direct Desktop page interaction remains independent of Runtime state; revision remains the sole concurrency mechanism.

## Alternatives considered

**Let last writer win without a revision check.** Rejected because a late Agent or Workbench command would silently overwrite a newer page or Provider recovery state.

**Give each writer a second browser instance or transferred page.** Rejected because callers need the exact Session, Profile, browser instance, and tab to remain addressable through a mutation sequence.

**Use a separate mutation version outside page state.** Rejected because the page state and Session Workspace snapshot already carry the revision that every writer observes and submits.

## Consequences

A stale mutation fails loudly and forces a fresh observation. Session snapshots retain the revision required by Workbench and tool mutations without reporting a control owner.

## Verification

- `pnpm exec vitest run packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/browser-workspace packages/browser/tool-browser`
- `pnpm exec vitest run packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/browser-workspace packages/browser/tool-browser --coverage --coverage.include='packages/browser/browser-runtime/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-deterministic/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-tandem/src/**/*.ts' --coverage.include='packages/browser/browser-workspace/src/**/*.ts' --coverage.include='packages/browser/tool-browser/src/**/*.ts'`
- `pnpm run test:snapshot -t 'temporary Browser Profile|Tandem Browser Profile'`
- Real Tandem e2e remains gated by `DSH_TANDEM_CHECKOUT` and `DSH_TANDEM_BIN` and covers both arrival orders when those are set.
