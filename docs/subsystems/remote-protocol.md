# Remote Protocol

English | [中文](remote-protocol.zh.md)

[`@deepseek-ai/dsh-remote-protocol`](../../packages/platform/remote-protocol/README.md) defines the only wire vocabulary shared by Mobile, Desktop, and the opaque Relay. It is a pure protocol module rather than a Cordis service.

## Independent protocols

Relay Transport version negotiation is independent from Encrypted Companion application negotiation. Relay can parse only attachment, forwarding, heartbeat, revocation, and transport-error metadata; its forwarding payload remains bytes. Companion messages become available only after both endpoints select the highest safe shared major among major 2 and 1 with authenticated encryption, pairing-key separation, and replay protection. Offer-array order does not express preference or affect selection.

The negotiation result is an unforgeable process-local capability required by `encodeCompanionMessage` and `decodeCompanionMessage`. Each logical endpoint connection owns a negotiation channel. A new attempt invalidates that channel's previous capability before validating its offers, so a failed renegotiation cannot reuse an older capability and does not revoke unrelated channels. `COMPANION_UPDATE_REQUIRED` and `COMPANION_SECURITY_CAPABILITY_MISSING` identify the endpoint that must update. Callers cannot produce an application message before successful negotiation, so the failure path carries only version and capability metadata.

## Wire values

Relay route and attachment ids and Companion operation, Session-projection, and transcript-entry ids are distinct branded strings parsed from `unknown`. Companion uses protocol-native identifiers and does not import Harness domain types. Both codecs reject unknown discriminants, extra fields, unsafe numbers, malformed UTF-8/JSON, excessive parser depth, large containers, excessive encoded values, oversized messages, and oversized ciphertext. Base64url fields accept only their canonical unpadded spelling. Companion application data is at most 60 KiB before encryption. A complete encoded transcript-page message has the tighter ceiling of 50 entries or 48 KiB, measured in UTF-8 wire bytes.

The package owns no encryption implementation. Endpoint adapters encrypt offers and application messages with the reviewed paired channel. The keyless Loader example uses a harness-local cipher only to prove that Relay decoding and forwarding never require application plaintext.

## Companion operations and results

`CompanionOperation` is a closed union of prompt submission, attachment offer, authoritative `search-sessions`, and reconnect-time `query-operation-status`. A search request carries one non-blank query of at most 500 UTF-16 code units. Its correlated `session-search` result carries at most 20 unique Session id/snippet pairs, each snippet limited to 240 Unicode code points; the protocol supplies no cached title, Workspace, or transcript fields.

`CompanionResult` is a closed union of confirmed mutation, attachment rejection, `session-search`, `operation-failed`, and `status`. Every result carries the originating operation id. `operation-failed` preserves exactly one Host failure category: an HTTP status including its numeric code, invalid wire response, typed business code/message, or timeout. Failure messages are limited to 4 KiB of UTF-8. A `status` result either embeds the original confirmed result for the same operation id or states `{ absent: true }`.

When Mobile loses its physical connection generation after transmitting an operation, transmission is uncertain: it retains the operation id and later sends `query-operation-status`. It never resends the operation while the outcome is unknown because Desktop may already have committed it.
