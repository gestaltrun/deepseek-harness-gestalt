# Agent Note: Host-owned member-question receiver ledger

Status: implemented

English | [中文](2026-08-31-host-owned-member-question-receiver-ledger.zh.md)

## Problem

The first receiving implementation derived `mq-recv:<originSessionId>::<member>` in the browser and kept pending and terminal state only in `ReceivingQuestionBook`. That let the composite card render, but reconnect, process restart, multiple Installations, and an explicit human turn had no Host authority. A browser countdown could decide expiry, a later frame could revive a locally forgotten pending card, and materializing a real Session required callers to coordinate Session creation and prompt admission as two separately retryable operations.

## Decision

`@deepseek-ai/dsh-member-question-receiver` owns receiver authority on the Host. Its Service Definition exposes four deep operations: authenticated `ingest`, complete `snapshot` plus a change feed, terminal `settle`, and single-call `admitHumanTurn`. The file Provider and authenticated-ingress Consumer adapter remain folded into this package because the current delivery has one storage mechanism and one endpoint callback concern; splitting three packages would add no independently evolving role.

`ingest` accepts receiver Account authority beside the decoded encrypted operation. The authority comes from the authenticated endpoint and is absent from member-question plaintext. One route `(originSessionId, receiving Account)` receives a Host-generated opaque `ReceivingSessionId` persisted on first arrival. Payload content cannot select another account, and no Host identity is assembled from the renderer's `mq-recv` spelling.

The environment ledger is the authority for pending and terminal projections. It stores only the bounded Decision Brief fields admitted by the Companion codec, reference path/reason metadata, routing identities, terminal metadata, and admission request digests; referenced document bodies and human-turn content are absent. Startup validates the complete document through the current Companion codec and fails on a foreign format, malformed record, dangling reference, or inconsistent terminal.

One serialized transaction owner enforces publication order. Idempotent arrival returns the recorded identity. Before a newer same-route question becomes pending, the previous pending question's `expired` or `superseded` candidate passes through the injected global first-claim authority and the canonical retained terminal commits to the ledger. Decline is a human terminal distinct from initiator withdrawal and carries the winning `InstallationId`, device name, and settlement epoch. A losing local claim commits the returned canonical terminal instead of the candidate. Change listeners observe only post-commit complete projections, and callback exceptions are contained.

The Host clock and one earliest-deadline scheduler decide expiry. The scheduler first claims the terminal, then persists it; a publication or file failure leaves the pending row retryable. Startup settles every overdue pending row before reads become available, so reopening cannot revive an expired question. Disposal closes notification and timer admission, then waits for the transaction tail without clearing durable state.

`admitHumanTurn({ receivingSessionId, revision, rpcId, content, mode })` is the only materialization interface. The receiver durably reserves `rpcId` and a content/mode digest before calling an injected high-level adapter that materializes the Host Session if needed and admits the turn. Success commits materialization and admission after the adapter returns. Failure preserves the reservation; retry supplies the same request and `rpcId`. The adapter must be idempotent by `rpcId`, which closes the crash interval between adapter success and ledger commit without exposing `session.create` followed by `prompt` to callers. Arrival never invokes the adapter.

## Supersession check

The [renderer-only receiving-session note](../feature/2026-08-30-receiver-sessions-member-question-wire.md) still owns the current browser projection and composite-card carrier while Host/API Proxy wiring is absent. Its deterministic `mq-recv` identity is no longer receiver authority and must be replaced by the Host projection when that adapter lands. The [member-question sender note](../feature/2026-08-28-member-question-sender.md) continues to own asking-side single-pending promises and first-claim publication; this note owns receiver persistence, recovery, expiry, and human admission. No active note is fully superseded or eligible for archival in this change.

## Alternatives considered

**Keep `ReceivingQuestionBook` authoritative and persist it in browser storage.** Rejected because the browser does not own authenticated Account authority, global first claim, process restart, Host Session materialization, or the clock that can disable every Installation consistently.

**Create a Host Session at question arrival.** Rejected because arrival is a collaboration notification, not human intent to run the local agent. Creating the Session and agent eagerly would weaken the zero-model guarantee and add empty durable conversations for ignored questions.

**Expose `createReceivingSession()` and `prompt()` separately.** Rejected because a crash or retry between the calls can create duplicate Sessions, lose the first human message, or admit it twice. One high-level adapter under a durable `rpcId` reservation owns both actions.

**Store referenced document bodies or human-turn content in the receiver ledger.** Rejected because the Companion document transfer and ordinary Session log own those bytes. The receiver needs bounded display metadata and an admission digest, not a second content store.

**Treat the renderer countdown as expiry authority.** Rejected because suspended or disconnected renderers cannot settle a global state and can disagree across Installations. The Host clock, canonical terminal authority, and durable commit establish one outcome.

## Consequences

Receiver state survives Host restart and exposes one authoritative pending/terminal projection with stable Host identities. Same-route replacement, expiry, decline, and cross-device winners commit in one order. Explicit human admission is retryable without a two-hop client protocol, while arrival stays model-silent.

The package does not yet implement the SessionRuntime/API Proxy adapter or connect the browser's renderer-only projection to this Host feed. Cross-machine first-claim publication remains injected until the project-registry transport exists, so transitions requiring it fail closed. The file format is pre-release version `0` and has no compatibility shim.

## Testing

Focused public-interface tests cover idempotent and conflicting arrival, environment persistence, restart recovery, expired-before-newer ordering, supersede publication failure, decline versus withdrawal, a losing first claim, timer retry and disposal quiescence, reservation retry, post-admission persistence failure, callback containment, invalid durable state, and complete per-file coverage. A real Loader composition mounts the Service Definition, Provider, Consumer adapter, and invariant companion, disposes the provider fiber, then remounts over the same ledger.
