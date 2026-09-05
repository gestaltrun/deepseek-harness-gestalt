# Agent Note: Deferred phone device tools

Status: implemented

English | [中文](2026-08-28-tool-phone-deferred-device-tools.zh.md)

## Problem

The mobile device dock (#355) needs a model-facing Consumer over `ctx.phoneDevices`. Shipping twenty-plus parallel `android_*`/`mobile_*` schemas on the initial request repeats the Tandem 257-tool failure, and an arbitrary `adb shell` path would give the model a real-device root shell. Boots and shutdowns still need a default human ask without baking product policy into the fleet Service; closed taps, swipes, types, and buttons run in the ordinary agent loop after the phone dock is enabled.

## Decision

`packages/phone/tool-phone` (`@deepseek-ai/dsh-tool-phone`) is the deferred Consumer of `ctx.phoneDevices`. It injects `phoneDevices` and `tools`, registers six `deferLoading` tools (`device_list`, `device_open`, `device_close`, `device_observe`, `device_act`, `device_screenshot`), and fails plugin load when `toolSearch` is disabled. The initial request carries none of those schemas; `tool_search` returns matching schemas without activating tools, and later requests reconstruct them from durable `loadedTools`.

`device_act` accepts exactly one closed `tap` / `swipe` / `type` / `button` action and forwards it onto `phoneDevices.io` (`tap`, `swipe`, `text`, `button`). There is no shell, `adb`, or free-form command parameter. `device_open` and `device_close` listen on `tools/pre-execute` and, after earlier listeners return `allow`, replace that with `ask`. `device_act` keeps a prior deny or ask and otherwise runs without a new prompt. Approval `allowed-once` runs the fleet call once; rejection never reaches `boot` / `shutdown`.

Fleet failures that already carry a `PhoneDevicesError` code are rethrown as `HarnessError` with that same code. Empty type text, or an injected fleet missing `io` / `screenshot`, uses `PHONE_UNSUPPORTED`. `device_screenshot` calls `phoneDevices.screenshot`, which persists the PNG under `$DSH_HOME/phone/screenshots` and returns `{ mediaType: 'image/png', path }`; the tool result is `{ deviceId, path }` rendered as those two fields, never PNG bytes or a base64 image block. `PHONE_UNSUPPORTED` remains only when an injected test fleet omits that method. Live MJPEG/H264 capture stays on `dsh-phone-stream`. The shipped headless keyless example mounts the Consumer over a recorded fake fleet; `deferred-phone-tools.snapshot.ts` proves zero initial schemas, `tool_search` reconstruction, and one closed action. Desktop does not mount the Consumer.

## Alternatives considered

**Register twenty-plus `android_*` / `mobile_*` tools on the initial request.** Rejected: Tandem-scale schema dumps already lost, and deferred discovery is the established Browser Runtime pattern.

**Expose `adb shell` or a free-form command tool.** Rejected: USB debugging is a real-device root shell; the closed act union is the enforcement, not a prompt filter.

**Ask only inside `device_act.execute`.** Rejected: `tools/pre-execute` is the documented allow/deny/ask gate; a body-local check would run after policy and could not share the approval audit pair.

**Verify only with package prompt assembly.** Rejected: the shipped headless example now owns a keyless assembled-transcript snapshot in addition to package coverage.

## Consequences

The model can discover a six-tool phone vocabulary without paying its schema cost on the first request. Boot and shutdown default to one-shot approval; a closed act runs after allow. Operators inherit the fleet's install prerequisite. `PhoneDevices.screenshot` captures one PNG still through `mobilecli screenshot --format png` and returns the owner-only path, so `device_screenshot` answers with that path against the live Service. The shipped headless example proves assembled behavior; GUI chrome and Desktop composition remain separate.
