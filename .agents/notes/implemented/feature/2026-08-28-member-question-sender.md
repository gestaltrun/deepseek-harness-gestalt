# Agent Note: member-directed ask_user_question routes through an injectable codec sender

Status: implemented

English | [中文](2026-08-28-member-question-sender.zh.md)

## Problem

Ticket #343 wants `ask_user_question` to address one project member. The T4 Companion codec already owns the `member-question` operation, and Remote Access already owns project-peer grants, but neither package is a model-facing Consumer: the tool must keep talking to `ctx.userQuestions` for local asks, and a new sender must encode and deliver without inventing a second protocol. Cross-machine registry transport is still the recorded T4 gap, so a sender that called Relay directly would either lie about delivery or block the milestone.

## Decision

Member-directed asking extends `ask_user_question` with parameters rather than a second model-facing tool. A new tool would split one question vocabulary across two names, force the model to choose a sibling, and still share the local answer JSON. The standing `ask_user_question` schema therefore grows `to_project_member`, `background`, and `references`. `to_project_member` is mutually exclusive with the local provider: when present, the tool never calls `ctx.userQuestions.ask()` and instead calls `ctx.memberQuestionSender.send()`. `background` is required only in routed mode and is rejected at construction with `BACKGROUND_REQUIRED` or `BACKGROUND_TOO_LONG` against the T4 600 code-point ceiling. `references` is a standing parameter for local and routed asks; each `path` must exist inside the asking session workspace and each `reason` is at most 100 code points, or the tool throws `REFERENCES_INVALID` naming the failing items.

Runtime eligibility is a prompt-assembly filter, not a second registered definition. Name-level `tools-eligibility` allow-lists cannot hide one property of a live tool, so `tool-ask-user` listens on `system-prompt/assemble`, calls `boundProjectResolver`, and omits `to_project_member` from the assembled schema unless that resolver returns a cloud-project id. A rejecting or absent resolver is unbound. `ctx.tools.schemas()` and the generated catalog retain the static schema, so a later bind cannot leak a stale parameter into the next request and an unbound workspace never sees the routing argument.

The sender is a new interaction package `@deepseek-ai/dsh-member-question-sender` exposing `ctx.memberQuestionSender`. It is both the Service Definition and the codec-backed Provider: `send(payload)` encodes a Companion `member-question` operation through the T4 codec, hands the bytes to an injected `MemberQuestionDeliveryPort`, and waits for an answered or declined settlement. The operation includes the branded cloud-project and originating Session ids plus an absolute expiry epoch, so the receiver can reconstruct the route without treating `toProjectMember` as authority. Peer credentials are retrieved through an injected B-side `lookupGrant` that compositions wire to Remote Access `getProjectPeerGrant`. Because the registry transport does not exist yet, delivery is injectable and tests use `MemoryMemberQuestionDelivery`; the README Known Limitation points at the same Remote Access gap rather than a new protocol.

Lifetime errors are first-class `MemberQuestionSenderError` codes retained as ordinary tool results: `MEMBER_OFFLINE` when presence is offline at send time (nothing queues), `QUESTION_EXPIRED` when the Config `ttlMs` (default 30 minutes) elapses, `QUESTION_WITHDRAWN` when the initiator cancels the turn, `QUESTION_SUPERSEDED` when a newer ask on the same `(originSessionId, toProjectMember)` route key replaces the pending one, and `REVOKED_DURING_FLIGHT` when membership is withdrawn while waiting. The sender indexes in-flight asks by that route key and by question id, and keeps at most one pending ask per key: `registerPending` installs the newer cell first, then settles the previous hanging promise with `QUESTION_SUPERSEDED` and the durable `superseded` outcome. A later answer, decline, expiry, withdrawal, or revocation of the replaced ask is ignored because that cell is already settled.

`MemberQuestionDeliveryPort` owns operation delivery and first-claim terminal retention through `deliver`, `publishTerminal`, and `queryTerminal`. Answered and declined terminals name the branded settling Installation, its user-facing device name, and the absolute settlement epoch; expiry, initiator withdrawal, and supersession carry only the epoch. Every answer, decline, expiry, withdrawal, supersession, or in-flight membership removal publishes before the local promise settles. `publishTerminal` atomically returns `{ claimed, terminal }`; a losing caller consumes the retained terminal, so two Installations cannot commit different outcomes and reconnect can replay the winner. Membership removal publishes receiver-facing `withdrawn` while preserving `REVOKED_DURING_FLIGHT` for the initiating caller when that claim wins.

