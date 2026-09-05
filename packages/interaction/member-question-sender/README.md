# @deepseek-ai/dsh-member-question-sender

English | [中文](README.zh.md)

Service Definition and codec-backed Provider for member-directed questions. The Provider prepends a Host-root unscoped `user-questions/request` answerer: ordinary requests call `next()`, while requests carrying `memberRoute` are claimed before previously registered Remote or UI answerers, encoded as one Companion `member-question` operation through the T4 remote-protocol codec, delivered through an injected port, and settled from the authoritative first terminal. Peer credentials are retrieved through an injected B-side lookup over Remote Access `getProjectPeerGrant`.

## Service: `MemberQuestionSenderService` (ctx key: `memberQuestionSender`)

### Public API

- `ctx.memberQuestionSender.send(payload, options?): Promise<MemberQuestionSendResult>` Encode one Decision Brief (origin, background, question batch, references, optional aligned document bytes) as a Companion `member-question` operation plus `document-chunk` frames, deliver the encoded bytes, and wait for an answered or declined settlement. Lifetime failures reject as `MemberQuestionSenderError`.
- `ctx.memberQuestionSender.settle(questionId, settlement): Promise<void>` Publish an answered or declined settlement with the claimant `InstallationId`, user-facing device name, and absolute settlement epoch. The delivery port retains the first claim; a losing local settlement applies the retained terminal instead.
- `ctx.memberQuestionSender.applyTerminal(terminal): Promise<void>` Apply one authoritative first-claim terminal published by transport.
- `ctx.memberQuestionSender.withdraw(questionId): Promise<void>` Cancel one pending question as initiator withdrawal.
- `ctx.memberQuestionSender.queryTerminal(questionId): Promise<CompanionMemberQuestionSettledResult | undefined>` Query the delivery port's retained first terminal for reconnect replay.

### Key Types

- `MemberQuestionSendPayload` — `{ toProjectMember, projectId, background, questions, references, documents?, origin, originSessionId }`. `projectId` and `originSessionId` use the existing branded Platform and Companion ids. The sender derives the absolute operation `expiresAt` from `ttlMs`. Origin, questions, and references reuse the T4 Companion fields; `documents` are the aligned file bytes encoded as Companion `document-chunk` frames. This package does not invent a second protocol.
- `MemberQuestionSendResult` — `{ questionId, encoded, outcome: 'answered', answers }` or `{ questionId, encoded, outcome: 'declined' }`.
- `MemberQuestionDeliveryPort` — injected port with `deliver(encoded)`, atomic `publishTerminal(terminal)`, and `queryTerminal(questionId)`. `deliver` carries the encoded `member-question` operation plus the ordered `document-chunk` frame groups. `publishTerminal` returns `{ claimed, terminal }`; `terminal` is always the retained first claim. Cross-machine registry transport is deferred, so compositions inject the port; tests use `MemoryMemberQuestionDelivery`.
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

When `send()` is given an asking session, it appends an ignorable log-only `member-question/asked` summary and a matching ignorable `member-question/outcome`. The pair records already model-visible facts (the tool-call arguments and the tool result); it is not a surface event and does not re-enter derived history. Readers that do not know these audit records may skip them without changing reconstructed model history.

The sender keeps at most one pending ask per `(originSessionId, toProjectMember)` route key. Answer, decline, expiry, initiator withdrawal, same-route supersession, and membership removal all publish a terminal candidate before the local promise settles. A newer same-key send claims `superseded` for the previous ask; membership removal claims the receiver-facing `withdrawn` terminal while the initiating caller retains `REVOKED_DURING_FLIGHT` when that local claim wins.

## Role

This package is the Service Definition and the codec-backed Provider for the member-question sender seam. Encoding is owned by [`dsh-remote-protocol`](../../platform/remote-protocol/README.md); grant records are owned by [`dsh-remote-access`](../../platform/remote-access/README.md). The model-facing Consumer is [`dsh-tool-ask-user`](../tool-ask-user/README.md).

## Model Experience

Indirectly, through `dsh-tool-ask-user`, which routes `to_project_member` onto `ctx.userQuestions.ask()` with `memberRoute`; this sender's Host-root answerer claims that request and retains its stable errors as ordinary tool results.

#### KV Cache effect

No direct token cost or invalidation. `dsh-tool-ask-user` owns schema growth for `to_project_member`, `background`, and `references`, plus retained tool-result tokens for answered batches and sender lifetime errors.

## Known Limitations and Deferred Work

- **Cross-machine delivery rides the deferred project-registry transport** — encoding, chunk frames, and the delivery interface are defined; keyless tests inject the in-memory implementation, while compositions without a production port fail closed. Opening a sealed peer grant on the addressee's installation and carrying it across machines remain the [Remote Access Known Limitation](../../platform/remote-access/README.md#known-limitations-and-deferred-work). Production sealing stays behind the independent encryption review recorded there. This package does not invent a new protocol.
