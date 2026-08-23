# Agent Note: Pairing-scoped encrypted attachment transfer

Status: implemented

English | [中文](2026-08-19-encrypted-companion-attachments.zh.md)

## Problem

A Mobile user must attach a file to a Desktop-owned Session without exposing plaintext to Platform and without pushing large frames through the live WSS Relay stream. The transfer needs a pairing-scoped capability whose size and expiry are bounded by the accepted ceilings (100 MiB ciphertext per blob, fifteen-minute default lifetime), explicit failure for cross-pairing use, hash mismatch, expiry, interrupted transfer, and limit violations, and removal of the blob and its capability after successful receipt, expiry, or revocation.

## Decision

The encrypted path is split by boundary. `@deepseek-ai/dsh-remote-protocol` gains a bounded `offer-attachment` Companion operation (capability, SHA-256, exact byte count, expiry, bounded file name), an `attachment-rejected` result with protocol-native reasons, a 256-bit `AttachmentCapability` brand with its parser, fixed wire limits, and an endpoint attachment cipher (HKDF-SHA-256 → AES-256-GCM plus SHA-256 ciphertext hashing) linked only by Mobile and Desktop.

`@deepseek-ai/dsh-remote-attachments` owns the Platform side. The in-process provider remains a package fixture; the operated application mounts a PostgreSQL store whose transactional digest, ciphertext, pairing, expiry, capacity, consume, and revoke state is shared by Platform instances. The HTTP plugin authenticates each request through the current Mobile Installation proof and an exact confirmed pairing selector; the selector alone grants no authority. Platform receives neither the endpoint key nor plaintext. Consume deletes the blob only after the HTTP response finishes; a mid-write failure keeps it for retry.

Mobile reads the selected browser `File`, seals its bytes with the separate random 32-byte attachment key for the exact pairing, clears its local byte copy, uploads only ciphertext with current Installation proof, and sends only the bounded operation through the current-generation Snow channel. Desktop generates that key in the durable confirmation transaction and delivers it with the Mobile grant inside the first XKpsk3 transport payload; the transcript hash remains limited to authentication words. Desktop maps the authenticated Relay selector to the confirmed pairing id, looks up that exact endpoint-owned key, verifies and decrypts the blob, and calls `session.admitAttachment` on the loopback Host. `AttachmentStore.saveFile` atomically publishes the exact bytes; the Host appends a log-only `session/attachment-admitted` reference and flushes it without adding bytes or filename text to model history. Identical operation retries return the recorded reference, while a conflicting operation id fails. Release erases the attachment key independently from the 96-byte IK reconnect record.

## Alternatives considered

**Stream the blob as Relay ciphertext frames.** The 65,535-byte ciphertext frame ceiling would turn one 100 MiB attachment into thousands of live frames on the WSS path, violating the bounded-control-message requirement and re-coupling bulk transfer to liveness. HTTPS upload/download keeps the live stream small.

**An OSS-backed blob store.** It would add a second storage dependency. PostgreSQL already provides the required cross-instance transactions for single-use consume, capacity, expiry, and revocation.

**A Desktop-owned blob channel.** Desktop is not a publicly reachable upload target for a phone on another network; Platform is the only rendezvous both endpoints already share.

## Consequences

The assembled test runs shipped Mobile mutation and receiver adapters through real XKpsk3/IK into `DesktopCompanionProductOwner` and a random-port loopback Host. Binary, image, and text bytes become immutable Session references, authoritative search returns hit and no-hit results, Host 400 remains typed and visible, and no `Attached: <fileName>` prompt exists. Disposable PostgreSQL tests prove cross-instance upload/consume, single use, cross-pair rejection, expiry, capacity, and replacement. Physical WKWebView/Android WebView execution and independent security review remain external release evidence.
