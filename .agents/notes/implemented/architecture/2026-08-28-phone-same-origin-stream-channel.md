# Agent Note: Same-origin phone IO and capture reverse-proxy

Status: implemented

English | [中文](2026-08-28-phone-same-origin-stream-channel.zh.md)

## Problem

The mobile device dock (#355) needs live screen frames and tap/gesture/text/button IO in the browser, but mobilecli listens on loopback `:12000`. A page that dials that port would leak the device fleet past the Host trust fence, and a LAN Host that reverse-proxied unsigned capture URLs would let any same-network browser read the stream.

## Decision

`packages/phone/phone-stream` (`@deepseek-ai/dsh-phone-stream`) is the Host Consumer on `ctx.phoneStream`. It injects `phoneDevices` and `webServer` and never lets the browser dial `:12000`.

- IO rides the exact-path WebSocket upgrade `/phone/ws/io` after the `/api` trust fence (Host loopback or declared `trustedHosts`, same-origin Origin, no cross-site Fetch-Metadata). Frames are JSON-RPC `tap` / `gesture` / `text` / `button` forwarded onto `phoneDevices.io`.
- Capture rides signed Host-origin URLs `/phone/stream/<id>/<mjpeg|h264>?token=`. Minting is `sessionFor` / `POST /phone/session`. Each token is HMAC-SHA256 over `deviceId`, format, and expiry, with `tokenTtlMs` (default 30s). Capture additionally refuses a non-loopback Host, so a trusted LAN authority that can call `/api` still cannot play video.
- `phone-runtime` appends `io` and `startCapture` without changing `listDevices` / `boot` / `shutdown`. `startCapture` maps `h264` onto upstream `avc` and bounds only the wait for response headers; the unread body belongs to the Host reverse-proxy, which cancels it when the browser disconnects.

Picture aspect (fixed 1:2, axis 3) stays a GUI consumer contract. This package mints stream URLs and forwards frames; it does not render `react-device-view`.

## Alternatives considered

**Browser dials `:12000` directly.** Rejected: the page would bypass the Host trust fence and expose the mobilecli JSON-RPC surface to any origin that can reach loopback.

**Reuse the `/api` trust fence alone for capture URLs.** Rejected: over plain HTTP a rebound image or `<video>` request may carry neither Origin nor Fetch-Metadata. Capture additionally requires loopback plus a short-lived HMAC so a LAN Host cannot become an unsigned MJPEG endpoint.

**Put IO and capture methods on `phoneDevices` only, with no sibling package.** Rejected: fleet listing and spawn already live on the folded Service; Host HTTP/WebSocket reverse-proxy is a Consumer of that Service and of `webServer`, so it belongs in `phone-stream`.

## Consequences

GUI tickets can consume same-origin IO and signed MJPEG/H264 URLs without touching `ui-phone` in this change. Capture stays loopback-only until a later ticket adds an authenticated remote path. `phone-runtime` still requires a user-installed mobilecli; this Consumer cannot compose without that Service.
