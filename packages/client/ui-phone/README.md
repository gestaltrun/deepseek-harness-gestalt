# @deepseek-ai/dsh-client-ui-phone

English | [中文](README.zh.md)

Phone tab plugin: registers the 「手机」 tab type into the `ctx.betterSidebar` registry (id `phone`, title 手机, monochrome inline SVG icon, `order: 55`). The entry is always reachable — `available` never refuses, so a deployment with zero devices still opens the picker instance and lands on the locked design's not-connected empty state: the Android/iOS platform segment, the grouped device list (模拟器 / USB 真机), the USB placeholder row, and the 重新检测环境 control.

Tab instances split on `meta`. The picker instance (id `phone`, no serial) renders the empty state. Every opened device mints a separate instance with id `phone:<serial>`, meta `{ kind: 'device', serial, name }`, and title `手机·<name>`; `dedupeKey` returns the serial, so re-opening a connected device focuses the existing tab instead of rebuilding it (decision-matrix axis 1 cells B/C), while the picker stays single-instance through the service's id safety net. Opens ride the seed-carrying default mint (the editor's per-path pattern) — `TabDescriptor.createTab` only receives `SidebarState`, so a createTab-based mint could not see the requesting serial. A disabled deployment drops device-tab opens: with detection off no stream session can be minted. Online picker rows carry a 打开 button and the connected view's device dropdown lists the fleet; both route through one opener.

The connected instance consumes the Host `phone-stream` same-origin channel without importing it: `POST /phone/session` mints the signed capture URLs, the `/phone/ws/io` WebSocket carries JSON-RPC `tap` / `gesture` / `text` / `button`, and MJPEG is played by a native `<img>` whose natural size becomes the touch-coordinate surface. The body renders the locked design's state ③: a devbar with the BrowserView rhythm (6×8 padding, 28-high controls) holding the device dropdown and the MJPEG/H264 chips, the 1:2 fixed-ratio screen centered in the leftover panel area (axis 3 cell B), the circular 返回/主屏幕/最近任务/截图/刷新流 toolbar, and the touch hint line. Clicking the screen sends a tap, dragging past 6px sends a `pointerDown`/`pointerMove`…/`pointerUp` gesture, and printable keys (Enter as `\n`) send text; 截图 stays disabled until session-attachment storage exists.

Connection lifecycle lives in `PhoneConnectionController` (React-free, one instance per tab): mint → io open → live, `visible: false` suspends pulling and resuming mints a fresh session because the signed URLs are short-lived, and interruptions (`onClose`, `onError`, capture-element errors) reconnect with a bounded budget (3 linear backoff attempts) before the error card lands. Terminal arms — device offline (mint 404 or io `-32010`), USB debugging unauthorized (upstream message), refused (403) — skip the retry loop and render the design's state ④ cards with one 重新连接 next action. The renderer mirrors phase snapshots; every decision stays in the controller, and the fake-gateway specs prove the transitions.

The Host half registers the durable `ui-phone` settings namespace (`enabled`, boolean, default `false`) when a settings provider is composed. The browser half registers a Plugins-tab card into `settings.plugin.item` keyed on that same namespace. The card owns the six locked mockup states (off / probing / Android wizard / iOS wizard / ready inventory / recoverable error rows). Command-level install lines carry a 复制 button whose clipboard text is the exact `sdkmanager` / `avdmanager` / `emulator` / `xcodebuild` / `xcrun simctl` command from the mockup. Every error row uses the unified next-action verb 「下一步动作」. Detection data arrives through a narrow `PhoneEnvironmentSource`; the shipped `MISSING_PHONE_ENVIRONMENT_SOURCE` is the probe-failed row used when Host `phoneDevices` is not composed. This package does not import `phone-runtime` or `phone-stream`.

The Loader `Config.enabled` (boolean, schemastery-validated, default `false`) remains the composition default. Registration does not depend on it — a disabled deployment keeps the reachable picker tab, and the picker body pins a 「手机连接未启用」 strip above the empty state. When the durable flag is off nothing discovers devices, spawns `mobilecli`, or routes a stream.

Both the strip badge and the bodies read one injected abstraction, `PhoneBadgeSource` (`getBadge(): { onlineCount }` for the per-render pill, `listDevices(platform)` for the rows). The shipped source is the no-op `NULL_PHONE_BADGE_SOURCE`; the mobilecli provider replaces it in a later ticket. The pill value is the online count when any device is connected and `null` otherwise.

Composition: the `tsconfig.client.json` aggregate references the package; `packages/bundle/web-app/cordis.patch.yml` carries the `ui-phone` browser row; `packages/bundle/web-app/package.json` declares the dependency. The package invariant companion proves tab register/dispose symmetry on a live cordis fiber against a same-process fake registry.

## Model Experience

None. The package registers a sidebar tab and a settings card and renders HTML; it contributes no prompt section, tool schema, stream, or session event, and the enable gate adds no model-visible surface.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Badge fidelity gap** — the locked mockup's 灰点 (no device) / 绿色数字 (online count) needs a dot-and-color rendering path that the pinned better-sidebar badge contract does not offer: it renders one neutral pill around a string or number, and `null` hides the pill entirely. This package therefore ships the value-level two arms (quiet vs count); the dot styling lands when the contract extends. The badge callback also cannot see which tab instance renders it, so every phone tab shows the fleet online count rather than the active device's dot.
- **H264 chip is present but disabled** — the Host signs an H264 capture URL, but raw `avc` needs Media Source Extensions or WebCodecs to play; the chip renders with a tooltip and MJPEG stays the stream format until that decoder ticket lands. `PhoneConnectionController` already pins the format per session.
- **截图 is disabled** — the design stores screenshots as session attachments; no client-attachable route exists yet, so the button renders disabled with a tooltip instead of pretending.
- **重新检测环境 is a disabled placeholder in the picker body** — the settings card's 重新检测 control republishes the injected source; a real `phoneDevices` publisher arrives with the later engine ticket.
- **最近设备 and per-row 启动 stay future surfaces** — the ticket names recent devices and emulator boot, but neither the fleet history nor a browser-reachable boot route exists; the picker ships 打开 only.
- **IME composition and control keys do not reach the device** — printable input and Enter map to `device.io.text`; deletions, shortcuts, and IME pre-edit need a richer text path.
- **Fixed Chinese copy** — the package ships zh-only strings and no locale namespace; localization follows the pass that lands the remaining device-dock states.
