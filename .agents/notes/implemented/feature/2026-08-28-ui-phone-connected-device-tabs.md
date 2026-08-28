# Agent Note: ui-phone connected device view and per-device tabs

Status: implemented

English | [中文](2026-08-28-ui-phone-connected-device-tabs.zh.md)

## Problem

The mobile device dock (#355) reached its GUI ticket #361 with the Host capabilities merged (`ctx.phoneDevices`, the same-origin `phone-stream` reverse-proxy) and the `ui-phone` tab still a `single: true` empty state. The dock needed one tab per connected device with focus-not-duplicate semantics, a connected body that streams inside the better-sidebar panel, and error arms for the real-device failure modes — without importing `react-device-view` or any new npm dependency.

## Decision

The `phone` tab type hosts two instance shapes split on `meta`. The picker (id `phone`, no serial) renders the locked empty state; every opened device mints id `phone:<serial>` with meta `{ kind: 'device', serial, name }` and title `手机·<name>`. `dedupeKey` returns the serial, so re-opening a connected device focuses the existing tab, and the picker stays single-instance through the service's id safety net. Device tabs mint through the seed-carrying default open — `openTab({ type: 'phone', id: 'phone:<serial>', title, meta })` from one opener wired in `installPhoneTab` — not through `createTab`: `TabDescriptor.createTab` receives only `SidebarState`, so a createTab mint cannot see the requesting serial, and the alternative pending-request side channel would be implicit state between two calls.

The connected body consumes the Host `phone-stream` channel over plain browser primitives: `POST /phone/session` mints the signed capture URLs, `/phone/ws/io` carries JSON-RPC `tap` / `gesture` / `text` / `button`, and MJPEG plays in a native `<img>` whose natural size becomes the touch-coordinate surface. All connection decisions live in `PhoneConnectionController`, a React-free object owned per tab: mint → io open → live, `visible: false` suspends pulling, resume re-mints (the signed URLs are short-lived), interruptions reconnect with a bounded budget (3 linear backoff attempts), and the terminal arms — device offline (mint 404 or io `-32010`), USB debugging unauthorized (upstream message), refused (403) — render the locked design's state ④ cards with one 重新连接 action. The screen frame locks to 1:2 (decision-matrix axis 3 cell B) with the img filling it, so normalized touch coordinates map linearly onto the learned device pixel surface. A disabled `ui-phone.enabled` gate drops device-tab opens at the opener, the one place that decides it.

## Alternatives considered

**Mint per-device tabs in `createTab(state)` with a pending-request channel.** Rejected: the open intent would ride hidden mutable state between `request()` and `openTab()`, and any other `openTab({ type: 'phone' })` caller would trip over a stale request. The seed-carried default mint carries id/title/meta explicitly and is the editor builtin's per-resource precedent.

**Adopt `react-device-view`.** Rejected by the ticket: a new npm dependency for chrome this package can express with CSS Modules, `--dsw-*` tokens, a native `<img>`, and WebSocket. The controller/gateway seam keeps the same testability the library advertises.

**Play the signed H264 URL with a `<video>` element.** Rejected for now: the Host proxies a raw `avc` elementary stream, which no browser `<video>` decodes without MSE/WebCodecs remuxing. The chip renders disabled with a tooltip; the controller pins the format per session so the decoder ticket swaps one arm.

**Auto-reconnect without a budget.** Rejected: a flapping stream would loop the spinner forever. Three linear attempts land in the interrupted error card whose action resets the budget.

## Consequences

Multi-device monitoring works per tab with focus dedupe, and the connected view touches the device through the same-origin channel with no new dependency. The plugin owns no device discovery of its own: the picker lists what the Host listing route answers through the shipped `PhoneListingSource` ([the listing-route note](2026-08-28-phone-device-listing-route.md)), and 截图 plus H264 playback remain visibly disabled with reasons. The badge contract still cannot target one tab instance, so every phone tab shows the fleet online count.
