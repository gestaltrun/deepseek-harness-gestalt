# Agent Note: renderer-only Session faces for member-question receivers

Status: implemented

English | [中文](2026-08-30-web-receiving-experience-assembly-fixes.zh.md)

## Problem

Manager-level selection is insufficient for a receiving-session list row: without an outward `SessionFace`, `SessionRuntime` constructs a Host-backed `Session`, opens history, refreshes subagents, and exposes model, command, skill, queue, and prompt routes. The Decision Brief then has no real `PendingWait<'question'>` at the renderer seam. Read-triggered expiry is also insufficient because an already-mounted card can remain answerable past its carried deadline when no further delivery or snapshot read occurs.

The member-question card needs the `QuestionPresentation` value across dynamic plugin rows. Dynamic client rows require cross-plugin values through the supplier's `/client` module-table row rather than a static presentation subpath.

## Decision

`ReceivingQuestionBook` owns one identity-stable renderer-only `SessionFace` per route key and one real `PendingWait<'question'>` per pending record. The face publishes an open, non-blank conversation snapshot with empty Chat, queue, projection values, and history, plus only that pending wait. Repeated snapshot reads reuse the same wait object. The wait keeps the requested frame's original `sessionId` and rpc id for protocol response, while the face keeps the deterministic `mq-recv:*` id for rendering and navigation. Resolution, supersession, decline, cross-device settlement, and expiry call `markSettled()` and remove the wait before publishing the terminal state.

The book schedules exactly one injectable timer at the earliest active `expiresAt`. Adding, replacing, or settling a record recalculates that deadline; the timer publishes expiry without requiring another render or wire frame. Connection-generation death settles the exposed waits and cancels the timer without inventing a business outcome; replay mints fresh carriers only for requests the next generation still reports as pending. Runtime teardown cancels the same owned timer. This timer decision partially supersedes the read-triggered sweep in [receiving sessions and wire acceptance](2026-08-30-receiver-sessions-member-question-wire.md); that note remains authoritative for the carried intent, route key, deterministic renderer id, and terminal record states.

`SessionRuntime` binds every eligible id to an outward `SessionFace`, with an optional concrete Host `Session`. Only the Host variant binds the Agent scope dispatch point, opens or pages history, resynchronizes, refreshes subagents, and participates in scope-prune instance teardown. Receiving selection and reconnect skip subagent refresh, and model, command, and skill routing return unavailable. Calling a receiving face's prompt, cancellation, queue, rename, attachment, history, or command behavior fails loud instead of falling through to a Host RPC.

Receiving rows have no Host Workspace membership and therefore occupy the browser's Ungrouped account. The Workspace browser observes pending Ungrouped identities by arrival edge and opens that account once for each newly pending identity without changing the current Session. A human may collapse it afterward; ordinary updates to the same pending identity do not reopen it.

Cross-plugin value imports use the supplier's dynamic module-table row. `dsh-client-ui-user-questions/client` exports `QuestionPresentation`; `dsh-client-ui-member-questions` imports that row and declares it in `dsh.client.external`. The runtime declares its `dsh-user-questions` type dependency as peer plus development input, while the static `ui-slots` compile input of `ui-member-questions` remains development-only.

## Alternatives considered

**Admit the synthetic id only in `SessionManager.select`.** Rejected because selection is not the renderer seam. `SessionRuntime.currentProvideInfo` would still expose a Host-backed Session and trigger history and subagent RPCs.

**Create a Host Session with a silent-model convention.** Rejected because every ordinary Session carries Host mutation and model routes. The renderer-only face makes the absence of local model output structural.

**Expire only during delivery or snapshot reads.** Rejected because no read is guaranteed at the deadline. One earliest-deadline timer updates an already-mounted subscriber and avoids one timer per card.

**Add settlement state to `PendingWait`.** Rejected because pending-list membership remains the renderer contract. The existing private settled guard already makes late response attempts fail loud.

## Consequences

The standard Session renderer observes member questions through the same outward face and `PendingWait` interface as Host questions without granting Host authority. The receiving face deliberately cannot accept an ordinary human prompt; waking a local agent from a receiving session requires a separately owned admission design. A new receiving row becomes visible in the sidebar while the user's current Session remains selected.

Browser E2E and the required demonstration GIF remain separate acceptance evidence; this decision records only the React-free runtime and client assembly behavior.

## Testing

`packages/client/runtime/tests/receiving.client.spec.ts` drives a real `SessionRuntime` with `FakeApiClient`, selects the synthetic row, and observes `currentProvideInfo.hooks.session.getSnapshot()`. It pins wait identity, original protocol Session identity, resolution, supersession, timer expiry, disconnect settlement and replay, unavailable model, command, skill, and prompt routes, and zero `session.create`, history, subagent, model, skill, or prompt calls. `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` pins arrival-edge expansion and post-arrival human collapse. `apps/web/tests/member-question-receiving.e2e.ts` drives a mock remote Agent through the shipped user-questions provider, api-proxy pending registry, WebSocket mux, Client Runtime, dynamic module table, composite card, shared question presentation, document focus, and response POST; it asserts no additional Host Session, `session.create`, `session.history`, or model call. `pnpm run build:lib:client` and `pnpm run verify-client-packages` cover the client module row and package declarations.
