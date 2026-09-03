# Agent Note: identity-stable Session faces for member-question receivers

Status: implemented

English | [中文](2026-08-30-web-receiving-experience-assembly-fixes.zh.md)

## Problem

Manager-level selection is insufficient for a receiving-session list row: without an outward `SessionFace`, `SessionRuntime` constructs a Host-backed `Session`, opens history, refreshes subagents, and exposes model, command, skill, queue, and prompt routes. The Decision Brief then has no real `PendingWait<'question'>` at the renderer seam. The face must adapt Host receiver state without acquiring expiry or settlement authority.

The member-question card needs the `QuestionPresentation` value across dynamic plugin rows. Dynamic client rows require cross-plugin values through the supplier's `/client` module-table row rather than a static presentation subpath.

## Decision

`ReceivingQuestionBook` owns one identity-stable `SessionFace` per Host `ReceivingSessionId` and one real `PendingWait<'question'>` per pending record. Before materialization the face publishes an open, non-blank conversation snapshot with empty Chat, queue, projection values, and history, plus the pending wait and public terminal record bands. Repeated snapshot reads reuse the same wait object. Answer or decline uses the exact Host settlement RPC; a higher Host revision settles and replaces the wait before publishing the next pending or terminal projection.

The book applies only higher-revision complete Host snapshots. Disconnect retains its rows and waits without inventing a terminal; reconnect or browser reload adopts the Host baseline, including terminal-only rows that were never materialized locally. Expiry, supersession, withdrawal, and canonical settlement winners are Host facts. The card's countdown is display-only.

`SessionRuntime` binds every eligible id to an outward `SessionFace`, with an optional concrete Host `Session`. Only a materialized face binds the Agent scope dispatch point, opens or pages history, resynchronizes, refreshes subagents, and participates in scope-prune instance teardown. Before materialization, receiving selection and reconnect skip subagent refresh, model/command/skill routing returns unavailable, and prompt calls only the member-question admission RPC. A snapshot with the authoritative `hostSessionId` binds the existing face to the Host-backed Session without replacing its row, pending waits, or terminal records.

Receiving rows that already have a Host Workspace membership appear under that Workspace. The Workspace browser observes pending identities by arrival edge and opens the bound Workspace, or Ungrouped when the Host list has not yet attached the Session, once for each newly pending identity without changing the current Session. A human may collapse it afterward; ordinary updates to the same pending identity do not reopen it.

Cross-plugin value imports use the supplier's dynamic module-table row. `dsh-client-ui-user-questions/client` exports `QuestionPresentation`; `dsh-client-ui-member-questions` imports that row and declares it in `dsh.client.external`. The runtime declares its `dsh-user-questions` type dependency as peer plus development input, while the static `ui-slots` compile input of `ui-member-questions` remains development-only.

## Alternatives considered

**Admit the receiving id only in `SessionManager.select`.** Rejected because selection is not the renderer seam. `SessionRuntime.currentProvideInfo` would still expose a Host-backed Session and trigger history and subagent RPCs.

**Create a Host Session with a silent-model convention.** Rejected because every ordinary Session carries Host mutation and model routes. The renderer-only face makes the absence of local model output structural.

**Let the browser settle expiry or supersession.** Rejected because disconnected Clients can disagree and cannot publish the canonical cross-Installation result. The Host receiver owns its clock, first claim, and durable terminal.

**Add settlement state to `PendingWait`.** Rejected because pending-list membership remains the renderer contract. The existing private settled guard already makes late response attempts fail loud.

## Consequences

The standard Session renderer observes member questions through the same outward face and `PendingWait` interface as Host questions without granting business authority. The receiving card mounts the shared input state; explicit submission calls the single Host admission RPC, and failures retain the draft with an actionable diagnostic. A new receiving row becomes visible in the sidebar while the user's current Session remains selected.

Browser E2E and the required demonstration GIF remain separate acceptance evidence; this decision records only the React-free runtime and client assembly behavior.

## Testing

`packages/client/runtime/tests/receiving.client.spec.ts` drives real `SessionRuntime` instances with `FakeApiClient`, selects Host-id rows, and observes `currentProvideInfo.hooks.session.getSnapshot()`. It pins Host revision ordering, answer and decline RPCs, disconnect retention, terminal projection, two-Installation answered-elsewhere derivation, product-composer admission, reserved `rpcId` recovery, and zero renderer `session.create` calls. `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` pins arrival-edge expansion and post-arrival human collapse. `apps/web/tests/member-question-receiving.e2e.ts` drives authenticated ingress through the shipped Host receiver, API Proxy, WebSocket Host stream, Client Runtime, dynamic module table, additive Decision Brief dock, product composer, shared question presentation, exceptional terminal bands, restart, and reload; it asserts identical recovered pending/terminal records, one Host Session in the bound Workspace, and no arrival model request. `pnpm run build:lib:client` and `pnpm run verify-client-packages` cover the client module row and package declarations.
