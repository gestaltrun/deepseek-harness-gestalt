# Agent Note: Own Phone Devices as a top-level settings section

Status: implemented

English | [中文](2026-08-28-ui-phone-settings-section.zh.md)

## Problem

Issue #417's later acceptance decision moves phone-device configuration off the Plugins page. Putting the six-state wizard next to Bash / Agent loop mixed device-under-test debugging with Host plugin tunables, and the nav label collided with Mobile Companion (a person connecting a phone to the desktop).

## Decision

`packages/client/ui-phone` contributes `settings.section` `id: phone-devices`, order 40 (after Browser 35, before Mobile Companion 50), locale namespace `settings.phone-devices`, nav label 「手机设备」 / Phone Devices. The section body is the existing six-state card. Host `settings.register('ui-phone')` is unchanged. The package no longer registers `settings.plugin.item`. The intro copy states the Companion distinction in one sentence.

## Alternatives considered

**Keep the wizard as a Plugins card.** Rejected: the acceptance decision requires a top-level section, and Plugins remains the Host-plugin tunables page.

**Reuse the Mobile Companion section.** Rejected: Companion is a person connecting a phone to the desktop; this page is device-under-test debugging.

**Rename the Host namespace.** Rejected: only the presentation home moves; durable `ui-phone.enabled` stays the join key with the tab enable gate.

## Consequences

The Plugins tab no longer lists a phone card. The wizard's view union, copy-button commands, and listing-backed source stay those of [the settings-wizard note](2026-08-28-ui-phone-settings-wizard-card.md) and [the listing-source note](../bug-fix/2026-08-28-ui-phone-settings-listing-source.md).
