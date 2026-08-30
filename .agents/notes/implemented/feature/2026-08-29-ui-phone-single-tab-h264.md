# Agent Note: ui-phone single-tab in-place switching, online-only lists, H264-only capture

Status: implemented

English | [中文](2026-08-29-ui-phone-single-tab-h264.zh.md)

## Problem

Issue #417's later user-acceptance pass reversed three client decisions that [the connected-tabs note](2026-08-28-ui-phone-connected-device-tabs.md) had locked: opening a second device minted a second tab, the switcher listed offline and unauthorized rows, and the live view requested MJPEG while an H264 chip sat disabled. The product now wants one 「手机」 tab that switches in place, a switcher of only online devices, and an H264-only capture request.

## Decision

The `phone` descriptor is `single: true`. `打开` and the device dropdown call `updateTab` on the occupying tab so its `meta` becomes `{ kind: 'device', serial, name }` and its title becomes `手机·<name>`. There is no `phone:<serial>` mint, no serial `dedupeKey`, and no `createTab` path. A serial change on `PhoneConnectedView` disposes the previous `PhoneConnectionController` and mints a session for the new device. A disabled `ui-phone.enabled` gate still drops the switch.

The switcher lists only `online` devices. Offline rows are omitted from both the dropdown and the empty-state list. An unauthorized handset stays on the empty-state warn arm (`真机未授权调试` + `重新检测`) and never appears in the dropdown.

`POST /phone/session` sends `{ deviceId, format: 'avc' }`. The live phase loads the signed `h264` URL through [the WebCodecs canvas playback module](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.md). The devbar renders one H264 chip (`当前画面编码 H264 · 30 fps`); the MJPEG chip is gone. Host still signs both capture URLs; the client no longer requests MJPEG.

## Alternatives considered

**Keep per-device tabs and add a "replace current" option.** Rejected: the acceptance pass reversed axis 1 outright — one tab, in-place occupation.

**Hide only the dropdown and keep offline rows in the empty state.** Rejected: the same "do not show unavailable devices" rule applies to the list; the unauthorized warn arm is the named exception.

**Keep requesting MJPEG until an MSE/WebCodecs decoder lands.** Rejected: the live view requests H264 (`avc`) only, and the client decodes its raw Annex-B access units through WebCodecs without introducing a second format.

## Consequences

Multi-device monitoring no longer means parallel tabs: switching replaces the occupying device and its stream. Layout restore of a `phone:<serial>` id is gone; a restored tab is the singleton `phone` id with device meta. The empty-state list no longer shows 离线 / 已停止 rows. The H264 chip is the live format caption, not a disabled future arm. [The connected-tabs note](2026-08-28-ui-phone-connected-device-tabs.md) keeps the controller, gateway, and error-arm decisions and records this reversal of the tab model and capture format; [the H264 playback note](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.md) owns client decode and canvas resource lifetime.
