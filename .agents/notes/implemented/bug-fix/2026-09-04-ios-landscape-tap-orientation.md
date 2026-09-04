# Agent Note: iOS landscape taps follow the live capture surface

Status: implemented

English | [中文](2026-09-04-ios-landscape-tap-orientation.zh.md)

## Problem

[#563](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/563) stopped tearing down a real-iPhone picture after a landscape tap JSON-RPC error ([session-keep](2026-09-04-ios-real-tap-keeps-session.md)). Host `ioParams` still swapped sticky portrait `device.info.screenSize` (`440×956` scale 3) only when one scaled point overflowed portrait width. A landscape H264 surface is about `2868×1320`. Left and center taps have `x/3 ≤ 440`, so they stayed portrait points (`99,660` → `33,220`). WDA in landscape wants `956×440`. Those taps miss; the session stays live.

## Decision

Orientation comes from the live capture surface, not overflow of one point. Browser tap and gesture frames send optional `captureWidth`/`captureHeight` from `PhoneConnectionController.surfaceSize()`. Host `ioParams` swaps sticky portrait logical bounds whenever that surface is landscape (`captureWidth` greater than `captureHeight`) and `screen.width` is less than `screen.height`, then divides by scale and clamps. Portrait capture (`1320×2868`) stays on `440×956`. Omitted size keeps the overflow heuristic for non-browser callers; the browser always sends size.

## Alternatives considered

**Keep overflow of one scaled point as the only orientation source.** Rejected: left-side landscape taps never overflow portrait width and stay in the wrong WDA space.

**Refresh `device.info` on every tap.** Rejected: live `screenSize` stays portrait on this handset; extra RPCs do not change the sticky bounds.

**Treat Host `logicalDisplay` as the iOS mapping source.** Rejected: that field is Android `dumpsys display` only.

## Consequences

A landscape capture tap at any x, including the left half, maps into swapped `956×440`. A portrait capture keeps `440×956`. Tool and other non-browser callers without capture size still swap only when a point overflows.

## Testing

`io.spec.ts` maps 贝贝猫 landscape `2868×1320` taps, including `99,660` and a y that clamps only in `956×440`, onto swapped bounds; portrait `1320×2868` stays unswapped; omitted size keeps overflow. `service.spec.ts` forwards a left landscape tap through Host `io()`. `phone-stream-client.client.spec.ts` encodes capture size; `phone-connection.client.spec.ts` and `phone-connected-view.client.spec.tsx` send it from the live surface; `phone-stream` `routes.spec.ts` parses it onto Host `io()`.

## Related

Session survival on a tap JSON-RPC error remains [the session-keep note](2026-09-04-ios-real-tap-keeps-session.md). Android H264 box swap remains [the VideoFrame rotation note](2026-09-05-android-h264-videoframe-rotation.md).
