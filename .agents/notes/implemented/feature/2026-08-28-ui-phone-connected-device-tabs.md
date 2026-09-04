# Agent Note: ui-phone connected device view

Status: implemented

English | [中文](2026-08-28-ui-phone-connected-device-tabs.zh.md)

## Problem

The mobile device dock (#355) reached its GUI ticket #361 with the Host capabilities merged (`ctx.phoneDevices`, the same-origin `phone-stream` reverse-proxy) and the `ui-phone` tab still a `single: true` empty state. The dock needed one tab per connected device with focus-not-duplicate semantics, a connected body that streams inside the better-sidebar panel, and error arms for the real-device failure modes — without importing `react-device-view` or any new npm dependency.

## Decision

The `phone` tab type hosts two body shapes split on `meta`. The picker (id `phone`, no serial) renders the locked empty state; occupying a device patches that same tab's meta to `{ kind: 'device', serial, name }` and title `手机·<name>` ([the single-tab reversal](2026-08-29-ui-phone-single-tab-h264.md)). Device switches call `updateTab` from one switcher wired in `installPhoneTab`. 选择设备 calls `showPhonePicker`, which writes `meta: {}` so the picker with 「重新检测环境」 renders again ([live listing](../bug-fix/2026-09-04-ui-phone-sidebar-picker-live-listing.md)). A disabled `ui-phone.enabled` gate drops the switch at that one place.

The connected body consumes the Host `phone-stream` channel over plain browser primitives: `POST /phone/session` mints the signed capture URLs with `format: 'avc'`, `/phone/ws/io` carries JSON-RPC `tap` / `gesture` / `text` / `button`, and [`PhoneH264Surface`](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.md) fetches the signed H264 URL, decodes streaming Annex-B access units through WebCodecs, and paints a canvas whose decoded display size becomes the touch-coordinate surface. All connection decisions live in `PhoneConnectionController`, a React-free object owned by the occupying device: mint → io open → live, `visible: false` suspends pulling, resume re-mints (the signed URLs are short-lived), interruptions reconnect with a bounded budget (3 linear backoff attempts), and the terminal arms — device offline (mint 404 or io `-32010`), USB debugging unauthorized (upstream message), refused (403) — render the locked design's state ④ cards with one 重新连接 action. The screen frame follows the measured surface aspect ([frame-follows-surface](../bug-fix/2026-09-03-phone-frame-follows-measured-surface.md)) with the stream letterboxed into the matching box, holding the locked 1:2 (decision-matrix axis 3 cell B) only as the pre-measurement placeholder, so normalized touch coordinates map linearly onto the learned device pixel surface.

## Alternatives considered

**Mint per-device tabs in `createTab(state)` with a pending-request channel.** Rejected: the open intent would ride hidden mutable state between `request()` and `openTab()`. The later acceptance pass reversed the per-device model entirely ([the single-tab reversal](2026-08-29-ui-phone-single-tab-h264.md)).

**Adopt `react-device-view`.** Rejected by the ticket: a new npm dependency for chrome this package can express with CSS Modules, `--dsw-*` tokens, canvas, and WebSocket. The controller/gateway seam keeps the same testability the library advertises.

**Play the signed H264 URL with a `<video>` element.** Rejected: the Host proxies a raw `avc` elementary stream, which no browser `<video>` decodes without a container. The client-side WebCodecs playback decision and its resource ownership live in [the H264 playback note](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.md).

**Auto-reconnect without a budget.** Rejected: a flapping stream would loop the spinner forever. Three linear attempts land in the interrupted error card whose action resets the budget.

## Consequences

The connected view touches the occupying device through the same-origin channel with no new dependency. The plugin owns no device discovery of its own: the picker lists what the Host listing route answers through the shipped `PhoneListingSource` ([the listing-route note](2026-08-28-phone-device-listing-route.md)). 截图 stays disabled until session-attachment storage exists. The badge contract still cannot target one tab instance, so the singleton phone tab shows the fleet online count. The tab model and H264-only request live in [the single-tab reversal](2026-08-29-ui-phone-single-tab-h264.md); the canvas playback lifecycle lives in [the H264 playback note](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.md).
