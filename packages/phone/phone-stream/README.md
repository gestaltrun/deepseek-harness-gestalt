# @deepseek-ai/dsh-phone-stream

English | [中文](README.zh.md)

Same-origin Host Consumer for phone IO and screen capture. The plugin injects `phoneDevices` and `webServer`, registers the fleet-listing route, a WebSocket upgrade plus signed HTTP capture routes, and publishes `ctx.phoneStream`. The browser never dials mobilecli `:12000`: tap/gesture/text/button JSON-RPC rides `/phone/ws/io`, and MJPEG/H264 frames ride Host-origin URLs minted by `sessionFor`. Picture layout (fixed 1:2, axis 3) is a GUI consumer contract; this package only mints stream URLs and forwards frames.

- `sessionFor(id)` — IO upgrade path plus signed `mjpeg` and `h264` URLs whose query token expires after `tokenTtlMs`.
- `POST /phone/session` — mints those URLs for a device present in the latest listing; the `/api` trust fence runs first.
- `GET /phone/devices` — answers the grouped fleet listing (`android`, `ios.simulators`, `ios.reals`; each entry `id`/`name`/`kind`/`state`/`online`, with `state` carried verbatim from the upstream listing) from the latest `phoneDevices.listDevices()` acquisition; the `/api` trust fence runs first and the body is GET-only on the exact path. A `PhoneDevicesError` other than `PHONE_DEVICE_NOT_FOUND` answers 502 with `{ error: { code, message } }` so `PHONE_UNRESOLVED` carries install guidance to the browser.
- `GET /phone/stream/<id>/<mjpeg|h264>?token=` — reverse-proxies `device.screencapture`. The `/api` trust fence runs first, then a loopback Host fence, then HMAC verification; expired, forged, or non-loopback requests return 403. The proxy accepts both upstream `device.screencapture` answer shapes — the bare byte stream and mobilecli 1.0.5's `{ format, sessionUrl }` envelope, whose session URL must stay on the loopback fence — and re-emits multipart MJPEG bodies under a single normalized boundary, dropping non-image parts (JSON notifications) while keeping frame bytes untouched.
- `GET /phone/ws/io` upgrade — forwards `device.io.tap` / `gesture` / `text` / `button` JSON-RPC after the `/api` trust fence; untrusted upgrades are refused before protocol negotiation.

## Config

| Field | Default | Meaning |
|---|---|---|
| `tokenTtlMs` | `30000` | Lifetime of a minted capture URL. Path prefixes, HMAC-SHA256, and the loopback capture fence are not configurable. |

## Extension points

Composition must provide `phoneDevices` and `webServer`; the fiber waits on both. The `./invariant` companion is empty because Host WebServer effects own route registration and disposal.

## Model Experience

None, as this package is a pure Host-side reverse-proxy that registers no prompt, tool schema, or other model-visible surface.

#### KV Cache effect

Independent of model requests: the plugin only registers Host HTTP and WebSocket routes and never writes a session event, so prefix reuse and cache behavior are untouched.

## Known Limitations and Deferred Work

- **Capture URLs are loopback-only** — even a trusted LAN Host is refused, so a non-loopback deployment cannot play device video until a later ticket adds an authenticated remote path.
- **No GUI** — this package does not render `react-device-view` or enforce the 1:2 picture ratio; ui-phone consumes the minted URLs later.
- **mobilecli remains user-installed** — `phone-runtime` still owns binary discovery and spawn; this Consumer cannot compose without that Service.
