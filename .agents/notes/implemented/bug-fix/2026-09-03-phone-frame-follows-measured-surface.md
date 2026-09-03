# Agent Note: Phone frame box follows the measured surface aspect

Status: implemented

English | [中文](2026-09-03-phone-frame-follows-measured-surface.zh.md)

## Problem

Rotating a device (issue #547: iOS simulator to landscape) stretched the live frame unreadably. `PhoneConnectedView.module.css` locked `.screenFrame` to portrait 1:2 (`width: min(100cqw, 50cqh)`) and `.stream` used `object-fit: fill`, so any frame aspect was distorted into the box. `PhoneConnectionController.noteSurface` already learned real frame dimensions (H264 decoded display size, MJPEG current JPEG) for touch mapping, but the frame box never consumed them.

## Decision

The frame box aspect follows the measured surface. The controller publishes `surfaceSize()` and `noteSurface` notifies subscribers only when the size actually changes, so the view can read the surface through `useSyncExternalStore`. The view sets the inline `--phone-surface-ratio` custom property (width/height); `.screenFrame` derives both axes from the area's container units as the largest exact-ratio rectangle the area fits (`min(100cqw, 100cqh * ratio)` × `min(100cqh, 100cqw / ratio)`), with the `0.5` fallback holding the locked 1:2 placeholder until the first measurement. `.stream` uses `object-fit: contain`, never `fill`. H264 playback's `onSurface` already fires on dimension change; an MJPEG image is re-measured on a 500 ms cadence while live because later multipart JPEGs replace the painted picture without a new load event. Chromium keeps `naturalWidth`/`naturalHeight` at the first JPEG, so the poll reads `createImageBitmap` of the live `<img>` ([current-frame measure](2026-09-04-mjpeg-current-frame-size.md)).

## Alternatives considered

**`object-fit: contain` inside the fixed 1:2 box.** Rejected: the landscape picture would stay letterboxed inside a portrait frame, wasting the panel and shrinking the picture; the issue requires the box itself to follow the surface.

**ResizeObserver on the image instead of polling.** Rejected: ResizeObserver reports the layout box, which CSS drives; it never observes the painted JPEG size, so an orientation flip produces no signal.

**Carry frame dimensions in the stream session or io channel.** Rejected: the stream contract has no size field, and the capture element is already the authoritative measurement both renderers consume for touch mapping.

## Consequences

Device rotation flips the box live between portrait and landscape without distorting pixels, and taps stay aligned because pointer normalization measures the frame box while `devicePointOf` consumes the same measured surface. A live MJPEG stream pays one 500 ms interval that no-ops on unchanged dimensions; a repeated identical measurement never re-renders the view.

## Testing

`phone-connected-view.client.spec.tsx` requires the box ratio to follow the decoded H264 surface and flip live when the fake decoder emits a rotated frame, to hold the placeholder until the first MJPEG measurement, and to flip the MJPEG box from the current JPEG while `naturalWidth` stays portrait — each arm asserting the tap maps to coordinates in the current orientation. `phone-connection.client.spec.tsx` pins `surfaceSize()` publication, notify-only-on-change, and landscape tap mapping. `connected-view-styles.client.spec.ts` pins the ratio-var sizing with the 0.5 fallback and `object-fit: contain`.

## Related

How an MJPEG `<img>` is measured is owned by [the current-frame note](2026-09-04-mjpeg-current-frame-size.md).
