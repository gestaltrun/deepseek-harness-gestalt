# `@deepseek-ai/dsh-remote-protocol`

English | [中文](README.zh.md)

Pure codecs and negotiators for Remote Access. This package owns two independently versioned protocols and imports no Harness Workspace, Session, prompt, tool, model, approval, Host API, or WebSocket type.

## Relay Transport Protocol

Version 1 exposes only route attachment, opaque ciphertext forwarding, heartbeat, revocation, stable transport errors, and transport-version negotiation. Attachment authorization uses an endpoint-owned P-256 signing key: Relay issues a fresh expiring challenge bound to the route, attachment id, endpoint kind, public key, challenge id, and nonce, then accepts one signature over that complete tuple. The Platform persists only the public-key digest; neither attach frame contains replayable bearer authority. After authentication, `ready` binds the local route and attachment and projects current opposite-endpoint attachment ids with a credential-bound, non-secret pairing selector and connection generation. The selector chooses endpoint-local Snow static state but grants no Relay or application authority. Relay identifiers are protocol-native branded values. `REMOTE_OFFLINE` reports a missing live target without implying queued delivery. Decoding rejects unknown message types, duplicate ready peers, and extra fields, so a complete Host request cannot be smuggled beside transport metadata.

## Encrypted Companion Protocol

Companion majors 4 and 3 are the current and immediately preceding application versions. Both endpoints must advertise authenticated encryption, pairing-key separation, and replay protection at the selected major. Negotiation selects the highest safe shared major regardless of offer-array order, so an unsafe shared major can fall back only to a safe immediately preceding major. Each logical endpoint connection owns a negotiation channel. Starting a negotiation on that channel invalidates its prior application-codec token before the offers are evaluated; a failed attempt leaves the channel inactive, while other channels remain valid. No safe version overlap fails with an endpoint-specific update requirement before application plaintext can be encoded.

Major 3 adds bounded Session and Workspace discovery, complete conversation-page projections, Session history, Workspace-owned or Ungrouped Session creation, prompt submission, cancellation, Approval and Ask User settlement, and content-addressed historical-image reads. Image bytes travel as ordered 32 KiB chunks with one shared digest and at most 512 chunks; a Mobile endpoint accepts them only for the originating operation, Session, attachment, media type, generation, index, count, and digest. The catalog retains attachment offers, authoritative `search-sessions`, reconnect `query-operation-status`, Desktop confirmations, attachment rejections, correlated `session-search`, typed `operation-failed`, and `status` answers carrying the original terminal mutation result or explicit absence. Host failures preserve one of four closed categories: HTTP status, invalid wire response, typed business error, or timeout. `foreground-sync` carries the positive physical-connection generation and Desktop revision after authenticated decryption; a raw byte cannot decode as synchronization authority. Unsupported operations, extra fields, malformed content-addressed attachment ids, and limit overflow fail during decoding.

Major 4 adds `observe-session` and unsolicited `session-live` replacements. One pairing observes at most one open Session. Its replacement may include a bounded conversation, while every hidden changed Session carries only its authoritative summary, position, and Workspace memberships. A removal carries only the Session id. Each replacement names the physical generation and a monotonically increasing Desktop revision; Mobile applies a revision at most once, ignores older duplicates, and queues at most 32 distinct Session replacements until the paged baseline completes. Same-Session changes coalesce behind one ordered Snow sender. Queue overflow, Host stream failure, and projection failure retire the channel so reconnect establishes a new generation and full baseline.

A conversation projection echoes the optional exclusive `beforeSeq` from its history request. An absent cursor replaces the tail; a present cursor identifies an older page that Mobile continuity-checks and prepends.

## Endpoint attachment cipher

`deriveCompanionAttachmentKey`, `sealCompanionAttachment`, `openCompanionAttachment`, and `hashCompanionCiphertext` implement the endpoint side of encrypted attachment transfer with HKDF-SHA-256 key derivation and AES-256-GCM. The sealed payload is `iv(12) ‖ ciphertext ‖ tag(16)` (`COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES` = 28). Both endpoints link these functions; the Platform blob store receives only `sealCompanionAttachment` output and its SHA-256 and never derives the key. Key material is supplied by the Personal Pairing layer. The 100 MiB blob ceiling is a ciphertext limit; Mobile rejects plaintext that cannot fit after this overhead.

## Wire limits and errors

| Limit | Value |
|---|---:|
| Parser depth | 16 levels |
| Values in one object or array | 256 |
| Total encoded values | 4,096 |
| UTF-8 bytes in one string | 90,000 |
| Complete Relay message | 98,304 bytes |
| Opaque Noise message | 65,535 bytes |
| Companion application before encryption | 61,440 bytes (60 KiB) |
| Complete encoded transcript-page message | 49,152 bytes (48 KiB) |
| Transcript page | 50 entries |
| Session history request | 20 messages |
| Session or Workspace discovery page | 20 rows |
| Pending live Session replacements | 32 distinct Sessions |
| Historical image chunk | 32,768 decoded bytes |
| Historical image result | 512 chunks |
| Session search query | 500 UTF-16 code units |
| Session search result | 20 unique Sessions |
| Session search snippet | 240 Unicode code points |
| Host failure message | 4,096 UTF-8 bytes |
| Retained attachment blob | 104,857,600 ciphertext bytes (100 MiB) |
| Attachment capability lifetime | 900,000 ms (15 minutes) |
| Attachment file name | 255 UTF-8 bytes |

`RemoteProtocolError` exposes stable codes for invalid input, exceeded limits, incompatible Relay versions, missing Companion security capabilities, required endpoint updates, and missing negotiation. Diagnostics never contain application plaintext. Binary wire values use one canonical unpadded base64url spelling; aliases that decode to the same bytes are rejected. The 60 KiB application ceiling leaves 4,095 bytes inside the fixed 65,535-byte Noise message ceiling for encryption overhead; the Relay frame ceiling also covers base64url and transport metadata at that maximum.

The package does not encrypt Companion message traffic. Mobile and Desktop supply the [`dsh-noise-channel`](../noise-channel/README.md) endpoint channel, then encrypt version offers and encoded Companion messages before Relay forwarding. The [keyless assembled example](../../../examples/remote-protocol/start.ts) retains an example-only AES-GCM adapter for codec isolation; it is not product cryptography or security-review evidence. Product Mobile and Desktop assemble endpoint-owned first pairing, credential-bound peer discovery, fresh-ephemeral IK, and encrypted Companion messages. The [two-instance product snapshot](../../../examples/two-instance-relay/start.ts) crosses real WSS Relay instances with the opaque endpoint mailbox, sealed Mobile authority, and Snow IK rather than the example adapter.

## Model Experience

None, as Remote Protocol metadata and device origin never enter a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Session rename, archive, deletion, and fork; Workspace administration; terminal input; and settings, credential, plugin, model, and preset mutations are not part of Companion major 4.
- Pairing handshakes, credential persistence, challenge lifecycle, and production Companion message encryption belong to service or reviewed endpoint integrations, not these codecs.
