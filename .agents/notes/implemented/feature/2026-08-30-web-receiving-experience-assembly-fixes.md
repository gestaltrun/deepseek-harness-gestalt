# Agent Note: renderer-only Session faces for member-question receivers

Status: implemented

English | [中文](2026-08-30-web-receiving-experience-assembly-fixes.zh.md)

## Problem

Manager-level selection is insufficient for a receiving-session list row: without an outward `SessionFace`, `SessionRuntime` constructs a Host-backed `Session`, opens history, refreshes subagents, and exposes model, command, skill, queue, and prompt routes. The Decision Brief then has no real `PendingWait<'question'>` at the renderer seam. The face must adapt Host receiver state without acquiring expiry or settlement authority.

The member-question card needs the `QuestionPresentation` value across dynamic plugin rows. Dynamic client rows require cross-plugin values through the supplier's `/client` module-table row rather than a static presentation subpath.

## Decision

`ReceivingQuestionBook` owns one identity-stable renderer-only `SessionFace` per Host `ReceivingSessionId` and one real `PendingWait<'question'>` per pending record. The face publishes an open, non-blank conversation snapshot with empty Chat, queue, projection values, and history, plus the pending wait and public terminal record bands. Repeated snapshot reads reuse the same wait object. Answer or decline uses the exact Host settlement RPC; a higher Host revision settles and replaces the wait before publishing the next pending or terminal projection.

The book applies only higher-revision complete Host snapshots. Disconnect retains its rows and waits without inventing a terminal; reconnect or browser reload adopts the Host baseline, including terminal-only rows that were never materialized locally. Expiry, supersession, withdrawal, and canonical settlement winners are Host facts. The card's countdown is display-only.

`SessionRuntime` binds every eligible id to an outward `SessionFace`, with an optional concrete Host `Session`. Only the Host variant binds the Agent scope dispatch point, opens or pages history, resynchronizes, refreshes subagents, and participates in scope-prune instance teardown. Receiving selection and reconnect skip subagent refresh, and model, command, and skill routing return unavailable. Calling a receiving face's prompt, cancellation, queue, rename, attachment, history, or command behavior fails loud instead of falling through to a Host RPC.

Receiving rows have no Host Workspace membership and therefore occupy the browser's Ungrouped account. The Workspace browser observes pending Ungrouped identities by arrival edge and opens that account once for each newly pending identity without changing the current Session. A human may collapse it afterward; ordinary updates to the same pending identity do not reopen it.

Cross-plugin value imports use the supplier's dynamic module-table row. `dsh-client-ui-user-questions/client` exports `QuestionPresentation`; `dsh-client-ui-member-questions` imports that row and declares it in `dsh.client.external`. The runtime declares its `dsh-user-questions` type dependency as peer plus development input, while the static `ui-slots` compile input of `ui-member-questions` remains development-only.

## Alternatives considered

**Admit the receiving id only in `SessionManager.select`.** Rejected because selection is not the renderer seam. `SessionRuntime.currentProvideInfo` would still expose a Host-backed Session and trigger history and subagent RPCs.

**Create a Host Session with a silent-model convention.** Rejected because every ordinary Session carries Host mutation and model routes. The renderer-only face makes the absence of local model output structural.

**Let the browser settle expiry or supersession.** Rejected because disconnected Clients can disagree and cannot publish the canonical cross-Installation result. The Host receiver owns its clock, first claim, and durable terminal.

**Add settlement state to `PendingWait`.** Rejected because pending-list membership remains the renderer contract. The existing private settled guard already makes late response attempts fail loud.

## Consequences

The standard Session renderer observes member questions through the same outward face and `PendingWait` interface as Host questions without granting business authority. The receiving face reports a disabled composer phase and rejects ordinary human prompts; waking a local agent from a receiving Session requires the separately owned admission adapter. A new receiving row becomes visible in the sidebar while the user's current Session remains selected.

Browser E2E and the required demonstration GIF remain separate acceptance evidence; this decision records only the React-free runtime and client assembly behavior.

## Testing

`packages/client/runtime/tests/receiving.client.spec.ts` drives real `SessionRuntime` instances with `FakeApiClient`, selects Host-id rows, and observes `currentProvideInfo.hooks.session.getSnapshot()`. It pins Host revision ordering, answer and decline RPCs, disconnect retention, terminal projection, two-Installation answered-elsewhere derivation, disabled composer and zero `session.create`, history, or prompt calls. `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` pins arrival-edge expansion and post-arrival human collapse. `apps/web/tests/member-question-receiving.e2e.ts` drives authenticated ingress through the shipped Host receiver, API Proxy, WebSocket Host stream, Client Runtime, dynamic module table, composite card, shared question presentation, terminal bands, restart, and reload; it asserts identical recovered pending/terminal records and no additional Host Session, `session.create`, `session.history`, or model call. `pnpm run build:lib:client` and `pnpm run verify-client-packages` cover the client module row and package declarations.
