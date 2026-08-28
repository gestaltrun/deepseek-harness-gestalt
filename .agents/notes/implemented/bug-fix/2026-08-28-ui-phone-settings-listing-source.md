# Agent Note: Drive the phone settings card from the Host fleet listing

Status: implemented

English | [中文](2026-08-28-ui-phone-settings-listing-source.zh.md)

## Problem

Issue #417 P1 records that the Plugins-tab 「手机设备」 card always injected `MISSING_PHONE_ENVIRONMENT_SOURCE`, so probing, both wizards, and the ready inventory were unreachable even after Host `phoneDevices` published `GET /phone/devices`. K4 records incomplete JSDoc on `ui-phone` public helpers (`registry.ts`, `invariant.ts`, plus the later connection/stream helpers the gate also names).

## Decision

The card and the picker share one `PhoneListingSource`. `createListingPhoneEnvironmentSource` maps that listing onto `PhoneEnvironmentView`: probing while the pull is in flight, ready when any device is listed, iOS wizard on macOS with an empty listing, Android wizard otherwise, and the probe-failed row only after a refused or unreachable first pull. `PhoneSettingsCardController` follows the source through `subscribe` and starts a pull when `enabled` is true. Public helpers named by `verify-export-jsdoc` carry `@param` / `@returns`.

## Alternatives considered

**Import `PhoneDevices` into the browser half.** Rejected: the browser cannot take a Host service as a value import; the listing route is already the same-origin fleet face.

**Keep a second fetch just for the settings card.** Rejected: the picker already owns `GET /phone/devices`; a second source would desync the two surfaces.

**Leave the JSDoc gaps as baseline debt.** Rejected: K4 of #417 names those exports as the gate that must go green.

## Consequences

An empty but successful listing still opens a platform wizard because the listing body carries no adb/SDK/Xcode probe facts. The card's view union and copy-button commands stay those of [the settings-wizard note](../architecture/2026-08-28-ui-phone-settings-wizard-card.md).

The card controller kicks the source's one-shot `ensureDetected` on every enabled publish instead of redetecting eagerly at construction, so the probing view is the first enabled paint (the scope is usually still unhydrated when the card constructs) and only a failed probe settles on the probe-failed arm.
