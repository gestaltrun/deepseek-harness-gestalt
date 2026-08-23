# Agent Note: Open-registration quotas and capacity shedding

Status: implemented

English | [中文](2026-08-19-open-registration-quotas-capacity.zh.md)

## Problem

Open GitHub registration would otherwise let one Account or one IP exhaust Platform installations, pairings, ciphertext uploads, and live connections. The [Mobile Companion proposal](../../proposed/feature/2026-08-17-mobile-companion.md) already rejected an allowlist, an account-count ceiling, automatic scaling, and an operator disable console. Quota numbers are spec-fixed security invariants; only the two-instance capacity watermark and its retry delay vary by deployment. A quota helper that is not invoked from login, pairing, blob, or WSS attach leaves those ceilings unenforced.

## Decision

Account owns the login-side ceilings and the shared `PlatformCapacityState` type: ten live Desktop installations, ten live Mobile installations, twenty concurrent tracked connections, and a 60-second hard-cap `retryAfter`. Completing `pollLogin` admits a replacement for an existing Installation and rejects the eleventh new Desktop or Mobile session with `QUOTA`. `consumeAuthorizedAttempt` counts live installations of that kind inside the same backend transaction that inserts the session; the Postgres backend locks the Account row before that count. `trackConnection` resolves an unbound session through `AccountBackend.getSession`, admits the twentieth closer for one Account, and rejects a missing, inactive, or twenty-first closer without closing established closers. An injected `PlatformCapacityState` sheds `beginLogin` and a completing `pollLogin` with `PLATFORM_CAPACITY`. A second GitHub identity still registers.

Remote Access owns pairing and blob ceilings and implements `MemoryPlatformCapacityGate` as `PlatformCapacityState`, so Account never depends on Remote Access. One Account may retain fifty Personal Pairings and create ten Pairing Challenges per hour; one IP may create thirty per hour. `admitAttachmentBlob` and `releaseAttachmentBlob` enforce five concurrent declared blobs, 100 MiB per blob, and 1 GiB declared upload per Account per day without storing ciphertext. Confirming a pairing checks the fifty-pairing cap before handshake activation. Sliding-window rejections return remaining-window seconds via `retryAfterSecondsUntil`, at least one; hard caps (`bytes > blobBytes`, concurrent blobs at the watermark, installation, connection, and pairing ceilings) return 60 seconds. Established ciphertext streams and confirmed pairings are not throttled. Capacity shedding rejects new login, pairing, blob, and WSS attach.

Hourly challenge, concurrent blob, and daily upload windows live in `PersonalPairingTransactionState` beside the fifty-pairing snapshot, so two providers that share one `PersonalPairingAuthorityStore` enforce one Account-complete limit. `createChallenge` requires a non-empty `clientIp`; Pairing Challenge HTTP supplies only `req.socket.remoteAddress`. `x-forwarded-for` is ignored because clients can spoof it; a trusted-proxy mapping remains deployment work. HTTP `QUOTA` and `PLATFORM_CAPACITY` map to status 429, JSON `retryAfter` seconds, and a `Retry-After` header. HTTP `admit-blob` rejects a negative `bytes` field with status 400. Relay `tryAcquire` holds one watermark slot for a new attachment, transfers the hold on replacement, and releases on close or failed attach.

Per-counter storage and completeness: installations are `AccountBackend` rows counted inside `consumeAuthorizedAttempt`; fifty pairings, hourly Account and IP challenges, concurrent blobs, and daily upload bytes are shared-store transaction maps; twenty connections are a per-process `connections` map keyed after backend session resolution; the capacity gate is an optional constructor injection. `apps/platform` mounts Account, Remote Access, Relay, and encrypted attachments without passing the optional shared capacity gate to Account or Personal Pairing. The OSS attachment store and Relay still enforce their configured aggregate capacity and retry delay.

The implementation includes no allowlist, account-count ceiling, autoscale, or operator-disable console. Product attachment HTTP invokes `admitAttachmentBlob` before OSS publish and releases the durable reservation after consume, expiry, pairing revocation, or explicit revoke; the [operated OSS decision](../architecture/2026-08-23-operated-oss-attachment-authority.md) owns byte storage and cleanup.

