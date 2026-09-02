# Agent Note: Deduplicate phone devices and fall back to the real capture format

Status: implemented

English | [中文](2026-09-01-phone-stream-real-format-fallback.zh.md)

## Problem

mobilecli 1.0.5 can report one physical handset more than once and can accept an AVC capture request without producing an AVC picture. Direct diagnosis separated three failures. iOS Simulator rejects the request with `avc format is not supported on iOS simulators`. An Android real device returns HTTP 200 `video/h264` with `Error 0x80001001` from DeviceKit `AvcServer`; device logcat identifies the failing configuration as the Qualcomm AVC encoder rejecting input color format `0x7f000789`, while the same device's native `screenrecord --output-format=h264` emits valid Annex-B. Its DeviceKit MJPEG path can also fail to create a virtual display. An iOS real device can report its test runner installed while AVC ends with zero bytes because the DeviceKit main app is absent. Treating HTTP status or session minting as picture readiness left duplicate rows and a blank H264-only view.

## Decision

The phone runtime validates every `devices.list` row, then keeps the first row for each `(platform, id)` pair. Because every operation accepts only `deviceId`, one id reported for both platforms fails with `PHONE_PROTOCOL` instead of projecting indistinguishable targets. Same-platform duplicates cannot reach settings, the phone picker, the connected dropdown, or the online badge.

The Host marks H264 as the preferred format for Android devices and iOS real devices. It marks MJPEG as the preferred format for iOS Simulator because that mobilecli device class explicitly refuses AVC. Before Android H264 reaches the renderer, the runtime recognizes a bounded SPS/PPS/IDR prefix. Invalid or probe-timed-out mobilecli AVC first switches to Android system `screenrecord --output-format=h264`; only failure of both H264 sources enters the renderer's same-session MJPEG policy. A live IDR is accepted once its slice header is complete, without waiting for motion to produce the next NAL delimiter. The devbar names only the live encoding and does not present fallback diagnosis. Android and iOS real sessions manage device-agent recovery; an Android io rejection checks agent status and exposes one-click installation, while OEM-required USB installation or debugging-security approval remains an on-device action.

The connected surface captures the active pointer on press. It records every normalized move, includes the release when evaluating the drag threshold, and encodes origin plus release as the WDA swipe mobilecli's iOS converter consumes: positioning `pointerMove`, `pointerDown`, 500 ms hold, destination `pointerMove`, 200 ms settle, `pointerUp`. A coalesced trackpad wheel burst sends the same swipe along the vertical axis. Capture is released on completion or cancellation. Hiding the tab, changing device/controller, or replacing the live stream also releases and drops the pending path. Cancellation and lifecycle replacement send no partial gesture.

## Verification

Package tests pin `(platform, id)` deduplication, first-row selection, cross-platform ambiguity rejection, device-class preferred formats, same-session fallback without another mint or socket, stale callback rejection, MJPEG natural-dimension touch mapping, WDA press-hold swipe encoding, coalesced wheel swipes, cancellation, and retry only after MJPEG failure. The built Desktop fixture covers duplicate listing input, an H264 HTTP 200 error body followed by visible 390×844 MJPEG, a separate successful 390×844 H264 device, exact touch and Home io, and complete process, port, and temporary-root teardown. Fixture evidence is automation only; user acceptance still requires visible live frames and control on the real Android handset, iOS handset, and iOS Simulator.

## Alternatives considered

**Attempt H264 on iOS Simulator before changing format.** Rejected: mobilecli explicitly refuses AVC for that device class, so the request cannot produce evidence and only delays the working stream.

**Choose MJPEG for every device up front.** Rejected: H264 remains the preferred efficient path where mobilecli produces valid AVC, and the built Desktop lane retains a successful H264 device.

**Deduplicate in each GUI consumer.** Rejected: settings, picker, badge, tools, and later consumers would each need the same repair and could disagree. The `devices.list` wire parser is the first owned point with both platform and id.

## Consequences

The visible encoding may be H264 or MJPEG within one connection session, and renderer code must derive format labels and touch dimensions from the current live phase. Android and iOS real devices retain H264-first behavior. iOS Simulator pays no known-failing AVC request. A valid H264 path pays no MJPEG request; an H264 failure pays one same-session MJPEG request before any reconnect, while a dual-format failure retains the existing bounded failure arm. This note supersedes the H264-only and no-fallback decisions in [the single-tab capture note](../feature/2026-08-29-ui-phone-single-tab-h264.md) and [the WebCodecs playback note](2026-08-30-ui-phone-h264-webcodecs-playback.md); their singleton-tab, online-only, parser, decoder, and resource-lifetime decisions remain current.
