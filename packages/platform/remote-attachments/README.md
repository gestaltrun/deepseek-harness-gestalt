# `@deepseek-ai/dsh-remote-attachments`

English | [中文](README.zh.md)

Pairing-scoped encrypted attachment blob store for Remote Access. Mobile uploads endpoint-encrypted ciphertext over HTTPS and receives a size- and expiry-bounded one-time capability scoped to exactly one Personal Pairing; Desktop exchanges that capability for the ciphertext exactly once, verifies its hash, decrypts on the endpoint, and submits the attachment into the existing Session path. The WSS Relay path carries only the bounded `offer-attachment` control message.

## Blob store

`RemoteAttachmentStoreProvider` (`ctx.remoteAttachments`) is the in-process fixture and retains ciphertext plus capability, owning `PersonalPairingId`, expiry, and an optional Account quota reservation. The accepted protocol ceiling is 104,857,600 ciphertext bytes (100 MiB) per blob and a 900,000 ms (15 minute) default capability lifetime; a deployment may configure lower values (`maxBlobBytes`, `capabilityLifetimeMs`), never higher. Mobile rejects plaintext whose sealed payload (`plaintext + 28` bytes of AES-GCM IV and tag) would exceed that ciphertext ceiling. An admitted Account reservation carries a durable absolute lease expiry; publish rejects and releases any lease that ends before the proposed blob expiry, so quota cannot disappear while blob authority is active. `maxRetainedBlobs` bounds total capacity and fails explicit `ATTACHMENT_CAPACITY` errors after sweeping expired entries; `sweepIntervalMs` drives a re-arming background expiry sweep that `dispose()` cancels. Every completed consume, lazy or swept expiry, and pairing-scoped `revoke` removes the blob, capability, and quota reservation. Empty ciphertext fails as `ATTACHMENT_EMPTY`. Misconfiguration above a ceiling, or a non-positive `maxRetainedBlobs`, fails at construction. `publish`, `inspect`, `observe`, and `consume` copy ciphertext so caller or observer mutation cannot change retained bytes.

The store plugin (`name: '@deepseek-ai/dsh-remote-attachments'`) exposes those bounds as a Schemastery `Config` reachable from cordis.yml. Capabilities are 256-bit one-time values from `parseAttachmentCapability`; `inspect` and `consume` reject cross-pairing use (`ATTACHMENT_PAIRING_MISMATCH`) without consuming the blob, unknown, claimed, or already-consumed capabilities (`ATTACHMENT_CAPABILITY_INVALID`), and expired ones (`ATTACHMENT_EXPIRED`). `consume` returns an exclusive claim: `complete()` permanently settles successful delivery, while `abandon(now)` restores an unexpired blob after failed delivery. `revoke({ pairingId, capability })` is the same pairing check: a mismatch fails without deletion, and an unknown capability is a no-op. `observe()` projects copies of retained ciphertext and metadata for Platform-side operations; no plaintext exists on this side of the security boundary.

## HTTP routes

The `remote-attachments-http` plugin (`@deepseek-ai/dsh-remote-attachments/http`) registers three exact routes over the mounted store and requires `webServer`, `remoteAttachments`, and the `remoteAttachmentAuthority` pairing seam. Its `origin` Config is the trusted browser origin. Disposing the plugin fiber unregisters the routes.

- `POST /v1/remote-attachments` — raw ciphertext body with a positive exact `Content-Length`; Account-complete quota admission precedes body reads and publish, then the route responds `201` with `{ capability, byteLength, expiresAt }`, `400 ATTACHMENT_EMPTY` or `CONTENT_LENGTH_MISMATCH`, `411 CONTENT_LENGTH_REQUIRED`, `413 ATTACHMENT_LIMIT_EXCEEDED`, or `429 QUOTA` / `PLATFORM_CAPACITY` with `retryAfter`. A rejected or interrupted body releases its reservation.
- `POST /v1/remote-attachments/consume` — `{ capability }` JSON; atomically claims before writing and responds `200` with raw ciphertext, `403` cross-pairing, `404` unknown or already claimed, or `410` expired. A failed body write abandons the claim for retry; a finished body is never replayed even if settlement cleanup fails.
- `POST /v1/remote-attachments/revoke` — `{ capability }` JSON; responds `204` after a pairing-scoped revoke, or `403` when the authenticated pairing does not own the capability.

## Pairing seam

`RemoteAttachmentAuthority.authenticate({ headers })` maps one HTTPS request to exactly one `PersonalPairingId` plus `admit(bytes)`, which reserves one opaque Account-complete quota lease with an absolute `expiresAt` and idempotent `release()`. The operated Platform implementation verifies the current Mobile Installation proof and exact confirmed pairing selector against PostgreSQL; a selector alone grants no authority. It never sees attachment plaintext. A missing authority service fails plugin load loudly.

## Model Experience

None, as attachment ciphertext and capabilities never enter a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- `RemoteAttachmentStoreProvider` remains a fixture for package tests. The operated Platform first deploys the PostgreSQL atomic-consume bridge to every host, then enables private OSS bytes in a separate deployment after every predecessor reports bridge mode. The bridge and OSS store share a claim token; active sweeps remove expiry and explicitly inactive pairing candidates and release quota reservations.
- Desktop maps consume HTTP 403/404/410/413 onto protocol-native rejection reasons, decrypts only after hash verification, and admits exact bytes through the Session-scoped Host file RPC.
