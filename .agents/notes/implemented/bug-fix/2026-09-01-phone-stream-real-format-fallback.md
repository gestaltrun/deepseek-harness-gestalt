# Agent Note: Deduplicate phone devices and fall back to the real capture format

Status: implemented

English | [中文](2026-09-01-phone-stream-real-format-fallback.zh.md)

## Problem

mobilecli 1.0.5 can report one physical handset more than once and can accept an AVC capture request without producing an AVC picture. Direct diagnosis separated three failures. iOS Simulator rejects the request with `avc format is not supported on iOS simulators`. An Android real device returns HTTP 200 `video/h264` with `Error 0x80001001` from DeviceKit `AvcServer`; device logcat identifies the failing configuration as the Qualcomm AVC encoder rejecting input color format `0x7f000789`, while the same device's native `screenrecord --output-format=h264` emits valid Annex-B. An iOS real device can report its test runner installed while AVC ends with zero bytes because the DeviceKit main app is absent. The same devices produce MJPEG frames. Treating HTTP status or session minting as picture readiness left duplicate rows and a blank H264-only view.

## Decision

The phone runtime validates every `devices.list` row, then keeps the first row for each `(platform, id)` pair. Because every operation accepts only `deviceId`, one id reported for both platforms fails with `PHONE_PROTOCOL` instead of projecting indistinguishable targets. Same-platform duplicates cannot reach settings, the phone picker, the connected dropdown, or the online badge.

The Host marks H264 as the preferred format for Android devices and iOS real devices. It marks MJPEG as the preferred format for iOS Simulator because that mobilecli device class explicitly refuses AVC. `PhoneConnectionController` opens the preferred URL. Any attempted H264 fetch, protocol, parse, browser-support, decode, draw, or zero-frame failure clears the learned touch surface and switches the live phase to that same session's signed MJPEG URL without closing or replacing its io socket. The devbar names only the live phase's actual encoding; it does not present fallback diagnosis as the repair. The MJPEG element publishes `naturalWidth` and `naturalHeight` as the touch-coordinate surface; callbacks from the replaced H264 renderer cannot overwrite it. An MJPEG failure closes the current resources and enters the existing three-attempt bounded reconnect policy.

The connected surface captures the active pointer on press. It records every normalized move, includes the release when evaluating the drag threshold, sends the complete `pointerDown` / `pointerMove`... / `pointerUp` path, and releases capture on completion or cancellation. Hiding the tab, changing device/controller, or replacing the live stream also releases and drops the pending path. Cancellation and lifecycle replacement send no partial gesture.

## Verification

Package tests pin `(platform, id)` deduplication, first-row selection, cross-platform ambiguity rejection, device-class preferred formats, same-session fallback without another mint or socket, stale callback rejection, MJPEG natural-dimension touch mapping, complete captured drag paths, cancellation, and retry only after MJPEG failure. The built Desktop fixture covers duplicate listing input, an H264 HTTP 200 error body followed by visible 390×844 MJPEG, a separate successful 390×844 H264 device, exact touch and Home io, and complete process, port, and temporary-root teardown. Fixture evidence is automation only; user acceptance still requires visible live frames and control on the real Android handset, iOS handset, and iOS Simulator.

## Alternatives considered

**Attempt H264 on iOS Simulator before changing format.** Rejected: mobilecli explicitly refuses AVC for that device class, so the request cannot produce evidence and only delays the working stream.

**Choose MJPEG for every device up front.** Rejected: H264 remains the preferred efficient path where mobilecli produces valid AVC, and the built Desktop lane retains a successful H264 device.

**Deduplicate in each GUI consumer.** Rejected: settings, picker, badge, tools, and later consumers would each need the same repair and could disagree. The `devices.list` wire parser is the first owned point with both platform and id.

## Consequences

The visible encoding may be H264 or MJPEG within one connection session, and renderer code must derive format labels and touch dimensions from the current live phase. Android and iOS real devices retain H264-first behavior. iOS Simulator pays no known-failing AVC request. A valid H264 path pays no MJPEG request; an H264 failure pays one same-session MJPEG request before any reconnect, while a dual-format failure retains the existing bounded failure arm. This note supersedes the H264-only and no-fallback decisions in [the single-tab capture note](../feature/2026-08-29-ui-phone-single-tab-h264.md) and [the WebCodecs playback note](2026-08-30-ui-phone-h264-webcodecs-playback.md); their singleton-tab, online-only, parser, decoder, and resource-lifetime decisions remain current.
