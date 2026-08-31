# Agent Note: Deduplicate phone devices and fall back to the real capture format

Status: implemented

English | [中文](2026-09-01-phone-stream-real-format-fallback.zh.md)

## Problem

mobilecli 1.0.5 can report one physical handset more than once and can accept an AVC capture request without producing an AVC picture. Observed Android output returned HTTP 200 `video/h264` with an error body, observed iOS handset output ended with zero bytes, and iOS Simulator rejected AVC; the same three device classes produced MJPEG frames. Treating HTTP status or session minting as picture readiness left duplicate rows and a blank H264-only view.

## Decision

The phone runtime validates every `devices.list` row, then keeps the first row for each `(platform, id)` pair. This wire-level identity keeps equal ids on different platforms distinct while preventing one upstream duplicate from reaching settings, the phone picker, the connected dropdown, or the online badge.

`PhoneConnectionController` starts each minted session with H264. Any H264 fetch, protocol, parse, browser-support, decode, draw, or zero-frame failure clears the learned touch surface and switches the live phase to that same session's signed MJPEG URL without closing or replacing its io socket. The devbar names the live phase's actual encoding. The MJPEG element publishes `naturalWidth` and `naturalHeight` as the touch-coordinate surface; callbacks from the replaced H264 renderer cannot overwrite it. An MJPEG failure closes the current resources and enters the existing three-attempt bounded reconnect policy.

## Verification

Package tests pin `(platform, id)` deduplication, first-row selection, cross-platform identity, same-session fallback without another mint or socket, stale callback rejection, MJPEG natural-dimension touch mapping, and retry only after MJPEG failure. The built Desktop fixture covers duplicate listing input, an H264 HTTP 200 error body followed by visible 390×844 MJPEG, a separate successful 390×844 H264 device, exact touch and Home io, and complete process, port, and temporary-root teardown. Fixture evidence is automation only; user acceptance still requires visible live frames and control on the real Android handset, iOS handset, and iOS Simulator.

## Alternatives considered

**Retry H264 with a fresh session before changing format.** Rejected: the observed failures are device-class codec limitations, and minting another session repeats the same unsupported request while interrupting the working io socket.

**Choose MJPEG for every device up front.** Rejected: H264 remains the preferred efficient path where mobilecli produces valid AVC, and the built Desktop lane retains a successful H264 device.

**Deduplicate in each GUI consumer.** Rejected: settings, picker, badge, tools, and later consumers would each need the same repair and could disagree. The `devices.list` wire parser is the first owned point with both platform and id.

## Consequences

The visible encoding may be H264 or MJPEG within one connection session, and renderer code must derive format labels and touch dimensions from the current live phase. A valid H264 path pays no MJPEG request. H264 failure pays one same-session MJPEG request before any reconnect, while a dual-format failure retains the existing bounded failure arm. This note supersedes the H264-only and no-fallback decisions in [the single-tab capture note](../feature/2026-08-29-ui-phone-single-tab-h264.md) and [the WebCodecs playback note](2026-08-30-ui-phone-h264-webcodecs-playback.md); their singleton-tab, online-only, parser, decoder, and resource-lifetime decisions remain current.
