# `@deepseek-ai/dsh-remote-protocol`

English | [中文](README.zh.md)

Pure codecs and negotiators for Remote Access. This package owns two independently versioned protocols and imports no Harness Workspace, Session, prompt, tool, model, approval, Host API, or WebSocket type.

## Relay Transport Protocol

Version 1 exposes only route attachment, opaque ciphertext forwarding, heartbeat, revocation, stable transport errors, and transport-version negotiation. Attachment authorization uses an endpoint-owned P-256 signing key: Relay issues a fresh expiring challenge bound to the route, attachment id, endpoint kind, public key, challenge id, and nonce, then accepts one signature over that complete tuple. The Platform persists only the public-key digest; neither attach frame contains replayable bearer authority. After authentication, `ready` binds the local route and attachment and projects current opposite-endpoint attachment ids with a credential-bound, non-secret pairing selector and connection generation. The selector chooses endpoint-local Snow static state but grants no Relay or application authority. Relay identifiers are protocol-native branded values. `REMOTE_OFFLINE` reports a missing live target without implying queued delivery. Decoding rejects unknown message types, duplicate ready peers, and extra fields, so a complete Host request cannot be smuggled beside transport metadata.

## Encrypted Companion Protocol

Companion majors 2 and 1 are the current and immediately preceding application versions. Both endpoints must advertise authenticated encryption, pairing-key separation, and replay protection at the selected major. Negotiation selects the highest safe shared major regardless of offer-array order, so an unsafe shared major can fall back only to a safe immediately preceding major. Each logical endpoint connection owns a negotiation channel. Starting a negotiation on that channel invalidates its prior application-codec token before the offers are evaluated; a failed attempt leaves the channel inactive, while other channels remain valid. No safe version overlap fails with an endpoint-specific update requirement before application plaintext can be encoded.

The implemented catalog contains bounded transcript-page (optional `streaming`, plus `text`, `image`, `approval`, and `ask-user` entries) and versioned `foreground-sync` projections; Session-creation, prompt-submission, prompt-cancellation, attachment-offer, `settle-approval`, `answer-ask-user`, authoritative `search-sessions`, and reconnect `query-operation-status` operations; Desktop-confirmed, attachment-rejection, correlated `session-search`, `operation-failed`, and `status` results. `foreground-sync` carries the positive physical-connection generation and Desktop revision after authenticated decryption; a raw byte cannot decode as synchronization authority. The attachment offer carries only a one-time blob capability, ciphertext SHA-256, exact ciphertext byte count, capability expiry, and bounded file name. Image entries carry only `fileName` and `alt`; plaintext attachment bytes stay off the Relay frame. An `approval` or `ask-user` entry names one branded `interactionId` and the Desktop-authorized decisions; a present `settled` decision must be one of those decisions. Session search carries at most 20 unique Session/snippet pairs with 240 Unicode code points per snippet. Host failures preserve one of four closed categories: HTTP status, invalid wire response, typed business error, or timeout. Every identifier is branded by this protocol rather than imported from a Harness domain package. Unsupported operations and projection fields fail during decoding. A committed `status` answer embeds the confirmed result of the same operation id; an absent answer is only `{ absent: true }`.

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

- Pairing handshakes, credential persistence, challenge lifecycle, and production Companion message encryption belong to service or reviewed endpoint integrations, not these codecs.
- The current Companion catalog proves Session creation, prompt submission and cancellation, attachment offers, approval and Ask User settlement, authoritative Session search, operation-status query, transcript and foreground synchronization projections, and the confirmed, attachment-rejected, session-search, operation-failed, and status result kinds. Discovery of remote Workspaces still belongs to a later catalog slice.
