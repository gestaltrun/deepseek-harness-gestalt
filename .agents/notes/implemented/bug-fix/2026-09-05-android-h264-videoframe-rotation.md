# Agent Note: Honor H264 VideoFrame rotation and Host logical display

Status: implemented

English | [中文](2026-09-05-android-h264-videoframe-rotation.zh.md)

## Problem

Rotating an Android handset (issue #551: MI 8, H264) left the rounded frame portrait. Landscape Clash UI sat letterboxed inside that box, and taps relative to the full portrait box — including the black bars — missed landscape logical pixels (2248×1080).

`phone-h264-playback` `paint()` used `VideoFrame.displayWidth`/`displayHeight` only and `drawImage` without `VideoFrame.rotation`. Android `screenrecord` encodes at the physical portrait size (1080×2248) regardless of rotation. Live MI 8 `dumpsys display` reported `mCurrentOrientation=1` and `logicalFrame=Rect(0, 0 - 2248, 1080)` while `device.info.screenSize` stayed `{width:1080, height:2248}`. WebCodecs on this path commonly leaves `VideoFrame.rotation` at 0.

## Decision

`paint()` reads `VideoFrame.rotation` as clockwise degrees 0/90/180/270 (missing or other values are 0). 90/270 swap canvas and `onSurface` size; the draw uses `translate`+`rotate` so coded pixels fill the post-rotation canvas. Taps already map through `surfaceSize()`.

Because Android screenrecord often ships `rotation=0` with portrait coded size, Host `phone-runtime` reads `adb dumpsys display` `logicalFrame` (never sticky `device.info.screenSize`) onto online Android listing rows as optional `logicalDisplay`. `GET /phone/devices` forwards that field. `PhoneConnectedView` forwards that field from `listing.android` only to `PhoneConnectionController.noteLogicalDisplay`. A later numeric width/height change remints through `refresh` only while live H264. Live MJPEG (preferred encoding or H264 fallback) records the size and keeps the same capture. Connecting records the latest observed size against a mint-bound snapshot and remints once that mint opens live H264 if they differ. Box mapping and tap/swipe `x`/`y` plus `source.captureWidth`/`captureHeight` follow the decoded H264 display size of the current capture. Host maps Android capture-source coordinates onto current `logicalDisplay`; Android without that field (dumpsys miss) blocks tap/swipe. iOS listing rows do not require `logicalDisplay`. A still-portrait decode is not stretched to a landscape listing. Landscape logical size also restarts system `screenrecord --size WxH` so a reminted capture can match the logical frame. Initial-landscape native-fallback decode size remains open: remint does not fill letterbox pixels without a landscape decode.

## Alternatives considered

**Treat this as another MJPEG `createImageBitmap` fix.** Rejected: iOS MJPEG `#549` is a sticky `naturalWidth` bug; this path is H264 canvas with portrait coded size.

**Trust `device.info.screenSize`.** Rejected: live MI 8 keeps physical portrait after rotation.

**Remap pointer coordinates through the letterboxed region inside the portrait box.** Rejected: the display area must become width greater than height.

**Swap only the box and tap space from listing `logicalDisplay` without reminting.** Rejected: Host Android capture is one-shot; a still-live portrait H264 URL does not become landscape pixels.

**Crop or rotate the existing canvas to the new logical size.** Rejected: this change replaces the signed capture through `refresh`; it does not invent a decode-side transform.

**Remint live MJPEG when listing size changes.** Rejected: that would undo an H264→MJPEG fallback and restart a capture that already follows JPEG frames.

## Consequences

H264 90/270 metadata flips the box without Host help. Android screenrecord with `rotation=0` remints the signed H264 capture when listing `logicalDisplay` width/height change. Live MJPEG and iOS listing rows do not remint. Swapping a still-portrait decoded frame is not a substitute for that remint. A dumpsys miss leaves `logicalDisplay` absent and keeps the decoded size. Initial-landscape native-fallback letterbox remains.

## Testing

`phone-h264-playback.client.spec.ts` paints FakeVideoFrame rotation 90/270/180/0 (and treats 45 as 0) at post-rotation canvas and `onSurface` size. `phone-connection.client.spec.ts` seeds the first `logicalDisplay`, remints live H264 on a numeric change, ignores identical polls and live MJPEG, remints once after a connecting change, and drops a stale landscape mint when listing returns to portrait. `phone-connected-view.client.spec.tsx` replaces the live H264 URL on Android listing portrait→landscape, keeps mint count on unchanged polls, hidden tabs, live MJPEG, H264→MJPEG fallback, and iOS listing landscape, and asserts reminted `emitFrame` canvas size. `android-display.spec.ts` parses the live MI 8 `logicalFrame`. `android-h264-process.spec.ts` and `service.spec.ts` pass `--size` from dumpsys or the listed logical display.

## Related

The frame box, `--phone-surface-ratio`, and `object-fit: contain` remain [the measured-surface decision](2026-09-03-phone-frame-follows-measured-surface.md). WebCodecs playback ownership remains [the H264 WebCodecs note](2026-08-30-ui-phone-h264-webcodecs-playback.md). Android capture-source scaling onto `logicalDisplay` is [the capture-to-logical decision](2026-09-05-android-capture-logical-input.md).
