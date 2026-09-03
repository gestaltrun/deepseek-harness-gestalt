# Agent Note: MJPEG surface size is the currently painted JPEG

Status: implemented

English | [中文](2026-09-04-mjpeg-current-frame-size.zh.md)

## Problem

After the frame box started following the measured surface ([issue #547](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/547)), rotating an iOS Simulator to landscape still left the rounded frame portrait. The landscape UI sat letterboxed (`object-fit: contain`) inside the locked 1:2 box, and taps or drags relative to that full portrait box — including the black bars — missed device pixels ([issue #549](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/549)).

iOS capture uses an MJPEG `<img>`. Chromium and Electron keep `naturalWidth`/`naturalHeight` at the first `multipart/x-mixed-replace` JPEG even when later JPEGs flip orientation and still paint. The 500 ms poll that read those properties was a no-op, so `--phone-surface-ratio` stayed at the `0.5` placeholder. The H264 canvas path is unaffected: decoded display size writes `canvas.width`/`canvas.height`.

## Decision

`measureMjpegCurrentFrame` calls `createImageBitmap` on the live MJPEG `<img>` and returns that bitmap's device-pixel size after `close()`. Missing `createImageBitmap`, a throw (no JPEG yet, or a tainted source), and non-positive or non-finite dimensions return `undefined`; the existing 500 ms live poll retries. `PhoneConnectedView.applyMjpegSurface` bumps a generation token so an in-flight measurement after a newer one starts, or after MJPEG leaves live, cannot call `noteSurface`. `onLoad` and the poll both use this helper; they never read `naturalWidth`/`naturalHeight`.

The frame box still follows `surfaceSize()` as owned by [the measured-surface note](2026-09-03-phone-frame-follows-measured-surface.md). A landscape JPEG sets `--phone-surface-ratio` greater than 1, so the box itself becomes width greater than height and `object-fit: contain` has no letterbox.

## Alternatives considered

**Keep polling `naturalWidth`/`naturalHeight`.** Rejected: Chromium freezes those properties on the first multipart JPEG; later landscape frames paint without flipping them.

**Remap pointer coordinates through the letterboxed image region inside the portrait box.** Rejected: the display area must become width greater than height; mapping around black bars still leaves portrait chrome and shrinks the picture.

**Decode JPEG SOF from the multipart bytes.** Rejected: `createImageBitmap` already reports the painted bitmap; a SOF parser would duplicate the browser decoder and still need a poll or byte observer.

**Draw the `<img>` to a throwaway canvas and read `canvas.width`/`height`.** Rejected: canvas size is whatever the caller sets; drawing does not reveal the source JPEG size. `createImageBitmap` returns the bitmap dimensions directly.

## Consequences

Live MJPEG rotation flips the box without a new load event. A failed or empty measurement leaves the last learned surface, or the 1:2 placeholder, until the next cadence. Each poll pays one `createImageBitmap` of the live multipart `<img>`.

## Testing

`measure-mjpeg-current-frame.client.spec.ts` returns the current bitmap size while `naturalWidth` stays at the first JPEG, and returns `undefined` (still closing a created bitmap) when `createImageBitmap` is missing, throws, or yields empty or non-finite dimensions. `phone-connected-view.client.spec.tsx` keeps `naturalWidth` portrait, drives landscape then portrait through the current-frame stub, requires `--phone-surface-ratio` greater than 1 then less than 1, and maps a tap through the landscape surface.

## Related

The frame box, `--phone-surface-ratio`, and `object-fit: contain` remain [the measured-surface decision](2026-09-03-phone-frame-follows-measured-surface.md). This note owns only how an MJPEG `<img>` is measured.
