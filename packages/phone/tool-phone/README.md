# @deepseek-ai/dsh-tool-phone

English | [中文](README.zh.md)

Model-facing Consumer for `ctx.phoneDevices`. It registers `device_list`, `device_open`, `device_close`, `device_observe`, `device_act`, and `device_screenshot` as ordinary deferred tools. `device_act` accepts exactly one closed tap, swipe, type, or hardware-button action; there is no arbitrary `adb` or shell path. `device_list` and `device_observe` answers carry `id`/`name`/`kind`/`state`/`online`/`platform` per entry.

All six definitions exist only while `phoneDevices.isReady()` is true. The Consumer subscribes to generation readiness, registers the complete set on activation, and disposes the complete set before a generation stops or is replaced. A fleet implementation without the readiness methods retains the static registration contract for out-of-tree compatibility.

## Configuration

`timeoutMs` is the positive safe-integer cooperative timeout for every call and defaults to `30000`. Invalid values fail plugin load. The Consumer requires the phone fleet Service and tool registry; registration fails loud when `toolSearch` is disabled.

`tool_search` returns matching schemas but never activates tools. Eligibility remains the only discovery and dispatch authority. The tools omit custom presenters, so Host clients use the same generic MCP-style tool card path as other ordinary tools.

`device_open` and `device_close` default to `tools/pre-execute` `ask` after earlier listeners return `allow`. A prior deny or ask is left unchanged. An `allowed-once` approval runs the fleet call once; a rejection leaves the device untouched. `device_act` keeps that prior deny or ask and otherwise runs the closed tap, swipe, type, or button without a new prompt.

Fleet failures that already carry a `PhoneDevicesError` code (`PHONE_DISPOSED`, `PHONE_ABORTED`, `PHONE_TIMEOUT`, `PHONE_UNAVAILABLE`, `PHONE_UNRESOLVED`, `PHONE_PROTOCOL`, `PHONE_UPSTREAM`, `PHONE_DEVICE_NOT_FOUND`, `PHONE_REAL_DEVICE`) are rethrown as `HarnessError` with that same code. `device_act` forwards a closed tap, swipe, type, or button onto `phoneDevices.io`. A swipe forwards semantic endpoints and leaves platform/rotation conversion to `PhoneDevices.io()` ([input ownership](../../../.agents/notes/implemented/bug-fix/2026-09-04-ios-semantic-input-rotation.md)). Empty type text, or an injected fleet missing `io` / `screenshot`, uses `PHONE_UNSUPPORTED`. `device_screenshot` calls `phoneDevices.screenshot` and returns `{ deviceId, path }` for the owner-only PNG on disk; rendered tool text is those two fields, never PNG bytes or a base64 image block. `PHONE_UNSUPPORTED` remains only when an injected test fleet omits that method. Live MJPEG/H264 capture stays on `dsh-phone-stream`.

## Model Experience

### Phone tool discovery and results

#### What the model sees

The initial tool list omits all six device tools and includes the ordinary `tool_search` schema. A search for device capabilities returns the exact schemas in a durable result. Later requests revalidate those names against current eligible deferred definitions. Every operation result renders the complete listing, observation, mutation receipt, closed action, or screenshot `deviceId` and PNG path as text.

#### Token effect

Discovery adds the selected schemas to the search result and later request headers. Each operation adds its complete rendered JSON result to Session history.

#### KV Cache effect

The first request keeps the device schemas out of the prefix. Discovery changes the next request's tool list, and subsequent append-only results preserve reuse after that changed prefix.

## Known Limitations and Deferred Work

- The shipped headless keyless snapshot mounts this Consumer over a recorded fake fleet and proves zero initial device schemas, `tool_search` reconstruction, and one closed action. Desktop does not mount the Consumer. Live video, signed stream routes, and GUI chrome stay in their own packages.
