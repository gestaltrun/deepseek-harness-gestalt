# Agent Note: ui-phone single-tab in-place switching, online-only lists, H264-first capture

Status: implemented

English | [中文](2026-08-29-ui-phone-single-tab-h264.zh.md)

## Problem

Issue #417's later user-acceptance pass reversed three client decisions that [the connected-tabs note](2026-08-28-ui-phone-connected-device-tabs.md) had locked: opening a second device minted a second tab, the switcher listed offline and unauthorized rows, and the live view requested MJPEG while an H264 chip sat disabled. The product now wants one 「手机」 tab that switches in place, a switcher of only online devices, and H264-preferred capture with same-session MJPEG recovery when H264 cannot paint a frame.

## Decision

The `phone` descriptor is `single: true`. `打开` and the device dropdown call `updateTab` on the occupying tab so its `meta` becomes `{ kind: 'device', serial, name }` and its title becomes `手机·<name>`. There is no `phone:<serial>` mint, no serial `dedupeKey`, and no `createTab` path. A serial change on `PhoneConnectedView` disposes the previous `PhoneConnectionController` and mints a session for the new device. A disabled `ui-phone.enabled` gate still drops the switch.

The switcher lists only `online` devices. Offline rows are omitted from both the dropdown and the empty-state list. An unauthorized handset stays on the empty-state warn arm (`真机未授权调试` + `重新检测`) and never appears in the dropdown.

The Phone Devices inventory gives each online row one `打开面板` action. A browser renderer opens the singleton Phone tab directly. Desktop Settings runs in an isolated overlay renderer, so it sends the bounded selection through the existing overlay reply protocol; the Session Surface reads a selection-local authoritative Host listing, waits for its durable settings gate to settle, revalidates that the device is online, then opens the singleton tab and reveals the panel. A later selection or renderer disposal cancels the older request and gate wait without letting that request overwrite the shared inventory.

`POST /phone/session` sends `{ deviceId, format: 'avc' }`. The live phase loads the signed `h264` URL through [the WebCodecs canvas playback module](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.md), then switches to the same session's signed MJPEG URL if H264 cannot paint a frame. The devbar renders the actual encoding; H264 retains the `30 fps` design caption.

## Alternatives considered

**Keep per-device tabs and add a "replace current" option.** Rejected: the acceptance pass reversed axis 1 outright — one tab, in-place occupation.

**Hide only the dropdown and keep offline rows in the empty state.** Rejected: the same "do not show unavailable devices" rule applies to the list; the unauthorized warn arm is the named exception.

**Keep requesting MJPEG as the primary format.** Rejected: the live view prefers H264 (`avc`) and decodes its raw Annex-B access units through WebCodecs; MJPEG is the recovery path when that renderer cannot paint a frame.

## Consequences

Multi-device monitoring no longer means parallel tabs: switching replaces the occupying device and its stream. Layout restore of a `phone:<serial>` id is gone; a restored tab is the singleton `phone` id with device meta. The empty-state list no longer shows 离线 / 已停止 rows. The format chip names the active H264 or MJPEG renderer. Settings and the in-tab picker converge on the same singleton tab without trusting a stale overlay listing. [The connected-tabs note](2026-08-28-ui-phone-connected-device-tabs.md) keeps the controller, gateway, and error-arm decisions and records this reversal of the tab model and capture format; [the H264 playback note](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.md) owns client decode and canvas resource lifetime.
