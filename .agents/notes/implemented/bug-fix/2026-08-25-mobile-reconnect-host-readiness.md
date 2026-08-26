# Agent Note: Keep Mobile Readable While Desktop Host Authority Reconnects

Status: implemented

English | [中文](2026-08-25-mobile-reconnect-host-readiness.zh.md)

## Problem

Desktop started Personal Pairing Relay access before its Web Host announced a loopback URL. A foreground Mobile could authenticate Relay and request the selected Session while `DesktopCompanionProductOwner` still had no Host authority. When Desktop then disconnected, `MobileBrowse` also requested missing history while foreground synchronization was already closed; the synchronous refusal escaped a React effect and unmounted the complete Mobile tree.

The live presentation clock was subscribed through a new function on every render. React therefore detached and reattached the only clock observer across connection-state renders, refreshing the clock snapshot and adding an unnecessary update path during the same failure sequence.

## Decision

Packaged Desktop starts signed-in Personal Pairing only after the Web Host is installed. It schedules that lifecycle start without delaying `window.loadURL()`, so a retained Mobile Access state or slow Relay attachment cannot leave the Desktop window blank while the Host is already available. Account sign-in and process resume use the same readiness predicate, so waking while initial or replacement Host startup is incomplete cannot restart Relay access. The pairing controller serializes start, deactivate, and replacement start across one lifecycle generation owner. It rechecks the captured Host predicate before and after refresh, stops a stale in-flight start as `host-unavailable`, and admits the replacement only after that cleanup. A typed `REMOTE_OFFLINE` from Relay startup is a settled cancellation only when that owning generation became stale; unrelated refresh failures continue through shutdown aggregation. Host exit still retains a previously established Relay long enough to return typed Host failures; generation cancellation applies only to an in-flight startup that has not established current Host authority.

`MobileBrowse` never requests history without current mutation authority. Losing synchronization clears its local history-request fence so a later synchronized generation can request the missing conversation. The clock subscription callback remains stable for the lifetime of its clock owner.

## Alternatives considered

**Let Mobile retry every Host-unavailable history response on a timer.** Rejected because it turns Desktop startup latency into an unbounded encrypted request loop and hides the false Online state.

**Catch the synchronous history error only.** Rejected because the page would stay mounted but retain a request fence that prevents the synchronized generation from loading the conversation.

**Stop projecting Host failures after Relay authentication.** Rejected because a Host can fail after a valid connection and Mobile must continue to display typed HTTP, wire, business, and timeout results.

## Consequences

Desktop replacement keeps the opened Mobile conversation and cached rows visible, disables mutation controls while offline, and restores the same encrypted channel only after Host authority is ready. Desktop window loading is independent of Relay readiness, while shutdown drains the controller-owned background start and settles its typed Relay cancellation. A foreground disconnect cannot throw `Companion history requires foreground synchronization` through React. Host failures after an established Desktop remains online are still application data rather than Relay disconnects.

## Testing

Desktop readiness coverage keeps pairing stopped for every incomplete Account/Host combination and delegates the current-generation predicate to the controller. Lifecycle coverage interleaves a slow old start, Host replacement stop, and new start, then proves only the replacement owns Relay. Mobile coverage rejects offline history submission and keeps one clock subscription across renders. A packaged Desktop with retained Mobile Access loads its Web Host window before the existing pairing finishes Relay startup. Desktop stop and replacement leave the Android opened conversation mounted, disable its composer while offline, restore it without a Host-unavailable error, and preserve the Account, pairing, keys, and cache across an in-place APK upgrade.
