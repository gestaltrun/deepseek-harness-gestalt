# Agent Note: receiving sessions and wire acceptance for routed member questions

Status: implemented

English | [中文](2026-08-30-receiver-sessions-member-question-wire.zh.md)

## Problem

Ticket #344 M2 is the receiving half of the member-question route. The T5 sender encodes a `member-question` ask whose Decision Brief (origin identity, background, references, expiry) is bounded by the T4 codec, but the receiver-side wire still admitted only the bare `member-question` tag, so a routed ask arrived as an anonymous generic question: no brief, no receiving session, no expiry, and no supersede.

## Decision

The carried fields ride the intent, not a sibling frame. `AskUserQuestionIntent`'s `member-question` variant grows `questionId`, `originSessionId`, `toProjectMember`, `origin` (the T4-bounded public identity), `background`, `references`, and `expiresAt`; `askUserQuestionItemSchema` mirrors every field as required, so an incomplete brief or an unknown tag fails loud at the frame instead of degrading to a generic render. The sender's `MemberQuestionSendPayload` vocabulary is unchanged — the intent is the same brief, one encoding, no second protocol.

Receiving sessions are renderer-only. `ReceivingQuestionBook` in dsh-client-runtime routes a claimed batch (every question carries the same brief) to a local session whose id is derived deterministically from the route key `<originSessionId>::<toProjectMember>`, titled with the brief's first source line (`project — origin session`). No host session is created and no Session instance is built, so a receiving session can never carry local model output by construction. The SessionManager merges book rows into the list snapshot and tracks the pending dot against the synthetic id; a claimed frame is not buffered against the origin session id, which never instantiates locally.

One card per route key. A newer ask supersedes a still-pending predecessor (`superseded` with its terminal instant); a predecessor already terminal is never relabelled. `question/resolved` maps `answered` → answered and `cancelled` → withdrawn; `decline()` and `markAnsweredElsewhere()` cover the receiver's decline and a cross-device settlement. The carried `expiresAt` remains the shared expiry instant, while the [renderer-only receiving Session face](2026-08-30-web-receiving-experience-assembly-fixes.md) owns the current single earliest-deadline timer and settled wait publication. Expiry wins over supersede when the predecessor's countdown has already passed.

## Alternatives considered

**Carry the brief beside the batch on the `question/requested` frame.** Rejected: the M1b slots already narrow per-request faces off the batch, and fields on the item intent keep the ask self-contained — a frame that forwards one question carries its whole brief.

**Create a real host session on the receiver.** Rejected: a host session owns an agent and a model loop; a receiving session is a decision surface, and "zero local model output" must be structural, not a discipline.

**One timer per receiving card.** Rejected: the book needs only the earliest active deadline and recalculates it whenever a record changes.

## Consequences

Generic and plan-review asks keep the host-session flow unchanged. Receiving rows do not ride `session.list` and remain client-local by design. Their renderer-only Session faces expose the real pending response carrier without creating a Host Session; boot wiring of the receiving member identity (currently the `'self'` default) and cross-install delivery remain separate composition work.

## Testing

`packages/host/apiproxy/tests/rpc-schemas.spec.ts` pins carried-brief acceptance on the item and the frame, and rejects an unknown tag plus every required field missing or out of bound. `packages/client/runtime/tests/receiving.client.spec.ts` pins intent narrowing, route keys and deterministic ids, single-active-card supersede, expiry with an injected timer, withdrawal propagation, and the outward `SessionFace` through a real `SessionRuntime`. `packages/interaction/user-questions/tests/user-questions.spec.ts` pins the carried intent through `ask()`.
