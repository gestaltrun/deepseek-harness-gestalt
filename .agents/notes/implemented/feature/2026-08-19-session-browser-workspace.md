# Agent Note: Session-owned Browser Workspace

Status: implemented

English | [中文](2026-08-19-session-browser-workspace.zh.md)

## Problem

A Session can open a Browser Profile, but the Runtime still treats Workspaces, instances, and tabs as process-global identities. Switching Session, reloading, or opening a second Session therefore cannot restore that Session's Dock, instances, and tabs without exposing another Session's pages.

## Decision

`dsh-browser-workspace` binds Browser Runtime identities to one Session log. Each Session independently owns zero or more Workspaces. Each Workspace uses one Browser Profile and contains multiple browser instances and tabs. `browser/workspace` is a log-only, last-wins whole-value Session event. The fold restores instances, active instance, tabs, each tab's last committed revision, and active tab after Session switch and reload.

Browser Runtime pages remain live process state. When retained-Profile matching reaches a logged target that the current Runtime reports as `BROWSER_NOT_FOUND`, the Binder forgets that target and continues matching and creation; other observe failures remain fatal. A Runtime process restart therefore replaces missing pages on the next create instead of treating logged ownership as proof that a page is live.

Runtime `create` may attach a new instance to an existing Workspace or a new tab to an existing instance. Named Profiles still reject a second independent writer with `BROWSER_PROFILE_BUSY`; attaching to an already-open named Profile is the same writer adding another instance or tab. The Consumer routes through the Binder when a calling Agent Session is present and the Binder is composed. Cross-Session page transfer is rejected with `BROWSER_TRANSFER_UNSUPPORTED`. Attach to another live Session's Workspace or instance is also `BROWSER_TRANSFER_UNSUPPORTED`; attach unknown to this Session is `BROWSER_SESSION_MISMATCH`. Session disposal returns leftover-tab cleanup and forgets those tabs from the Session snapshot.

Headless Browser Runtime snapshots stay Binder-free because they prove Consumer discovery and rendered Runtime facts, not Session isolation. Session-local ownership is claimed only where the Binder is composed.

Each tab's last committed revision is a Session fact so projection restores optimistic concurrency; the [tab revision Agent Note](../bug-fix/2026-08-20-dock-tab-revision.md) owns that listing rule. Workbench panel visibility and width belong to better-sidebar. The [reported Browser control and Dock-state removal](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md) owns the reduced payload and implicit matching-Profile reuse.

## Alternatives considered

**Keep Workspace ownership only in live Runtime memory.** Rejected because Session switch and reload must restore the same instances and tabs from durable Session facts.

**Add a second account or page-transfer service.** Rejected because the ticket forbids cross-Session transfer and a second identity concept.

**Persist Workbench panel geometry in the Browser payload.** Rejected because better-sidebar already owns per-Session presentation state; a second authority can disagree after switch or reload.

## Consequences

Two Sessions can own isolated Workspaces over the same Runtime. Reload reconstructs tab ownership and each tab's last committed revision from the Session log. A Runtime process restart prunes missing targets during the next retained-Profile create. Named Profiles remain isolated identities.

## Verification

- `pnpm exec vitest run packages/browser/browser-workspace packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/tool-browser`
- `pnpm exec vitest run packages/browser/browser-workspace packages/browser/browser-runtime packages/browser/browser-runtime-deterministic packages/browser/browser-runtime-tandem packages/browser/tool-browser --coverage --coverage.include='packages/browser/browser-workspace/src/**/*.ts' --coverage.include='packages/browser/browser-runtime/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-deterministic/src/**/*.ts' --coverage.include='packages/browser/browser-runtime-tandem/src/**/*.ts' --coverage.include='packages/browser/tool-browser/src/**/*.ts'`
- `pnpm run test:snapshot -t 'temporary Browser Profile|Tandem Browser Profile'`
