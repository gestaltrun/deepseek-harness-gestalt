# Agent Note: Companion Session creation authority

Status: implemented

English | [中文](2026-08-24-companion-session-creation-authority.zh.md)

## Problem

Mobile could send Workspace-owned and Ungrouped `session.create` operations through the encrypted Companion channel, but the terminal result discarded the Host Session id. The shared Workspace presentation intentionally hides a blank Session unless it is current, so an authoritative refresh could contain the created row while the shipped Mobile screen still showed no result of the button click. A fixture that asserted only the operation or Host call could not prove product delivery.

## Decision

The Companion mutation result `session-created` carries the branded Session id returned by the real Host together with the operation id and commit time. Desktop retains that exact result in the durable operation ledger, including status-query replay. Mobile accepts it as creation confirmation but does not synthesize a Session row. It records a pending selection owned by the current physical connection and applies that selection only when an authenticated resync on the same connection contains the confirmed id. A replacement connection clears the pending selection; uncorrelated, failed, absent, and duplicate outcomes cannot introduce visibility. A reconciled committed receipt restores the same pending selection after restart.

The assembled acceptance mounts the production Mobile surface and shared `MobileBrowse`, clicks both shipped creation buttons, sends the operations through Snow, executes the real Desktop Host `session.create` with a real Session store and Workspace registry, reloads the file operation ledger, and waits for authoritative refreshes to render the new blank Sessions in the Workspace-owned and Ungrouped groups. Only external Account, Platform, and Relay transport authority is represented by deterministic adapters in this test.

## Alternatives considered

**Show every blank Session.** This weakens the shared presentation rule and exposes unrelated transient or abandoned Sessions.

**Create an optimistic Mobile row from the button input.** Mobile would become a second Session authority and could display a Session that Desktop rejected or never committed.

**Return generic confirmation and infer the new id from the next list diff.** Concurrent creation, paging, and reconnect make the inferred row ambiguous, and an old connection could select a Session in a replacement generation.

**Prove creation with a protocol or Host mock alone.** Those checks do not exercise the shipped button, shared grouping, Snow transport, durable ledger, real Host adapter, or authoritative refresh as one flow.

## Consequences

Session creation has a distinct terminal wire result and durable receipt representation. Mobile keeps selection as presentation state rather than cached Desktop authority, and selection is consumed by the first same-generation authoritative projection that contains the exact id. The assembled test is slower than a component fixture because it mounts the real persistence and Host stack, but it detects breaks at every production seam required by the user-visible flow.
