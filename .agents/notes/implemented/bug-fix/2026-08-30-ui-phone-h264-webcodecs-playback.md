# Agent Note: Decode ui-phone H264 streams with WebCodecs

Status: implemented

English | [中文](2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)

## Problem

The `phone-stream` Host route returns a raw Annex-B H264 elementary stream. Passing its signed URL to `<img>` produces no decoded picture in Chromium: the transport can answer HTTP 200 with `video/h264` and valid bytes while the element remains 0×0 and drives the connected view into its interrupted arm. The client needs a visible frame before its existing normalized pointer coordinates can map onto device pixels.

## Decision

`PhoneH264Surface` is the React ownership adapter inside `PhoneConnectedView`. Its interface is the signed URL, canvas styling and accessible name, decoded-surface callback, and failure callback. Mount and URL lifetime own one `playPhoneH264Stream` handle; cleanup closes that handle before another device, session, or visibility state can paint.

`playPhoneH264Stream` owns the browser playback implementation behind one `close()` operation. It fetches the signed same-origin URL, requires a successful `video/h264` response, incrementally finds three- and four-byte Annex-B start codes, groups VCL slices by `first_mb_in_slice`, derives the fully qualified AVC codec string from the SPS, and feeds one primary coded picture per `EncodedVideoChunk` into `VideoDecoder`. Decoder queue pressure flushes before more network input is admitted. Every output `VideoFrame` is drawn to the canvas and closed in the same callback; its display width and height update the canvas and `PhoneConnectionController` touch surface.

The handle owns `AbortController`, response reader, decoder, output frames, and failure delivery. Device switches, refresh, inactive tabs, reconnects, and unmount close fetch and decode work; stale callbacks close their frame without painting. Fetch, parse, support, decoder, and canvas failures report once through `noteCaptureFailure()` and enter the existing bounded reconnect policy. A finite response that paints at least one frame keeps the last canvas picture and releases the decoder; an empty response is a playback failure.

## Verification

The package tests cover network-chunk splits, three- and four-byte start codes, multi-slice access units, SPS-derived codec input, key and delta chunks, decoder backpressure, unsupported and malformed inputs, dimension changes, exact 390×844 touch mapping, cancellation races, decoder failures, stale callbacks, and frame closure. A loopback Electron 41.2.1 probe decodes the 1,534,614-byte fakemobilecli Annex-B fixture into three 390×844 `VideoFrame`s and paints a 390×844 canvas.

## Alternatives considered

**Return to MJPEG.** Rejected: the accepted product format is H264-only, and a fallback would make the visible chip and transport behavior disagree.

**Remux into MSE or add a codec dependency.** Rejected: the Desktop Host's loopback Chromium supports the fixture's AVC profile through WebCodecs, the stream has no audio or container timeline to preserve, and platform playback deletes more owned remuxing code than a dependency would.

**Put parsing and decoder effects in `PhoneConnectedView`.** Rejected: React would then own fetch chunks, access-unit state, backpressure, frame release, and cancellation ordering. The playback module keeps that implementation local behind one handle while the view continues to mirror connection phases.

## Consequences

The connected view remains H264-only and adds no npm dependency. It requires a secure-context browser with WebCodecs AVC support; unsupported runtimes take the ordinary interrupted/reconnect arm instead of silently trying another format. The decoded display dimensions, rather than CSS or container dimensions, remain authoritative for device tap and gesture coordinates.
