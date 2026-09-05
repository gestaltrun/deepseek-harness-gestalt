# Agent Note: Deferred phone device tools

Status: implemented

[English](2026-08-28-tool-phone-deferred-device-tools.md) | 中文

## 问题

移动设备 dock（#355）需要 `ctx.phoneDevices` 上的模型 Consumer。把二十多个平行的 `android_*`/`mobile_*` schema 放进初始请求会重演 Tandem 257 工具失败；任意 `adb shell` 路径则等于把真机 root shell 交给模型。boot 与 shutdown 仍需默认向人询问，且不能把产品策略写进设备群 Service；启用手机 dock 后，封闭的 tap、swipe、type 与按钮在普通 agent 循环中执行。

## 决策

`packages/phone/tool-phone`（`@deepseek-ai/dsh-tool-phone`）是 `ctx.phoneDevices` 的延迟 Consumer。它注入 `phoneDevices` 与 `tools`，注册六个 `deferLoading` 工具（`device_list`、`device_open`、`device_close`、`device_observe`、`device_act`、`device_screenshot`），并在禁用 `toolSearch` 时拒绝加载。初始请求不含这些 schema；`tool_search` 返回匹配 schema 但不激活工具，后续请求从持久 `loadedTools` 重建。

`device_act` 只接受封闭的 `tap` / `swipe` / `type` / `button` 动作，并转发到 `phoneDevices.io`（`tap`、`swipe`、`text`、`button`）。没有 shell、`adb` 或自由命令参数。`device_open` 与 `device_close` 监听 `tools/pre-execute`，在先前监听器返回 `allow` 后替换为 `ask`。`device_act` 尊重先前的 deny 或 ask，否则不再弹出新的审批。审批 `allowed-once` 会执行一次设备群调用；拒绝则永远到不了 `boot` / `shutdown`。

已携带 `PhoneDevicesError` 代码的设备群失败会以同一代码重抛为 `HarnessError`。空 type 文本，或注入设备群缺少 `io` / `screenshot`，使用 `PHONE_UNSUPPORTED`。`device_screenshot` 调用 `phoneDevices.screenshot`，后者把 PNG 持久化到 `$DSH_HOME/phone/screenshots` 并返回 `{ mediaType: 'image/png', path }`；工具结果是 `{ deviceId, path }`，渲染为这两项，绝不是 PNG 字节或 base64 图片块。仅当注入的测试设备群省略该方法时仍走 `PHONE_UNSUPPORTED`。实况 MJPEG/H264 采集仍由 `dsh-phone-stream` 负责。本 Consumer 未编入已交付的 Desktop/headless preset；发现重建由包测试通过 `systemPrompt.assemble` 证明。

## Alternatives considered

**在初始请求注册二十多个 `android_*` / `mobile_*` 工具。** 否决：Tandem 规模的 schema 倾倒已被拒绝，延迟发现是已确立的 Browser Runtime 模式。

**暴露 `adb shell` 或自由命令工具。** 否决：USB 调试等于真机 root shell；封闭 act 联合才是强制，而不是提示词过滤。

**只在 `device_act.execute` 内询问。** 否决：`tools/pre-execute` 才是文档化的允许／拒绝／询问门禁；执行体内的检查会跑在策略之后，也无法共享审批审计对。

**本票增加无密钥组装 transcript 快照。** 否决：此 Consumer 尚未被已交付的可运行示例挂载。包测试通过真实提示词组装路径重建 schema；产品组合挂上这些工具后再补 snapshot。

## Consequences

模型可以在首次请求不支付 schema 成本的情况下发现六工具手机词表。boot 与 shutdown 默认走一次性审批；封闭动作在 allow 之后执行。运维继承设备群的安装前置。`PhoneDevices.screenshot` 通过 `mobilecli screenshot --format png` 捕获一张 PNG 静帧并返回仅所有者可读写的路径，因此 `device_screenshot` 对现行 Service 返回该路径。GUI chrome 与 preset 组合仍是后续票。
