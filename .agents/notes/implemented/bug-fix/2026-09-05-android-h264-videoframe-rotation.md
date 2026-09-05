# Agent Note: Honor H264 VideoFrame rotation and Host logical display

Status: implemented

English | [中文](2026-09-05-android-h264-videoframe-rotation.zh.md)

## Problem

Rotating an Android handset (issue #551: MI 8, H264) left the rounded frame portrait. Landscape Clash UI sat letterboxed inside that box, and taps relative to the full portrait box — including the black bars — missed landscape logical pixels (2248×1080).

`phone-h264-playback` `paint()` used `VideoFrame.displayWidth`/`displayHeight` only and `drawImage` without `VideoFrame.rotation`. Android `screenrecord` encodes at the physical portrait size (1080×2248) regardless of rotation. Live MI 8 `dumpsys display` reported `mCurrentOrientation=1` and `logicalFrame=Rect(0, 0 - 2248, 1080)` while `device.info.screenSize` stayed `{width:1080, height:2248}`. WebCodecs on this path commonly leaves `VideoFrame.rotation` at 0.

## Decision

`paint()` reads `VideoFrame.rotation` as clockwise degrees 0/90/180/270 (missing or other values are 0). 90/270 swap canvas and `onSurface` size; the draw uses `translate`+`rotate` so coded pixels fill the post-rotation canvas. Taps already map through `surfaceSize()`.

Because Android screenrecord often ships `rotation=0` with portrait coded size, Host `phone-runtime` reads `adb dumpsys display` `logicalFrame` (never sticky `device.info.screenSize`) onto online Android listing rows as optional `logicalDisplay`. `GET /phone/devices` forwards that field. When Host is landscape and the H264 surface is still portrait, `h264SurfaceForHost` swaps the box and tap space. Landscape logical size also restarts system `screenrecord --size WxH` so capture pixels can match the logical frame.

## Alternatives considered

**Treat this as another MJPEG `createImageBitmap` fix.** Rejected: iOS MJPEG `#549` is a sticky `naturalWidth` bug; this path is H264 canvas with portrait coded size.

**Trust `device.info.screenSize`.** Rejected: live MI 8 keeps physical portrait after rotation.

**Remap pointer coordinates through the letterboxed region inside the portrait box.** Rejected: the display area must become width greater than height.

## Consequences

H264 90/270 metadata flips the box without Host help. Android screenrecord with `rotation=0` still flips when listing `logicalDisplay` is landscape, and system capture can be resized to that frame. A dumpsys miss leaves `logicalDisplay` absent and keeps the decoded size.

## Testing

`phone-h264-playback.client.spec.ts` paints FakeVideoFrame rotation 90/270/180/0 (and treats 45 as 0) at post-rotation canvas and `onSurface` size. `phone-connection.client.spec.ts` and `phone-connected-view.client.spec.tsx` swap a portrait coded frame when Host `logicalDisplay` is 2248×1080 and map a tap through that landscape surface. `android-display.spec.ts` parses the live MI 8 `logicalFrame`. `android-h264-process.spec.ts` and `service.spec.ts` pass `--size` from dumpsys or the listed logical display.

## Related

The frame box, `--phone-surface-ratio`, and `object-fit: contain` remain [the measured-surface decision](2026-09-03-phone-frame-follows-measured-surface.md). WebCodecs playback ownership remains [the H264 WebCodecs note](2026-08-30-ui-phone-h264-webcodecs-playback.md). Android capture-source scaling onto `logicalDisplay` is [the capture-to-logical decision](2026-09-05-android-capture-logical-input.md).