When `send()` is given the asking session, it appends log-only `member-question/asked` and `member-question/outcome` events. Those records are already model-visible as the tool call and tool result, so they are not surface events and do not re-enter derived history; they remain required-on-read so an older harness refuses a log that contains them.

Origin identity (project name, asker account, role, display name, avatar) is not invented by the tool. A routed ask requires an injected `originResolver`; without the sender or that resolver the tool answers `SENDER_UNAVAILABLE`. Local asks ignore those faces, so existing compositions keep working.

## Supersession check

Neither 2026-08-28 collaboration note is superseded. [The roster-tool note](2026-08-28-project-members-roster-tool.md) still owns model-facing member lookup through `project_members` and its injected account, binding, and presenter faces; this sender consumes an already-known addressee and does not enumerate the roster. [The project-peer-grant note](2026-08-28-project-peer-relay-grants.md) still owns sealed per-peer Relay credentials and the recorded T4 gap that delivery stops at the sealed envelope; this sender looks that grant up on the B side and injects delivery rather than issuing, opening, or transporting the envelope. [The project-membership authority note](2026-08-27-project-membership-core.md) still owns roster authority and the no-queue offline stance; [the presence-heartbeats note](2026-08-28-member-presence-heartbeats.md) still owns how live heartbeats become `online`/`offline`. This note owns only the parameter-extended `ask_user_question` route onto the T4 codec, including runtime schema filtering, single-pending occupancy, lifetime errors, and durable ask records.

## Alternatives considered

**Register a second model-facing tool (`ask_project_member` or similar).** Rejected: the question items, answer JSON, and Native compact-text renderer already belong to `ask_user_question`. A sibling tool would split one vocabulary across two names, force the model to choose, and still share those contracts. Growing the standing schema keeps local asks unchanged and lets runtime assembly hide only the routing parameter.

**Route through `ctx.userQuestions` with a new provider.** Rejected: the local UI provider is one-per-context and would have to become a fan-out router; member questions travel on Companion operations, not the user-questions vocabulary.

**Put the sender in `packages/platform/`.** Rejected: encoding is a Consumer of the protocol, not Platform identity, and the model-facing tool already lives in `packages/interaction/`. Keeping the sender beside `tool-ask-user` avoids dragging Remote Access into every local-ask composition: the tool depends on the sender Service Definition, and a composition without the Provider still serves local asks.

**Call Remote Access Relay from the sender without an injected delivery port.** Rejected: the cross-machine registry transport is the recorded T4 gap; pretending the bytes or terminal have been published would invent a protocol the rest of the stack cannot open or replay.

**Register two `ask_user_question` variants and swap them by eligibility.** Rejected: the existing tool-eligibility mechanism is name-level allow-lists, not per-parameter visibility. Filtering the assembled schema at `system-prompt/assemble` keeps one registered definition and one static catalog while still hiding the parameter from unbound workspaces.

**Mark the ask/outcome events `ignorable`.** Rejected: the ask summary and outcome are already model-visible facts recorded after the tool call. An older harness that skipped them would reconstruct a session whose transcript still contains the routed ask, so required-on-read is the safer default.

## Consequences

Local `ask_user_question` behavior is unchanged except that `references` is accepted and validated. Routed asks require a composed sender, an origin resolver, and a delivery port; until the registry transport lands, real deployments fail closed with `DELIVERY_UNAVAILABLE` or `SENDER_UNAVAILABLE` rather than queuing. The in-memory delivery stub proves codec reuse, first-claim retention, and replay without constituting production delivery evidence. Unbound workspaces never see `to_project_member` in assembled prompts; a later bind is re-checked on the next assembly.

## Testing

`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` pins the schema matrix (`background` missing/over-cap, `references` outside the workspace, routed asks requiring `background`), that local asks still reach the user-questions provider, and that assembled prompts include or omit `to_project_member` according to the bound-project resolver. `packages/interaction/member-question-sender/tests/member-question-sender.spec.ts` pins codec round-trip through the T4 decoder, memory-port delivery, every terminal publication path, replay, a losing local answer consuming an externally retained expiry, each stable lifetime error, and the same-route supersede race.
