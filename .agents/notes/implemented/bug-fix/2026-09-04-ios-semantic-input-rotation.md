# Agent Note: Phone semantic input follows exact capture rotation

Status: implemented

English | [中文](2026-09-04-ios-semantic-input-rotation.zh.md)

## Problem

DeviceKit applies an incorrect landscape transform to `device.io.tap` and its arbitrary WDA action-list path after iOS already reports swapped physical dimensions. A live picture can remain correct while an accepted action misses the displayed control. Earlier swipe experiments also returned success without scrolling and could trigger Speak Selection after pause-after-down, so RPC success, WebSocket send, and fake counters do not prove device input.

`device.info.screenSize` remains portrait logical size. Landscape Left and Landscape Right share dimensions, while left, center, and right visible points require different transforms; aspect, overflow, or one fixed offset therefore cannot identify exact direction. Android `logicalDisplay` is Android-only evidence and is not an iOS rotation source.

## Decision

`PhoneDevices.io()` owns the closed tap, swipe, text, and button actions and their platform conversion. Capture-source `x`/`y` and `captureWidth`/`captureHeight` remain the decoded plane. Android capture-source taps and swipes scale both axes onto the current incarnation `logicalDisplay`; missing or incompatible aspect fails with `PHONE_PROTOCOL` before RPC. Android fresh-probe pixels pass through. Every iOS coordinate endpoint is scaled from the current displayed screenshot plane into portrait logical bounds and inverse-transformed through exact `0 | 90 | 180 | 270` rotation. Rotation-0 taps use `device.io.tap`; rotated taps use a zero-distance `device.io.swipe`; every semantic swipe uses `device.io.swipe` with transformed endpoints and the upstream default duration.

Browser coordinate actions carry the unique active capture identity, format, displayed dimensions, and exact H264 `VideoFrame.rotation` when applicable. Host accepts that evidence only while the exact signed capture pipe is active. MJPEG rotation comes from a bounded structural JPEG observer keyed to that capture. Model-only actions omit capture identity, derive the displayed `device_screenshot` extent from portrait logical size and scale, and use a fresh generation-owned MJPEG probe. Runtime replacement, device removal, capture closure, and disposal revoke observations and drain probes.

The public browser and Service request use semantic `swipe { x1, y1, x2, y2 }`; arbitrary WDA action lists and `gesture` wire input are absent. GUI drag uses press origin and release as endpoints. Wheel bursts coalesce into the same semantic endpoints, and hiding, cancellation, device replacement, or renderer replacement drops incomplete input. Ordinary action errors remain visible while a healthy picture stays live; newer request results are monotonic over stale replies.

## Alternatives considered

**Keep the WDA action list or move coordinates onto pointer-down.** The action list was introduced to model press, movement, pause, and release, but DeviceKit applies the broken orientation conversion to that path. Moving coordinates to pointer-down did not establish scrolling, and pause-after-down could invoke Speak Selection.

**Treat a successful send, RPC result, or fake counter as acceptance.** These observations prove transport only. Acceptance requires a fresh UI-state or scroll-state change from the real production path while the capture stays usable.

**Compensate with a fixed landscape offset or overflow.** The required correction changes by side and point; opposite rotations can require invalid coordinates. Left, center, and right point evidence rejects one overflow rule.

**Infer rotation from aspect or refresh `device.info` for every action.** Both landscape rotations share dimensions, and `device.info.screenSize` stays portrait. Re-reading it adds work without exact direction.

**Use Android `logicalDisplay` as an iOS rotation source or let phone-stream own projection.** `logicalDisplay` is Android-specific and is the Android capture-to-logical scale target, not an iOS rotation source. Semantic platform conversion belongs to the phone fleet Service; phone-stream authenticates current capture evidence and forwards bytes without interpreting user coordinates. The Android conversion is [the capture-to-logical decision](2026-09-05-android-capture-logical-input.md).

**Retain arbitrary gestures for advanced callers.** No current consumer needs them, and retaining the broken platform-specific program would create a second input contract. Reintroduction requires a demonstrated semantic action that cannot be expressed as tap, swipe, text, or button plus real UI-state verification on every supported platform.

## Consequences

GUI drag, wheel, and `device_act` share one semantic swipe path. Open MJPEG captures update direction when EXIF changes without reconnecting, and stale captures cannot publish or erase another capture's observation. Model-only coordinate actions pay a bounded fresh probe. The implementation gives up arbitrary WDA programs and aspect-only fallback in exchange for one testable coordinate contract.

Verification covers exact transforms, full-resolution and scaled screenshots, malformed screen information, capture identity isolation, structural JPEG framing, probe cancellation and freshness, bounded stale-after-headers capture cancellation, H264 same-size direction changes, action reply ordering including send-before-publication rollback, semantic GUI input, exact mobilecli RPC methods and parameters, and rejection of the removed gesture wire format. Product acceptance remains a headless real UIKit UI-state change rather than RPC/send/fake-counter success; Issue #567 owns that lane.
