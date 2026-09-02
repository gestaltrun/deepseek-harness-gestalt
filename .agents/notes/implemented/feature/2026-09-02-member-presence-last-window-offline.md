# Agent Note: Last Desktop window close publishes Offline immediately

Status: implemented

English | [中文](2026-09-02-member-presence-last-window-offline.zh.md)

## Problem

Presence already means live Installation connection, per [the project membership authority note](2026-08-27-project-membership-core.md). The heartbeat registry in [the presence-heartbeats note](2026-08-28-member-presence-heartbeats.md) kept a member Online until TTL expiry after the last beat, so closing the last Desktop window left teammates waiting on a grace period and a routed ask could still see Online.

## Decision

Last-window close is an explicit presence close of the same heartbeat entry. Desktop POSTs `/v1/projects/presence/close` with the current-Installation proof before destroying the window; the registry drops that installation immediately, and a later roster read on any other online Installation shows Offline. Closing the last window also quits the Desktop Host, so reopening starts a new process whose boot `setSignedIn(true)` restores Online through the existing heartbeat derivation. TTL expiry remains the crash and partition path. A routed ask after that close fails fast with `MEMBER_OFFLINE` and writes nothing to a queue.

## Alternatives considered

**Keep Offline at TTL expiry after the last beat.** Rejected: the product contract is live connection, not a grace period, and teammates must not wait on an absent colleague.

**Derive last-window Offline from Relay socket teardown.** Rejected: member presence is independent of Mobile Access, and a Desktop without Relay still has a last window.

**Queue the ask until the member returns.** Rejected: the membership authority already forbids offline queues; stale answers hours later are worse than a stable fail-fast.

## Consequences

Crash and sleep without a close POST still wait for TTL; that remains the honest answer when the Installation cannot speak. Keyless assembled coverage asserts the Offline transition from window close rather than clock advance, then pins the `MEMBER_OFFLINE` no-queue ask. Desktop unit coverage pins that `setSignedIn(true)` after `closeWindow()` resumes heartbeats, which is the derivation a new process uses at boot.
