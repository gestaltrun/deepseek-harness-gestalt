# Agent Note: Deferred phone device tools

Status: implemented

English | [中文](2026-08-28-tool-phone-deferred-device-tools.zh.md)

## Problem

The mobile device dock (#355) needs a model-facing Consumer over `ctx.phoneDevices`. Shipping twenty-plus parallel `android_*`/`mobile_*` schemas on the initial request repeats the Tandem 257-tool failure, and an arbitrary `adb shell` path would give the model a real-device root shell. Consequential taps, boots, and shutdowns also need a default human ask without baking product policy into the fleet Service.

## Decision

`packages/phone/tool-phone` (`@deepseek-ai/dsh-tool-phone`) is the deferred Consumer of `ctx.phoneDevices`. It injects `phoneDevices` and `tools`, registers six `deferLoading` tools (`device_list`, `device_open`, `device_close`, `device_observe`, `device_act`, `device_screenshot`), and fails plugin load when `toolSearch` is disabled. The initial request carries none of those schemas; `tool_search` returns matching schemas without activating tools, and later requests reconstruct them from durable `loadedTools`.

`device_act` accepts exactly one closed `tap` / `swipe` / `type` / `button` action. There is no shell, `adb`, or free-form command parameter. `device_act`, `device_open`, and `device_close` listen on `tools/pre-execute` and, after earlier listeners return `allow`, replace that with `ask`. A prior deny or ask is left unchanged. Approval `allowed-once` runs the fleet call once; rejection never reaches `boot` / `shutdown` / `act`.

Fleet failures that already carry a `PhoneDevicesError` code are rethrown as `HarnessError` with that same code. A missing `act`/`screenshot` method on the injected fleet, or empty type text, uses `PHONE_UNSUPPORTED`. The current mobilecli Service owns list/boot/shutdown only; screenshot and act therefore fail with that code until a later fleet ticket adds them. The Consumer is not composed into shipped Desktop/headless presets in this ticket; discovery reconstruction is proven through `systemPrompt.assemble` in package tests.

## Alternatives considered

**Register twenty-plus `android_*` / `mobile_*` tools on the initial request.** Rejected: Tandem-scale schema dumps already lost, and deferred discovery is the established Browser Runtime pattern.

**Expose `adb shell` or a free-form command tool.** Rejected: USB debugging is a real-device root shell; the closed act union is the enforcement, not a prompt filter.

**Ask only inside `device_act.execute`.** Rejected: `tools/pre-execute` is the documented allow/deny/ask gate; a body-local check would run after policy and could not share the approval audit pair.

**Add a keyless assembled-transcript snapshot in this ticket.** Rejected: this Consumer is not mounted by a shipped runnable example yet. Package tests reconstruct schemas through the real prompt assembly path; a snapshot lands when a product composition mounts the tools.

## Consequences

The model can discover a six-tool phone vocabulary without paying its schema cost on the first request, and consequential mutations default to one-shot approval. Operators inherit the fleet's install prerequisite and the current Service's missing screenshot/act methods. GUI chrome, signed stream routes, and preset composition remain later tickets.
