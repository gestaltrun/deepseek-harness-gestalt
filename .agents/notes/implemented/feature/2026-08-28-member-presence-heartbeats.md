# Agent Note: Member presence aggregates authenticated installation heartbeats

Status: implemented

English | [中文](2026-08-28-member-presence-heartbeats.zh.md)

## Problem

Roster reads in the project registry HTTP surface must attach per-member presence, and the semantics are already fixed: presence derives solely from connection liveness, per [the project membership authority note](2026-08-27-project-membership-core.md). The Platform turned out to have no general installation-liveness source to aggregate. Relay shared-directory entries are TTL-shaped but exist only while a Mobile Access attachment is live, so they answer attachment liveness for one feature, not member presence. Account session records authorize for up to thirty days regardless of whether the installation is running, and `trackConnection` answers "holds a socket on this instance" — in-process, and no Desktop surface holds a long-lived Platform connection today. Aggregating any of these would present stale authorization as presence.

## Decision

`project-membership-http` owns a heartbeat registry. `POST /v1/projects/presence/heartbeat` authenticates through the existing Account session proof and resolves the installation via `currentInstallation`, then records `(accountId, installationId)` with a fresh expiry. Desktop calls it on the `presenceHeartbeatIntervalMs` cadence (Config default 60 seconds); each beat stays live for `presenceTtlMs` (Config default 90 seconds), and the composition fails loud when the TTL does not exceed the interval. Roster reads union live entries per account and attach `presence: 'online' | 'offline'` to every member; expiry is the only route to offline — no manual state, no idle inference, no grace windows beyond the TTL itself. The session presentation every route reads — bearer access token plus `x-gestalt-proof-*` installation proof headers — comes from `accountSessionPresentation`, exported by the Account HTTP consumer, which keeps one implementation of the Account-over-HTTP session format across its consumers.

Storage is a process-local TTL map behind the reserved `PresenceStore` interface (`record`, `onlineAccountIds`). A deployment that runs multiple Platform instances implements that adapter with a shared TTL store; the registry, the route, and the roster projection do not change.

## Supersession check

The [project membership authority note](2026-08-27-project-membership-core.md) is not superseded: this note records the aggregation mechanism beneath the semantics it already owns. One timing fact is bounded by this mechanism — with periodic heartbeats, offline arrives at TTL expiry after the last beat, not at the instant the installation stops communicating; the older note's liveness-only verdict, its rejected idle-inference alternative, and its no-queue delivery stance all stand.

## Alternatives considered

**Aggregate the Relay shared directory.** Rejected: those entries exist only while Mobile Access is enabled, so they generalize to neither Desktop presence nor deployments that leave Mobile Access off.

**Derive presence from Account session records.** Rejected: a session authorizes refresh for up to thirty days independent of the installation running, so every member would read online.

**Derive presence from `trackConnection`.** Rejected: it answers which sessions hold sockets on one instance, nothing holds such a socket from Desktop today, and its registry is closed on invalidation rather than expiring with liveness.

**Require a persistent presence socket per Desktop.** Rejected for this surface: it couples presence to a long-lived connection the collaboration plane does not otherwise need, and a periodic authenticated call reuses the session-proof path every route already trusts.

## Consequences

Presence is per-instance until a shared `PresenceStore` lands; the README Known Limitations carry that deployment condition. A member whose installations stop beating reads offline within one interval plus one TTL — network partitions and sleeping laptops present as offline, which is the honest answer to "can I hand this person a decision right now". Registry tests drive a fake clock directly, and the HTTP expiry test boots a short TTL over real TCP, so no test sleeps against the 90-second default.
