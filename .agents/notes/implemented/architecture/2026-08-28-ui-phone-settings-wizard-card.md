# Agent Note: Ship the ui-phone Plugins-tab settings wizard card

Status: implemented

English | [中文](2026-08-28-ui-phone-settings-wizard-card.zh.md)

## Problem

Issue #360 requires the six-state 「手机设备」 settings card from [settings-card.html](../../../../design/device-dock/settings-card.html) — off, probing, Android wizard, iOS wizard, ready inventory, and three recoverable error rows — on the existing `packages/client/ui-phone` plugin. Detection data lives on Host `ctx.phoneDevices`, which this ticket must not modify, and tool-phone does not exist yet. The Plugins tab only dispatches cards whose `settings.plugin.item` key matches a Host-served namespace, so a card without that join key never renders.

## Decision

The Node half registers the durable `ui-phone` section (`enabled: boolean`, default `false`) through `ctx.inject(['settings'], …)` / `settings.register`, the same optional-settings pattern as ui-theme and ui-browser. The browser half owns the six-state wizard chrome; the page that hosts it is the top-level Phone Devices section recorded in [the settings-section note](2026-08-28-ui-phone-settings-section.md). The card is a pure-props component switching on `PhoneEnvironmentView`; command rows copy the locked mockup strings (`sdkmanager --install …`, `avdmanager create avd …`, `emulator -avd Pixel_6_API_35`, `xcodebuild -downloadPlatform iOS`, `xcrun simctl create …`) through an injected `onCopy`. Error rows share one verb, 「下一步动作」. Detection rides a narrow `PhoneEnvironmentSource`; the shipped `MISSING_PHONE_ENVIRONMENT_SOURCE` is the probe-failed row used when `phoneDevices` is absent. `phone-runtime` is not imported.

## Alternatives considered

**Put the card in ui-settings-plugins next to Bash / Agent loop.** Rejected: the cookbook's join key is the plugin's own namespace, and a card outside this package would split Host register from browser chrome.

**Import `PhoneDevices` from phone-runtime and probe inside the card.** Rejected: this ticket forbids changing phone-runtime, the browser half cannot take a Host service as a value import, and a missing service must still render the probe-failed row.

**Keep `Config.enabled` as the only enable flag and skip Host `settings.register`.** Rejected: the Plugins tab never dispatches a card whose namespace the Host does not serve.

**Hand-roll per-error verbs (安装指引 / 打开 Android 向导 / 构建 WDA).** Rejected: review item #2 of the ticket unifies the failure verb as 「下一步动作」.

## Consequences

The Phone Devices section wraps the same Host `GET /phone/devices` listing the picker uses: a successful pull reaches probing, both wizards, and ready, and a missing fleet route stays on the probe-failed row. Device-tool registration stays off while `enabled` is false; this package still does not spawn mobilecli. The tab strip reads `PhoneListingSource` as [the skeleton note](2026-08-27-ui-phone-tab-skeleton.md) records.
