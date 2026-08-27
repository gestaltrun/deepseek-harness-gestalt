# Agent Note: Project Relay Peers from the Current Shared Directory

Status: implemented

English | [中文](2026-08-28-current-relay-peer-projection.zh.md)

## Problem

One Desktop route may carry several independently paired Mobile devices, and each pairing owns a separate Desktop Relay attachment. Concurrent attachment registration and removal can cause different Platform Instances to publish complete peer snapshots in an order different from the directory mutations that produced them. A delayed snapshot can therefore remove a Mobile's current Desktop peer until another route change publishes a replacement. Pairing presence remains online because it is projected from independent leases, so Desktop Settings and the affected Mobile can disagree.

## Decision

Cross-instance `peer-update` messages are directory-change notifications rather than authoritative peer snapshots. After validating the target connection token and route revision, the receiving Relay provider lists the current shared route directory and derives the target-specific peer projection immediately before delivery. Pairing selectors continue to isolate each Mobile from the other Desktop pairing attachments on the same route.

The published message retains the bounded Relay wire fields used by the coordination adapter. Its embedded peer list does not become endpoint state. A shared-directory read failure does not deliver that possibly stale list.

## Alternatives considered

**Rely on Redis Pub/Sub ordering.** Redis preserves order from one publisher, but concurrent Platform Instances can list and publish the same route independently. Per-publisher order cannot establish one route-wide snapshot order.

**Add a route-wide peer projection sequence.** A sequence would require an atomic directory mutation and publication owner or another shared ordering record. Current-directory projection uses the existing directory authority and avoids a second consistency mechanism.

**Ignore empty peer updates while a channel is active.** A real Desktop disconnect must remove the peer immediately. Retaining an active channel based on its previous snapshot would route ciphertext toward an absent attachment and misstate mutation authority.

## Consequences

Concurrent Mobile devices remain independent: opening or closing one pairing cannot make another pairing consume an older peer snapshot. Every cross-instance peer notification adds one bounded shared-directory list operation at the receiving instance. Directory unavailability fails closed and preserves no offline queue or stale endpoint projection.

## Testing

Relay coverage installs a current pairing-scoped Desktop entry, delivers a delayed same-revision notification containing an empty peer list, and requires the Mobile target to receive the Desktop peer still present in the shared directory. Existing Relay coverage continues to verify selector isolation, replacement generations, close updates, revision invalidation, direct ciphertext delivery, and independent presence leases.
