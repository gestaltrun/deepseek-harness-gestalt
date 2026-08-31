# @deepseek-ai/dsh-member-question-sender

English | [中文](README.zh.md)

Service Definition and codec-backed Provider for member-directed questions. `ctx.memberQuestionSender.send(payload)` encodes one Companion `member-question` operation through the T4 remote-protocol codec, delivers the bytes through an injected port, and waits for the authoritative first terminal. Peer credentials are retrieved through an injected B-side lookup over Remote Access `getProjectPeerGrant`.

## Service: `MemberQuestionSenderService` (ctx key: `memberQuestionSender`)

### Public API

- `ctx.memberQuestionSender.send(payload, options?): Promise<MemberQuestionSendResult>` Encode one Decision Brief (origin, background, question batch, references) as a Companion `member-question` operation, deliver the encoded bytes, and wait for an answered or declined settlement. Lifetime failures reject as `MemberQuestionSenderError`.
- `ctx.memberQuestionSender.settle(questionId, settlement): Promise<void>` Publish an answered or declined settlement with the claimant `InstallationId`, user-facing device name, and absolute settlement epoch. The delivery port retains the first claim; a losing local settlement applies the retained terminal instead.
- `ctx.memberQuestionSender.withdraw(questionId): Promise<void>` Cancel one pending question as initiator withdrawal.
- `ctx.memberQuestionSender.queryTerminal(questionId): Promise<CompanionMemberQuestionSettledResult | undefined>` Query the delivery port's retained first terminal for reconnect replay.

### Key Types

- `MemberQuestionSendPayload` — `{ toProjectMember, projectId, background, questions, references, documents?, origin, originSessionId }`. `documents` contains arbitrary bytes aligned 1:1 with `references` and may be omitted only when `references` is empty; the sender derives bounded `document-chunk` frames and rejects count or path misalignment. `projectId` and `originSessionId` use the existing branded Platform and Companion ids. The sender derives the absolute operation `expiresAt` from `ttlMs`. Origin, questions, references, and document chunks reuse the T4 Companion fields; this package does not invent a second protocol.
- `MemberQuestionSendResult` — `{ questionId, encoded, outcome: 'answered', answers }` or `{ questionId, encoded, outcome: 'declined' }`.
- `MemberQuestionDeliveryPort` — injected port with `deliver(encoded)`, atomic `publishTerminal(terminal)`, and `queryTerminal(questionId)`. `publishTerminal` returns `{ claimed, terminal }`; `terminal` is always the retained first claim. Cross-machine registry transport is deferred, so compositions inject the port; tests use `MemoryMemberQuestionDelivery`.
- `ProjectPeerGrantLookup` — injected B-side retrieval of the sealed project-peer grant addressed to the member.
- `MemberPresenceLookup` — injected live-presence verdict. An `offline` result answers `MEMBER_OFFLINE` before encoding; nothing is queued.
- `MemberMembershipWatch` — injected in-flight membership watch. Resolving it answers `REVOKED_DURING_FLIGHT`.
- `MemberQuestionSenderError` — `HarnessError` subclass with codes `DELIVERY_UNAVAILABLE`, `GRANT_UNAVAILABLE`, `ENCODE_FAILED`, `MEMBER_OFFLINE`, `QUESTION_EXPIRED`, `QUESTION_WITHDRAWN`, `QUESTION_SUPERSEDED`, and `REVOKED_DURING_FLIGHT`.

### Injected faces

- `delivery` — required for a successful send and terminal publication. Absent, `send()` answers `DELIVERY_UNAVAILABLE`; rejected terminal publication also fails closed with that code.
- `lookupGrant` — optional. Present, a rejection answers `GRANT_UNAVAILABLE` before encoding. Absent, encoding proceeds so a keyless assembly can round-trip the codec without a Platform Instance.
- `presenceLookup` — optional. Present, an `offline` verdict answers `MEMBER_OFFLINE` before encoding. Absent, send skips the offline fail-fast so a keyless assembly can round-trip without a presence registry.
- `watchMembership` — optional. Present, a resolution while an ask is pending answers `REVOKED_DURING_FLIGHT`.
- `ttlMs` — routed-question lifetime in milliseconds, default `1_800_000` (30 minutes). Expiry answers `QUESTION_EXPIRED`.

### Session events

When `send()` is given an asking session, it appends a log-only `member-question/asked` summary and a matching `member-question/outcome`. The pair records already model-visible facts (the tool-call arguments and the tool result); it is not a surface event and does not re-enter derived history.

The sender keeps at most one pending ask per `(originSessionId, toProjectMember)` route key. Answer, decline, expiry, initiator withdrawal, same-route supersession, and membership removal all publish a terminal candidate before the local promise settles. A newer same-key send claims `superseded` for the previous ask; membership removal claims the receiver-facing `withdrawn` terminal while the initiating caller retains `REVOKED_DURING_FLIGHT` when that local claim wins.

## Role

This package is the Service Definition and the codec-backed Provider for the member-question sender seam. Encoding is owned by [`dsh-remote-protocol`](../../platform/remote-protocol/README.md); grant records are owned by [`dsh-remote-access`](../../platform/remote-access/README.md). The model-facing Consumer is [`dsh-tool-ask-user`](../tool-ask-user/README.md).

## Model Experience

Indirectly, through `dsh-tool-ask-user`, which routes `to_project_member` onto `send()` and retains the sender's stable errors as ordinary tool results.

#### KV Cache effect

No direct token cost or invalidation. `dsh-tool-ask-user` owns schema growth for `to_project_member`, `background`, and `references`, plus retained tool-result tokens for answered batches and sender lifetime errors.

## Known Limitations and Deferred Work

- **Cross-machine delivery rides the deferred project-registry transport** — encoding and the delivery interface are defined; keyless tests inject the in-memory implementation, while compositions without a production port fail closed. Opening a sealed peer grant on the addressee's installation and carrying it across machines remain the [Remote Access Known Limitation](../../platform/remote-access/README.md#known-limitations-and-deferred-work). Production sealing stays behind the independent encryption review recorded there. This package does not invent a new protocol.
