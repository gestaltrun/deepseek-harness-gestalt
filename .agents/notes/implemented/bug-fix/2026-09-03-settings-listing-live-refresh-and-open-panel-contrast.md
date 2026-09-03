# Agent Note: Settings listing follows Host fleet; open-panel contrast

Status: implemented

English | [中文](2026-09-03-settings-listing-live-refresh-and-open-panel-contrast.zh.md)

## Problem

The Phone Devices settings card kept 「运行中」 and an enabled 「打开面板」 after the Host fleet and `simctl` had already gone Shutdown / `offline`. The footer already claimed live listing refresh. `createListingPhoneEnvironmentSource` only pulled in `redetect` and never `listing.subscribe()`, so a later listing commit could not notify the card. The HTTP listing source never polls; Host `phone-runtime` already polls `devices.list` every `pollIntervalMs` (default 5000 ms), and the browser has no Host change stream for `GET /phone/devices`.

Enabled 「打开面板」 used `color: var(--dsw-static-neutral-bluish-00)` on `button-primary-fill`. Dark theme primary fill is light, so the label disappeared.

## Decision

The settings environment source subscribes to listing commits after the first `redetect` / `ensureDetected` and republishes the ready inventory. While that source is ready and has card subscribers, it refreshes `GET /phone/devices` every `PHONE_LISTING_POLL_INTERVAL_MS` (5000 ms, matching Host `pollIntervalMs` default). A failed refresh keeps the last committed listing. The card controller follows the source only while `ui-phone.enabled` is true, so a disabled deployment does not poll. Polling also pauses during a later `redetect` probing pass and stops when the last subscriber leaves.

Enabled and hover 「打开面板」 use `color: var(--dsw-alias-label-primary-foreground)` so the label tracks the theme foreground on the primary fill.

## Alternatives considered

**Require 「重新检测」 after every Host fleet change.** Rejected: the footer already promises live refresh, and Host already polls on a 5 s cadence.

**Poll inside `createHttpPhoneListingSource` for every consumer.** Rejected: a disabled deployment must not discover devices; the listing source is shared with the picker and has no enable/ready phase.

**Subscribe to a Host listing change stream.** Rejected: `GET /phone/devices` is the only browser channel.

**Keep `--dsw-static-neutral-bluish-00` for the open-panel label.** Rejected: that static white token is invisible on the dark-theme light primary fill.

## Consequences

Settings inventory can lag Host by one poll interval. Disabling the plugin unsubscribes the card, which stops GET polling. Tests pin offline `getView` without a second `redetect`, a second poll notification, failed-poll retention, and the open-panel CSS token.
