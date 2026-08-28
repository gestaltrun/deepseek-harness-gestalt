# Agent Note: member-directed ask_user_question routes through an injectable codec sender

Status: implemented

English | [中文](2026-08-28-member-question-sender.zh.md)

## Problem

Ticket #343 wants `ask_user_question` to address one project member. The T4 Companion codec already owns the `member-question` operation, and Remote Access already owns project-peer grants, but neither package is a model-facing Consumer: the tool must keep talking to `ctx.userQuestions` for local asks, and a new sender must encode and deliver without inventing a second protocol. Cross-machine registry transport is still the recorded T4 gap, so a sender that called Relay directly would either lie about delivery or block the milestone.

## Decision

`ask_user_question` keeps a static schema and adds `to_project_member`, `background`, and `references`. `to_project_member` is mutually exclusive with the local provider: when present, the tool never calls `ctx.userQuestions.ask()` and instead calls `ctx.memberQuestionSender.send()`. Prompt assembly filters that parameter out unless `boundProjectResolver` returns a cloud-project id; `ctx.tools.schemas()` and the generated catalog retain the static schema. `background` is required only in routed mode and is rejected at construction with `BACKGROUND_REQUIRED` or `BACKGROUND_TOO_LONG` against the T4 600 code-point ceiling. `references` is a standing parameter for local and routed asks; each `path` must exist inside the asking session workspace and each `reason` is at most 100 code points, or the tool throws `REFERENCES_INVALID` naming the failing items.

The sender is a new interaction package `@deepseek-ai/dsh-member-question-sender` exposing `ctx.memberQuestionSender`. It is both the Service Definition and the codec-backed Provider: `send(payload)` encodes a Companion `member-question` operation through the T4 codec, hands the bytes to an injected `MemberQuestionDelivery`, and waits for an answered or declined settlement. Peer credentials are retrieved through an injected B-side `lookupGrant` that compositions wire to Remote Access `getProjectPeerGrant`. Because the registry transport does not exist yet, delivery is injectable and tests use `MemoryMemberQuestionDelivery`; the README Known Limitation points at the same Remote Access gap rather than a new protocol.

Lifetime errors are first-class `MemberQuestionSenderError` codes retained as ordinary tool results: `MEMBER_OFFLINE` when presence is offline at send time (nothing queues), `QUESTION_EXPIRED` when the Config `ttlMs` (default 30 minutes) elapses, `QUESTION_WITHDRAWN` when the initiator cancels the turn, `QUESTION_SUPERSEDED` when a newer ask on the same `(originSessionId, member)` route key replaces the pending one, and `REVOKED_DURING_FLIGHT` when membership is withdrawn while waiting. The sender keeps at most one pending ask per that route key.

When `send()` is given the asking session, it appends log-only `member-question/asked` and `member-question/outcome` events. Those records are already model-visible as the tool call and tool result, so they are not surface events and do not re-enter derived history; they remain required-on-read so an older harness refuses a log that contains them.

Origin identity (project name, asker account, role, display name, avatar) is not invented by the tool. A routed ask requires an injected `originResolver`; without the sender or that resolver the tool answers `SENDER_UNAVAILABLE`. Local asks ignore those faces, so existing compositions keep working.

## Supersession check

Neither the [project-membership authority note](2026-08-27-project-membership-core.md) nor the [roster-tool note](2026-08-28-project-members-roster-tool.md) is superseded. Membership still owns roster authority; the roster tool still owns model-facing member lookup. This note owns only the sender-side routing of `ask_user_question` onto the T4 codec, including eligibility filtering, lifetime errors, and durable ask records.

## Alternatives considered

**Route through `ctx.userQuestions` with a new provider.** Rejected: the local UI provider is one-per-context and would have to become a fan-out router; member questions travel on Companion operations, not the user-questions vocabulary.

**Put the sender in `packages/platform/`.** Rejected: encoding is a Consumer of the protocol, not Platform identity, and the model-facing tool already lives in `packages/interaction/`. Keeping the sender beside `tool-ask-user` avoids dragging Remote Access into every local-ask composition: the tool depends on the sender Service Definition, and a composition without the Provider still serves local asks.

**Call Remote Access Relay from the sender without an injected delivery.** Rejected: the cross-machine registry transport is the recorded T4 gap; pretending the bytes have been delivered would invent a protocol the rest of the stack cannot open.

**Register two `ask_user_question` variants and swap them by eligibility.** Rejected: the existing tool-eligibility mechanism is name-level allow-lists, not per-parameter visibility. Filtering the assembled schema at `system-prompt/assemble` keeps one registered definition and one static catalog while still hiding the parameter from unbound workspaces.

**Mark the ask/outcome events `ignorable`.** Rejected: the ask summary and outcome are already model-visible facts recorded after the tool call. An older harness that skipped them would reconstruct a session whose transcript still contains the routed ask, so required-on-read is the safer default.

## Consequences

Local `ask_user_question` behavior is unchanged except that `references` is now accepted and validated. Routed asks require a composed sender, an origin resolver, and a delivery adapter; until the registry transport lands, real deployments fail closed with `DELIVERY_UNAVAILABLE` or `SENDER_UNAVAILABLE` rather than queuing. The in-memory delivery stub is the round-trip test of codec reuse, not evidence of production delivery. Unbound workspaces never see `to_project_member` in assembled prompts; a later bind is re-checked on the next assembly.

## Testing

`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` pins the schema matrix (`background` missing/over-cap, `references` outside the workspace, routed asks requiring `background`), that local asks still reach the user-questions provider, and that assembled prompts include or omit `to_project_member` according to the bound-project resolver. `packages/interaction/member-question-sender/tests/member-question-sender.spec.ts` pins codec round-trip through the T4 decoder, memory-stub delivery, each stable lifetime error, and the same-route supersede race.