## Alternatives considered

**Leave a standalone quota helper as the only evidence.** A helper that is not invoked from login, pairing, blob, or WSS paths cannot prove those ceilings; live providers own the comparators.

**Trust `x-forwarded-for` for the per-IP hourly cap.** A client can set that header and escape the IP bucket. The TCP peer address is the only value this process observes without a trusted proxy.

**Count cancelled Pairing Challenges against the per-installation retained-record cap only.** The hourly Account and IP ceilings count issued challenges. Cleaned replay records still evict after five minutes; cleanup-failed tombstones remain the way to hold sixteen retained records across an hour.

**Put every ceiling in Remote Access, or import Remote Access types into Account.** Login quotas would then reverse the Account → Remote Access dependency. Account owns login identity; Remote Access consumes it.

**Keep hourly and blob windows on the provider instance.** Two providers sharing one authority store would then double every window. Shared transaction maps match the fifty-pairing count.

**Share a Redis connection counter for the twenty-connection cap.** The twenty-connection cap remains an Account-process map. A deployment-shared counter is remaining two-instance evidence.

**Treat quota numbers as cordis.yml Config.** The Companion proposal fixed those integers as security invariants. Only the live WSS watermark and capacity retry delay stay deployment-validated Config.

**Shed established streams or disconnect live attachments at capacity.** The two-instance deployment preserves existing connections and rejects new acquisition until an operator expands capacity.

**Implement product blob storage here.** That protocol belongs to the [operated encrypted-attachment capability](../architecture/2026-08-23-operated-oss-attachment-authority.md). Declared-size admission still enforces the open-registration ceilings.

## Consequences

Open registration can stay open without an allowlist, while one Account or IP cannot unbounded-retain installations, pairings, or blobs. Operators still have to expand the two purchased instances by hand; CloudMonitor dashboards, a production shared capacity gate, a trusted-proxy client IP, and a cross-instance connection counter remain deployment work. A cold Account instance that has not yet seen `pollLogin` still enforces the twenty-connection cap after `getSession` binds the session, and rejects unknown ids. Per-installation live, pending, and retained pairing caps stay in force beside the Account-wide quotas; an Installation can hit `PAIRING_RESOURCE_LIMIT` before `QUOTA` when cleanup-failed tombstones fill the sixteen-record cap.

## Testing

Account unit tests pin the tenth and eleventh Desktop and Mobile installations, same-installation replacement, two concurrent new logins at nine live slots, the twentieth and twenty-first `trackConnection` including an unbound session resolved through the backend, a second GitHub identity, and login shedding. A Loader plus real TCP Account HTTP scenario repeats those bounds. Remote Access unit tests pin hourly account and IP challenges, a required client IP, fifty pairings with replay-retention and hourly-window advances, five concurrent blobs, the 100 MiB blob ceiling, exact 1 GiB declared daily bytes, hard-cap 60-second `retryAfter` for oversized and concurrent-full blobs, remaining-window `retryAfter` for the daily byte cap, and a second provider sharing one authority store rejecting the eleventh challenge and sixth blob. Capacity shedding leaves an established pairing listed. Real Personal Pairing HTTP repeats hourly, pairing, blob, and capacity envelopes, proves a spoofed forwarding header does not isolate a second IP bucket, and rejects negative `admit-blob` bytes with 400. Relay tests hold two watermark slots, attach desktop and mobile, reject a third attach with the gate retry delay, deliver one desktop-to-mobile ciphertext frame, and release on close or failed authorize. Clients preserve `QUOTA` / `PLATFORM_CAPACITY` and integer `retryAfter`.

## Related

- [Mobile Companion proposal](../../proposed/feature/2026-08-17-mobile-companion.md) — parent open-registration and capacity decisions.
- [Platform Account installation sessions](2026-08-17-platform-account-installation-sessions.md) — the sessions these installation and connection ceilings count.
