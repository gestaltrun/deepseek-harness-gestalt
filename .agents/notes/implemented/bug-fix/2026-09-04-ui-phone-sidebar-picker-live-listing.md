# Agent Note: Sidebar Phone picker follows Host fleet listing

Status: implemented

English | [中文](2026-09-04-ui-phone-sidebar-picker-live-listing.zh.md)

## Problem

USB reals that Host already listed (`GET /phone/devices` `ios.reals[]`) appeared in Settings → Phone Devices but not in the sidebar Phone picker USB group. PhoneTab pulled the fleet only on enable/mount and 「重新检测环境」. Settings overlay polled every 5000 ms on its own listing instance, which never wrote the Session Surface snapshot. Occupying a device set `tab.meta` `{ kind: 'device' }`; PhoneTab (and 「重新检测环境」) never rendered again, and the connected dropdown kept that stale snapshot. Issue #562.

## Decision

PhoneTab and PhoneConnectedView subscribe to the Session Surface `PhoneListingSource` and poll `GET /phone/devices` every `PHONE_LISTING_POLL_INTERVAL_MS` (5000 ms, Host `phone-runtime` `pollIntervalMs` default) while the tab is mounted and enabled. `startPhoneListingPoll` owns that interval; a failed refresh keeps the last committed listing. Settings overlay may keep a separate listing instance; the Session Surface listing used by PhoneTab and PhoneConnectedView polls itself.

Occupation is not a dead end. `showPhonePicker` `updateTab`s the picker title resolver (手机 / Phone) and `meta: {}` (no `kind: 'device'`). `updateTab` writes `meta` only when the patch field is present, so the empty object is the picker payload. The connected view’s 选择设备 control calls that helper and returns to the picker with 「重新检测环境」.

## Alternatives considered

**Rely on Settings overlay polling alone.** Rejected: overlay listing does not write the Session Surface snapshot the picker and dropdown read.

**Poll only the connected dropdown.** Rejected: the USB group lives on PhoneTab; a plugged real must appear there without occupying a device first.

**Leave occupation until the user closes the tab.** Rejected: the singleton Phone tab would hide 「重新检测环境」 for the rest of the layout restore.

**Share one listing object between overlay Settings and Session Surface.** Rejected for this ticket: overlay may stay a separate instance; Session Surface must poll regardless.

## Consequences

A USB real that Host lists within one poll interval appears in the picker USB group and the occupying dropdown without 「重新检测环境」. 选择设备 restores the picker. Package tests pin the USB-group commit, picker return, and a later online real in the dropdown.

## Related

Occupation meta remains [the connected-device view](../feature/2026-08-28-ui-phone-connected-device-tabs.md). Settings-card polling remains [the listing-backed card](2026-08-28-ui-phone-settings-listing-source.md).
