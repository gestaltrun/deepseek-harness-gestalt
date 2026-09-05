# Agent Note: Android capture input scales onto current logical display

Status: implemented

English | [中文](2026-09-05-android-capture-logical-input.zh.md)

## Problem

A landscape Android H264 stream can decode at 1124×540 while `dumpsys display` `logicalFrame` is 2248×1080. Capture-source `x`/`y` remain decoded pixels, and `PhoneDevices.io()` previously forwarded Android coordinates unchanged. A decoded-center tap at 562,270 therefore missed the logical center at 1124,540. Portrait-coded frames against a landscape logical display have no proven content mapping.

## Decision

`PhoneDevices.io()` / `upstreamIo()` own Android capture-to-logical conversion. Capture-source `x`/`y` and `captureWidth`/`captureHeight` stay on the decoded plane. Both tap and swipe axes scale onto the current incarnation `logicalDisplay`. Missing logical bounds, or a capture plane that fails the uniform full-frame aspect assumption, fail with `PHONE_PROTOCOL` before RPC. Same aspect assumes a uniformly scaled full frame: each reconstructed logical axis, rounded to an integer pixel, must land within 1 logical pixel of the known display. That bound is integer reconstruction, not a ratio epsilon, and is not evidence of bar-free pixels; crop and rotation are never inferred. Accepted encoder sizes against 2248×1080 include 1124×540 and even-coded 1078×518. A 400×192 plane reconstructs more than 1 logical pixel off and is refused; the 1-pixel bound is not widened. Android fresh-probe pixels pass through. Button and text stay independent. iOS exact-rotation projection is unchanged. Capture grant, generation, and incarnation fences still run before RPC. Last-known logical size is incarnation identity, separate from current mapping availability. A dumpsys miss omits listing `logicalDisplay` so capture-source io fails closed without RPC. A missing last-known operand against a later known size may keep an active grant; current bounds and aspect still validate at io. A→miss→B revokes through the retained known size; a new capture on B maps. Mixed undefined/known operands are not claimed impossible.

## Alternatives considered

**Let the browser pre-scale into logical pixels.** Rejected: capture-source fields would then lie about the decoded plane, and Host could not refuse an unproven portrait-coded mapping.

**Guess crop or 90/270 rotation from aspect.** Rejected: same aspect is only a uniform full-frame scale. Letterboxed portrait content in a landscape box is not a mapped coordinate plane.

**Keep Android pass-through because `screenrecord --size` should match.** Rejected: decoded size can still be a uniform downsample of the logical frame, as in 1124×540 versus 2248×1080.

## Consequences

Runtime, not the controller, owns Android capture scaling. Callers keep true decoded extents. Coordinate io refuses a missing or incompatible logical display instead of sending a silent miss. Product frame-fill and capture remint remain separate.

## Testing

`io.spec.ts` maps decoded 1124×540 center 562,270 and swipe endpoints onto 2248×1080, accepts even-coded 1078×518 and 1082×520 reconstructed-axis rounding, and refuses 1084×520, 400×192, portrait mismatch, and missing logical display, while fresh-probe and button stay unscaled. `service.spec.ts` drives `PhoneDevices.io()` for the same scale, no-RPC mismatch, missing logical display, stale capture after a known-size incarnation change, and one parameterized A→miss→A / A→miss→B sequence (fail-closed while missing, restore or revoke by last-known size, new capture on B). Those service tests import `PhoneDevices` from `../src/index.ts` and mock `../src/android-h264-process.ts` so landscape capture never launches host `adb`.

## Related

Platform conversion ownership remains [the semantic input note](2026-09-04-ios-semantic-input-rotation.md). Host `logicalDisplay` publication remains [the H264 rotation note](2026-09-05-android-h264-videoframe-rotation.md).
