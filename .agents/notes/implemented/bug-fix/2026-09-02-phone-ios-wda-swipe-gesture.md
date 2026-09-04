# Agent Note: Encode phone swipes as WDA destination-move gestures

Status: implemented

English | [中文](2026-09-02-phone-ios-wda-swipe-gesture.zh.md)

## Problem

A live iOS Simulator accepted `device.io.gesture` from the Phone tab while the on-device UI did not scroll. macOS native drag reproduced the same outcome: pointer and wheel events reached the renderer, coordinates reached mobilecli, and one path activated Speak Selection instead of a sustained swipe. Sending coordinates on `pointerDown`, or pausing after `pointerDown` before the destination move, is not the action list mobilecli's iOS converter consumes as a drag.

## Decision

GUI drag, trackpad wheel, and `device_act` swipe share `phoneSwipeActions` from `@deepseek-ai/dsh-phone-runtime/swipe`. That subpath is browser-safe and inlined by the client bundle; the Host root re-exports the same function. The list is positioning `pointerMove`, `pointerDown` without coordinates, destination `pointerMove`, a 150 ms `pause`, and `pointerUp`. Pause after `pointerDown` extends press and becomes an iOS long-press / Speak Selection. devicekit attaches `pause` to the previous converted action, so travel duration belongs after the destination move. Intermediate sampled trail points are not forwarded; origin and release bound the swipe. Wheel bursts coalesce for 50 ms, then emit the same vertical swipe. Touch mapping stays on decoded H264 display size or the current MJPEG JPEG size, never CSS layout size.

## Alternatives considered

**Keep `pointerDown` coordinates plus 16 ms pauses between every sampled point.** Rejected: devicekit treats a coordinated `pointerDown` as a press at that point without a prior positioning move, and 16 ms does not produce a sustained iOS drag.

**Pause after `pointerDown`, then move.** Rejected: that pause extends press and becomes an iOS long-press rather than a drag.

**Call upstream `device.io.swipe` instead of `device.io.gesture`.** Rejected: the Host io vocabulary already exposes `gesture` to GUI and tools; adding a second verb would split encoding without changing the iOS converter path.

**Treat a successful WebSocket send as scrolling.** Rejected: user acceptance requires the on-device UI position to change. Fixture evidence records a scroll-offset delta for the destination-move list; a tap-shaped list or a pause-after-down long-press, including Speak Selection, leaves offset unchanged.

**Duplicate the WDA list in the GUI controller.** Rejected: two copies can drift; one encoder is the construction that keeps GUI, wheel, and `device_act` identical.

## Consequences

Android and iOS consume the same WDA-shaped list. A swipe now pays 150 ms of encoded travel pause after the destination move. Wheel input is a vertical two-point swipe, not a pixel-accurate path. Tests pin the encoded action list and a fixture scroll-offset change; fixture evidence is not user acceptance.
