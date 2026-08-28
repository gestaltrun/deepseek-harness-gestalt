# @deepseek-ai/dsh-client-ui-phone

English | [中文](README.zh.md)

Phone tab plugin: registers the 「手机」 tab type into the `ctx.betterSidebar` registry (id `phone`, title 手机, monochrome inline SVG icon, `order: 55`, `single: true`). The entry is always reachable — `available` never refuses, so a deployment with zero devices still opens the tab and lands on the locked design's not-connected empty state: the Android/iOS platform segment, the grouped device list (模拟器 / USB 真机), the USB placeholder row, and the 重新检测环境 control. The body renders only the not-connected empty state; startup, connected, and error states belong to the later device-dock tickets.

The Host half registers the durable `ui-phone` settings namespace (`enabled`, boolean, default `false`) when a settings provider is composed. The browser half registers a Plugins-tab card into `settings.plugin.item` keyed on that same namespace. The card owns the six locked mockup states (off / probing / Android wizard / iOS wizard / ready inventory / recoverable error rows). Command-level install lines carry a 复制 button whose clipboard text is the exact `sdkmanager` / `avdmanager` / `emulator` / `xcodebuild` / `xcrun simctl` command from the mockup. Every error row uses the unified next-action verb 「下一步动作」. Detection data arrives through a narrow `PhoneEnvironmentSource`; the shipped `MISSING_PHONE_ENVIRONMENT_SOURCE` is the probe-failed row used when Host `phoneDevices` is not composed. This package does not import `phone-runtime`.

The Loader `Config.enabled` (boolean, schemastery-validated, default `false`) remains the composition default. Registration does not depend on it — a disabled deployment keeps the reachable tab, and the tab body pins a 「手机连接未启用」 strip above the empty state. When the durable flag is off nothing discovers devices, spawns `mobilecli`, or routes a stream; no such code exists in this package yet.

Both the strip badge and the body list read one injected abstraction, `PhoneBadgeSource` (`getBadge(): { onlineCount }` for the per-render pill, `listDevices(platform)` for the rows). The shipped source is the no-op `NULL_PHONE_BADGE_SOURCE`; the mobilecli provider replaces it in a later ticket. The pill value is the online count when any device is connected and `null` otherwise.

Composition: the `tsconfig.client.json` aggregate references the package; `packages/bundle/web-app/cordis.patch.yml` carries the `ui-phone` browser row; `packages/bundle/web-app/package.json` declares the dependency. The package invariant companion proves tab register/dispose symmetry on a live cordis fiber against a same-process fake registry.

## Model Experience

None. The package registers a sidebar tab and a settings card and renders HTML; it contributes no prompt section, tool schema, stream, or session event, and the enable gate adds no model-visible surface.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Badge fidelity gap** — the locked mockup's 灰点 (no device) / 绿色数字 (online count) needs a dot-and-color rendering path that the pinned better-sidebar badge contract does not offer: it renders one neutral pill around a string or number, and `null` hides the pill entirely. This package therefore ships the value-level two arms (quiet vs count); the dot styling lands when the contract extends.
- **重新检测环境 is a disabled placeholder in the tab body** — the settings card's 重新检测 control republishes the injected source; a real `phoneDevices` publisher arrives with the later engine ticket.
- **最近设备 and per-row 打开/启动 stay future surfaces** — the ticket names recent devices, but the locked empty-state design groups live sources only (模拟器 / USB 真机) and defers connect and start actions to the engine tickets; both arrive once a real `PhoneBadgeSource` reports history.
- **Fixed Chinese copy** — the skeleton ships zh-only strings and no locale namespace; localization follows the pass that lands the remaining tab states.
- **The body ignores tab props** — `visible`-gated stream pausing starts with the connected state, so the descriptor forwards nothing today.
