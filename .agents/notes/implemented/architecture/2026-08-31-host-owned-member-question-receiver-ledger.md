# Agent Note: Host-owned member-question receiver ledger

Status: implemented

English | [中文](2026-08-31-host-owned-member-question-receiver-ledger.zh.md)

## Problem

The first receiving implementation derived `mq-recv:<originSessionId>::<member>` in the browser and kept pending and terminal state only in `ReceivingQuestionBook`. That let the composite card render, but reconnect, process restart, multiple Installations, and an explicit human turn had no Host authority. A browser countdown could decide expiry, a later frame could revive a locally forgotten pending card, and materializing a real Session required callers to coordinate Session creation and prompt admission as two separately retryable operations.

## Decision

`@deepseek-ai/dsh-member-question-receiver` owns receiver authority on the Host. Its Service Definition exposes four deep operations: authenticated `ingest`, complete `snapshot` plus a change feed, terminal `settle`, and single-call `admitHumanTurn`. The file Provider and authenticated-ingress Consumer adapter remain folded into this package because the current delivery has one storage mechanism and one endpoint callback concern; splitting three packages would add no independently evolving role.

`ingest` accepts receiver Account authority beside the decoded encrypted operation. The authority comes from the authenticated endpoint and is absent from member-question plaintext. One route `(originSessionId, receiving Account)` receives a Host-generated opaque `ReceivingSessionId` persisted on first arrival. Payload content cannot select another account, and no Host identity is assembled from the renderer's `mq-recv` spelling.

The Decision Brief remains on each question's `member-question` intent rather than on a sibling request frame. A forwarded item is therefore self-contained, while the Host receiver snapshot adds only authority-owned routing, revision, and terminal fields.

The environment ledger is the authority for pending and terminal projections. It stores only the bounded Decision Brief fields admitted by the Companion codec, reference path/reason metadata, routing identities, terminal metadata, and admission request digests; referenced document bodies and human-turn content are absent. Startup validates the complete document through the current Companion codec and fails on a foreign format, malformed record, dangling reference, or inconsistent terminal.

One serialized transaction owner enforces publication order. Idempotent arrival returns the recorded identity. Before a newer same-route question becomes pending, the previous pending question's `expired` or `superseded` candidate passes through the injected global first-claim authority and the canonical retained terminal commits to the ledger. Decline is a human terminal distinct from initiator withdrawal and carries the winning `InstallationId`, device name, and settlement epoch. A losing local claim commits the returned canonical terminal instead of the candidate. Change listeners observe only post-commit complete projections, and callback exceptions are contained.

The Host clock and one earliest-deadline scheduler decide expiry. The scheduler first claims the terminal, then persists it; a publication or file failure leaves the pending row retryable. Startup settles every overdue pending row before reads become available, so reopening cannot revive an expired question. Disposal closes notification and timer admission, then waits for the transaction tail without clearing durable state.

The shipped Web Host mounts the receiver and exposes exact `memberQuestion.snapshot` and `memberQuestion.settle` RPCs plus a complete `host/member-question-snapshot` baseline/change frame. Settlement validates the persisted `ReceivingSessionId`, revision, and question id, and uses the Host Installation identity; a missing receiver, stale tuple, or missing identity fails loud. Development may opt into a keyless local terminal authority, while production remains deferred and fail-closed until authenticated cross-machine publication is composed.

`ReceivingQuestionBook` projects only higher-revision Host frames into renderer-only Session faces under the persisted Host id. Disconnect retains the last projection, and reconnect replaces it from a complete baseline without losing pending or terminal records. The Client sends answers and declines through the Host RPC; expiry, supersession, withdrawal, and canonical terminal winners come only from the Host. Terminal records remain public in the conversation snapshot, and a Client whose Installation differs from the winning answer derives `answered-elsewhere` with the winning device name and settlement time. The ordinary composer is disabled because human-turn materialization is not mounted.

`admitHumanTurn({ receivingSessionId, revision, rpcId, content, mode })` is the only materialization interface. The receiver durably reserves `rpcId` and a content/mode digest before calling an injected high-level adapter that materializes the Host Session if needed and admits the turn. Success commits materialization and admission after the adapter returns. Failure preserves the reservation; retry supplies the same request and `rpcId`. The adapter must be idempotent by `rpcId`, which closes the crash interval between adapter success and ledger commit without exposing `session.create` followed by `prompt` to callers. Arrival never invokes the adapter.

## Supersession check

This note owns receiver persistence, Host API projection, recovery, expiry, settlement, and human admission. The earlier renderer-authority decision is fully consolidated here; the [renderer-only Session-face note](../feature/2026-08-30-web-receiving-experience-assembly-fixes.md) continues to own the outward face and composite-card assembly. The [member-question sender note](../feature/2026-08-28-member-question-sender.md) continues to own asking-side single-pending promises and first-claim publication.

## Alternatives considered

**Keep `ReceivingQuestionBook` authoritative and persist it in browser storage.** Rejected because the browser does not own authenticated Account authority, global first claim, process restart, Host Session materialization, or the clock that can disable every Installation consistently.

**Create a Host Session at question arrival.** Rejected because arrival is a collaboration notification, not human intent to run the local agent. Creating the Session and agent eagerly would weaken the zero-model guarantee and add empty durable conversations for ignored questions.

**Expose `createReceivingSession()` and `prompt()` separately.** Rejected because a crash or retry between the calls can create duplicate Sessions, lose the first human message, or admit it twice. One high-level adapter under a durable `rpcId` reservation owns both actions.

**Store referenced document bodies or human-turn content in the receiver ledger.** Rejected because the Companion document transfer and ordinary Session log own those bytes. The receiver needs bounded display metadata and an admission digest, not a second content store.

**Treat the renderer countdown as expiry authority.** Rejected because suspended or disconnected renderers cannot settle a global state and can disagree across Installations. The Host clock, canonical terminal authority, and durable commit establish one outcome.

**Carry the Decision Brief beside `question/requested`.** Rejected because fields on the item intent keep any forwarded question self-contained and avoid a second encoding of the same sender payload.

## Consequences

Receiver state survives Host restart and exposes one authoritative pending/terminal projection with stable Host identities. Same-route replacement, expiry, answer, decline, and cross-device winners commit in one order. Browser reload and reconnect preserve the same ids and records without creating a Host Session or model path. Generic and plan-review questions retain their existing Host-session flow.

Explicit human admission is retryable without a two-hop client protocol, but the Web composition does not yet mount its materialize-and-admit adapter. Cross-machine first-claim publication remains injected until the project-registry transport exists, so production transitions requiring it fail closed. The file format is pre-release version `0` and has no compatibility shim.

## Testing

Focused public-interface tests cover idempotent and conflicting arrival, environment persistence, restart recovery, expired-before-newer ordering, supersede publication failure, answer and decline versus withdrawal, a losing first claim, timer retry and disposal quiescence, reservation retry, post-admission persistence failure, callback containment, strict wire fields, carried-intent acceptance, invalid durable state, and complete per-file coverage. Client Runtime tests drive two Installation contexts against one canonical answer and pin `answered` versus `answered-elsewhere`. A real Web composition drives authenticated ingress through Host snapshot delivery, answer and decline RPCs, terminal bands, zero Session/model calls, then restarts the receiver and reloads the Client over the same ledger to recover the identical pending and terminal projection.
