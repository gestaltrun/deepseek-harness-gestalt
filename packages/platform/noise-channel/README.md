# `@deepseek-ai/dsh-noise-channel`

English | [中文](README.zh.md)

Snow 0.10.0 WebAssembly adapter for Personal Pairing and encrypted Companion messages. The same committed module runs in Node and browser WebViews; it selects only `Noise_XKpsk3_25519_ChaChaPoly_SHA256` for first pairing and `Noise_IK_25519_ChaChaPoly_SHA256` for reconnect.

## Pairing

`SnowDesktopEndpointPairingOwner` and `SnowMobileHandshakeClient` complete all three XKpsk3 messages while the Platform forwards only opaque mailbox messages and routing metadata. Desktop constructs the QR payload locally, so the invitation PSK never enters Platform HTTP requests or persistence. The finished handshake hash supplies only authentication words and is never used as application key material. Desktop generates an independent 32-byte attachment key in its durable confirmation transaction and seals it with the Mobile Relay authority as the first responder transport payload. Platform and Relay observe only the ciphertext. Endpoint-protected recovery records retain an unfinished transcript across process restart. Sealing erases Desktop invitation state after its confirmation transaction is durable; Mobile erases its invitation state only after the opened grant, attachment key, and reconnect record commit together.

`SnowPairingHandshakeProvider` retains the older Platform-mediated proof surface and rebuilds short-lived state with Snow's `fixed_ephemeral_key_for_testing_only` API. Product Desktop does not select that provider; it retains the endpoint owner locally through the opaque mailbox transaction.

## Reconnect and messages

`beginSnowMobileReconnect` and `acceptSnowDesktopReconnect` create one IK channel per physical Relay attachment. Snow generates a fresh ephemeral for every attempt. The IK prologue binds the Relay route, credential-bound pairing selector, independent Desktop and Mobile attachment ids, and a positive connection generation, so another route, pairing, attachment tuple, or generation cannot reuse the transcript. `SnowMobileAttachmentOwner` and `SnowDesktopAttachmentOwner` carry those IK messages as opaque Relay ciphertext payloads; the Desktop selects only local static state named by the non-secret selector, and Snow authenticates that static identity.

After IK, `SnowDesktopAttachmentOwner` places Desktop's encrypted Companion version offer in message 2 and retains a pending negotiation instead of creating an application codec. Mobile decrypts that offer, sends its own encrypted offer as the next Relay ciphertext, and creates its codec only after that send succeeds. Desktop creates its codec only after opening the Mobile offer, then sends the first versioned `foreground-sync`. Unsupported crossings fail with `COMPANION_UPDATE_REQUIRED` and the endpoint that must update before either endpoint can send application data. Abandoning either half releases the raw Snow transport.

`SnowCompanionProtocolChannel` is constructible only through that completed peer-offer exchange and encrypts only values admitted by `@deepseek-ai/dsh-remote-protocol`. Its ordered Snow transport rejects replay and out-of-order ciphertext. Foreground synchronization carries the attachment generation and Desktop revision; a raw one-byte frame cannot decode as synchronization authority. Wire-size probes use the protocol negotiated from the received peer offer rather than a locally synthesized peer capability.

## Model Experience

None, as pairing, Relay authority, and Companion transport metadata never enter a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Desktop and Mobile product entries assemble endpoint-owned first pairing, durable static state, credential-bound Relay peer discovery, and one Snow IK channel per physical attachment. Platform mounts the opaque mailbox and digest-only Relay authority without endpoint keys or application plaintext.
- Node 22 and 24 plus the existing simulator and emulator proof cover the selected Snow dependency. Physical iOS and Android evidence and the independent security-review record for this exact adapter remain release blockers.
