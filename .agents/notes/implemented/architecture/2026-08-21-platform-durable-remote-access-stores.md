# Agent Note: Durable Platform Remote Access stores

Status: implemented

English | [中文](2026-08-21-platform-durable-remote-access-stores.zh.md)

## Problem

Two production Platform Instances sit behind one non-sticky TLS balancer and share PostgreSQL. Pairing challenges, confirmed Mobile authority, and Relay credential digests cannot live in process memory, or a Desktop enable on one host is invisible to a Mobile completion on the other. The production listen process also cannot mount pairing HTTP or Relay WSS until a reviewed Noise handshake exists.

## Decision

[`launchOperatedPlatform`](../../../../apps/platform/src/launch.ts) migrates two PostgreSQL adapters before listen: [`PostgresPersonalPairingAuthorityStore`](../../../../apps/platform/src/postgres-pairing-store.ts) owns Desktop routes, confirmed Mobile pairing results, and the exclusive pairing-transaction document, and [`PostgresRelayRouteStore`](../../../../apps/platform/src/postgres-route-store.ts) owns hashed Relay credentials and monotonic revisions. [`pairing-state-codec.ts`](../../../../apps/platform/src/pairing-state-codec.ts) encodes the exclusive `PersonalPairingTransactionState` Maps, including orphan cleanup identity, as jsonb. `runPairingTransaction` takes `SELECT … FOR UPDATE` on one row keyed by database identity so both instances serialize the same lease. Pairing HTTP and Relay WSS stay unmounted; `DevelopmentKeylessPairingHandshakeProvider` is never selected by this listen process.

## Alternatives considered

**Mount pairing HTTP and Relay WSS with the development keyless handshake.** Rejected: the production path stays fail-closed until the independent Noise review admits a product handshake. Keyless adapters remain development-only.

**Keep in-memory stores now and add PostgreSQL when Relay mounts.** Rejected: the tables must exist before the first enable or confirm crosses instances, and listen already owns the Account PostgreSQL pool.

**Give each instance a private pairing database.** Rejected: a non-sticky balancer would split one Personal Pairing lifecycle across two authorities.

## Consequences

Rolling apply creates the shared tables without opening a pairing or WSS route. A later mount can reuse the same adapters and Redis coordinator. The trade-off is that Desktop Settings and Mobile cannot complete production pairing until the handshake is approved.

## Testing

[`apps/platform/tests/pairing-state-codec.spec.ts`](../../../../apps/platform/tests/pairing-state-codec.spec.ts) and [`apps/platform/tests/postgres-remote-access-stores.spec.ts`](../../../../apps/platform/tests/postgres-remote-access-stores.spec.ts) pin codec rejection, orphan identity, Desktop route keep-or-replace, Mobile collision, exclusive transaction rollback, and route rotate/issue/authorize/revoke. [`product-entry-durable.spec.ts`](../../../../apps/platform/tests/product-entry-durable.spec.ts) drives the executable's launch composition against disposable PostgreSQL and Redis stores, including operated environment validation and GitHub OAuth identity, without claiming live infrastructure evidence.
