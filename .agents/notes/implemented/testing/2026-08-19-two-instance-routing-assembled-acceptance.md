# Agent Note: Assembled two-instance Remote Relay acceptance

Status: implemented

English | [中文](2026-08-19-two-instance-routing-assembled-acceptance.zh.md)

## Problem

Issue #32 requires Mobile and a Paired Desktop to reach Remote Online through outbound connections even when each attaches to a different Platform Instance. A lower-level runnable example constructs two Relay backends inside one Loader plugin, so it cannot prove that two independent Platform/WebServer/HTTP compositions publish and serve the WSS upgrade route or preserve per-pairing authority through non-sticky routing.

## Decision

Keep every product seam unchanged and add one REAL-composition acceptance test at the HTTP/WSS Consumer:

`packages/platform/remote-access-http/tests/two-instance-assembled.spec.ts` boots two independent in-process Loader compositions. Each mounts `WebServer`, `PersonalPairingProvider`, `RemoteRelayProvider`, Personal Pairing HTTP, and the published Relay WSS Consumer. Both compositions share `MemoryPersonalPairingAuthorityStore`, an in-memory `RelayRouteStore`, and one `RedisRelayCoordinator` over a test Redis bus. A local TLS listener proxies each HTTP Upgrade onto alternating instance ports, so every attachment runs through that instance's `webServer.registerUpgrade` owner. Two authenticated Mobile Installations complete endpoint-owned XKpsk3 mailboxes through HTTP, receive distinct Snow-sealed Relay authority, attach with four distinct P-256 credentials and attachment ids, establish attachment-bound Snow IK channels, and receive authenticated foreground synchronization. Actual endpoint private credential strings are absent from captured Platform HTTP bodies and pairing state. A wrong credential is rejected through both the non-sticky TLS endpoint and a direct instance WSS route. Disposing one Platform Instance causes a fresh attachment generation and IK handshake; revoking one Personal Pairing leaves the other phone able to reconnect and complete an encrypted Companion operation. Redis records no ciphertext values and exposes no List or Stream API.

Operated TLS load balancing, managed PostgreSQL/Redis, public DNS, physical WKWebView/Android WebView execution, and independent security review remain separate evidence. The memory stores, Redis bus, and localhost certificate make the repository test deterministic; they do not claim the operated data plane or trust chain.

## Alternatives considered

**Treat the existing `examples/two-instance-relay` snapshot as sufficient.** Rejected: that scenario boots one Loader plugin that then constructs two backends by hand and hands upgrades to a privately constructed WSS Consumer, so it does not execute two Platform Instance compositions or the published `WebServer` upgrade path.

**Hand a second `RelayWebSocketConsumer` the TLS socket.** Rejected: deleting the Loader's `registerUpgrade` would leave the round-trip green. The TLS front must proxy HTTP Upgrade onto the instance port.

**Drive two child processes against a disposable `redis-server` and PostgreSQL.** Deferred: CI does not install those binaries, the Redis adapter already has a skipIf integration, and shared in-process test adapters keep the assembled protocol path always runnable.

**Use the operated Platform boot as the repository test.** Rejected: that would require deployment credentials and infrastructure, while the repository test needs deterministic evidence for the same published plugin composition without claiming operated acceptance.

## Consequences

The repository has executable evidence for two independent Loader compositions, both published WSS upgrade routes, endpoint-owned Snow pairing and reconnect, two pairing-scoped credential sets and attachment identities, ciphertext-only cross-instance forwarding, fresh-generation recovery, and independent revocation. The test remains bounded to composition and protocol behavior; operated TLS/DNS/databases, physical WebViews, and independent security review retain their own evidence requirements.

## Testing

`pnpm exec vitest run packages/platform/remote-access-http/tests/two-instance-assembled.spec.ts` — one assembled case against two independent Loader compositions over loopback TLS, with in-memory pairing-authority and route-store adapters plus a test Redis coordinator. The built two-instance Snow example and package suites provide lower-level and artifact-plane coverage.

## Related

- Issue #32 (parent spec #27) — route one Paired Desktop across two Platform Instances.
- [Stateless two-instance Remote Relay](../architecture/2026-08-18-stateless-two-instance-remote-relay.md) — the provider, coordinator, and lifecycle decision this composition executes.
