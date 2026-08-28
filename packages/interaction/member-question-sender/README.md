# @deepseek-ai/dsh-member-question-sender

English | [中文](README.zh.md)

Service Definition and codec-backed Provider for member-directed questions. `ctx.memberQuestionSender.send(payload)` encodes one Companion `member-question` operation through the T4 remote-protocol codec and delivers the bytes through an injected adapter. Peer credentials are retrieved through an injected B-side lookup over Remote Access `getProjectPeerGrant`.

## Service: `MemberQuestionSenderService` (ctx key: `memberQuestionSender`)

### Public API

- `ctx.memberQuestionSender.send(payload): Promise<{ questionId, encoded }>` Encode one Decision Brief (origin, background, question batch, references) as a Companion `member-question` operation and deliver the encoded bytes.

### Key Types

- `MemberQuestionSendPayload` — `{ toProjectMember, projectId, background, questions, references, origin }`. Origin, questions, and references reuse the T4 Companion vocabulary; this package does not invent a second protocol.
- `MemberQuestionDelivery` — injected adapter with `deliver(encoded)`. Cross-machine registry transport is deferred, so compositions inject the adapter; tests use `MemoryMemberQuestionDelivery`.
- `ProjectPeerGrantLookup` — injected B-side retrieval of the sealed project-peer grant addressed to the member.
- `MemberQuestionSenderError` — `HarnessError` subclass with codes `DELIVERY_UNAVAILABLE`, `GRANT_UNAVAILABLE`, and `ENCODE_FAILED`.

### Injected faces

- `delivery` — required for a successful send. Absent, `send()` answers `DELIVERY_UNAVAILABLE`.
- `lookupGrant` — optional. Present, a rejection answers `GRANT_UNAVAILABLE` before encoding. Absent, encoding proceeds so a keyless assembly can round-trip the codec without a Platform Instance.

## Role

This package is the Service Definition and the codec-backed Provider for the member-question sender seam. Encoding is owned by [`dsh-remote-protocol`](../../platform/remote-protocol/README.md); grant records are owned by [`dsh-remote-access`](../../platform/remote-access/README.md). The model-facing Consumer is [`dsh-tool-ask-user`](../tool-ask-user/README.md).

## Model Experience

Indirectly, through `dsh-tool-ask-user`, which routes `to_project_member` onto `send()` and retains the sender's stable errors as ordinary tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Cross-machine delivery rides the deferred project-registry transport** — encoding and the delivery interface are defined; the default composition injects an in-memory stub. Opening a sealed peer grant on the addressee's installation and carrying it across machines remain the [Remote Access Known Limitation](../../platform/remote-access/README.md#known-limitations-and-deferred-work). This package does not invent a new protocol.
- **Runtime eligibility, offline fail-fast, and durable ask/outcome events are later milestones** — this Provider encodes and delivers one payload; membership filtering, presence, and session-log settlement stay with later tickets.
