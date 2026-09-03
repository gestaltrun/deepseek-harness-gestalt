# @deepseek-ai/dsh-tool-phone

English | [中文](README.zh.md)

Model-facing Consumer for `ctx.phoneDevices`. It registers `device_list`, `device_open`, `device_close`, `device_observe`, `device_act`, and `device_screenshot` as ordinary deferred tools. `device_act` accepts exactly one closed tap, swipe, type, or hardware-button action; there is no arbitrary `adb` or shell path. `device_list` and `device_observe` answers carry `id`/`name`/`kind`/`state`/`online`/`platform` per entry.

All six definitions exist only while `phoneDevices.isReady()` is true. The Consumer subscribes to generation readiness, registers the complete set on activation, and disposes the complete set before a generation stops or is replaced. A fleet implementation without the readiness methods retains the static registration contract for out-of-tree compatibility.

## Configuration

`timeoutMs` is the positive safe-integer cooperative timeout for every call and defaults to `30000`. Invalid values fail plugin load. The Consumer requires the phone fleet Service and tool registry; registration fails loud when `toolSearch` is disabled.

`tool_search` returns matching schemas but never activates tools. Eligibility remains the only discovery and dispatch authority. The tools omit custom presenters, so Host clients use the same generic MCP-style tool card path as other ordinary tools.

`device_act`, `device_open`, and `device_close` default to `tools/pre-execute` `ask` after earlier listeners return `allow`. A prior deny or ask is left unchanged. An `allowed-once` approval runs the fleet call once; a rejection leaves the device untouched.

Fleet failures that already carry a `PhoneDevicesError` code (`PHONE_DISPOSED`, `PHONE_ABORTED`, `PHONE_TIMEOUT`, `PHONE_UNAVAILABLE`, `PHONE_UNRESOLVED`, `PHONE_PROTOCOL`, `PHONE_UPSTREAM`, `PHONE_DEVICE_NOT_FOUND`, `PHONE_REAL_DEVICE`) are rethrown as `HarnessError` with that same code. `device_act` forwards a closed tap, swipe, type, or button onto `phoneDevices.io`. A swipe uses `phoneSwipeActions` from `@deepseek-ai/dsh-phone-runtime/swipe` ([encoding](../../../.agents/notes/implemented/bug-fix/2026-09-02-phone-ios-wda-swipe-gesture.md)). Empty type text, or an injected fleet missing `io` / `screenshot`, uses `PHONE_UNSUPPORTED`. `device_screenshot` calls `phoneDevices.screenshot` and returns `image/png`; `PHONE_UNSUPPORTED` remains only when an injected test fleet omits that method. Live MJPEG/H264 capture stays on `dsh-phone-stream`.

## Model Experience

### Phone tool discovery and results

#### What the model sees

The initial tool list omits all six device tools and includes the ordinary `tool_search` schema. A search for device capabilities returns the exact schemas in a durable result. Later requests revalidate those names against current eligible deferred definitions. Every operation result renders the complete listing, observation, mutation receipt, closed action, or PNG screenshot facts as JSON text.

#### Token effect

Discovery adds the selected schemas to the search result and later request headers. Each operation adds its complete rendered JSON result to Session history.

#### KV Cache effect

The first request keeps the device schemas out of the prefix. Discovery changes the next request's tool list, and subsequent append-only results preserve reuse after that changed prefix.

## Known Limitations and Deferred Work

- Shipped Desktop and headless presets do not mount this Consumer, so there is no keyless assembled-transcript snapshot yet. Discovery reconstruction is proven in package tests against `systemPrompt.assemble`; a snapshot lands when a product composition mounts these tools. Live video, signed stream routes, and GUI chrome stay in their own packages.
