# Agent Note: Encode phone swipes as WDA press-hold gestures

Status: implemented

English | [中文](2026-09-02-phone-ios-wda-swipe-gesture.zh.md)

## Problem

A live iOS Simulator accepted `device.io.gesture` from the Phone tab while the on-device UI did not scroll. macOS native drag reproduced the same outcome: pointer and wheel events reached the renderer, coordinates reached mobilecli, and one path activated Speak Selection instead of a sustained swipe. Sending coordinates on `pointerDown` and omitting a press-hold pause is not the action list mobilecli's iOS converter consumes.

## Decision

GUI drag, trackpad wheel, and `device_act` swipe share `phoneSwipeActions`. The list is positioning `pointerMove`, `pointerDown` without coordinates, a 500 ms `pause`, destination `pointerMove`, a 200 ms `pause`, and `pointerUp`. That matches mobilecli's published custom-gesture example and the devicekit converter: a pre-press `pointerMove` stores the contact point, a post-press `pointerMove` is the drag, and `pause` extends the previous action's duration. Intermediate sampled trail points are not forwarded; origin and release bound the swipe. Wheel bursts coalesce for 50 ms, then emit the same vertical swipe.

## Alternatives considered

**Keep `pointerDown` coordinates plus 16 ms pauses between every sampled point.** Rejected: devicekit treats a coordinated `pointerDown` as a press at that point without a prior positioning move, and 16 ms does not produce a sustained iOS drag.

**Call upstream `device.io.swipe` instead of `device.io.gesture`.** Rejected: the Host io vocabulary already exposes `gesture` to GUI and tools; adding a second verb would split encoding without changing the iOS converter path.

**Treat a successful WebSocket send as scrolling.** Rejected: user acceptance requires the on-device UI position to change.

## Consequences

Android and iOS consume the same WDA-shaped list. A swipe now pays 700 ms of encoded pause before release. Wheel input is a vertical two-point swipe, not a pixel-accurate path. Tests pin the encoded action list; fixture evidence is not user acceptance.
