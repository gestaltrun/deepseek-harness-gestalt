# Agent Note: 横屏点击时保持 iOS 真机画面会话

Status: implemented

[English](2026-09-04-ios-real-tap-keeps-session.md) | 中文

## 问题

在 iPhone 真机（issue #563：贝贝猫的iPhone，`00008150-0008545C2608401C`）的横屏 H264 画面上点击后，面板进入「正在检测设备控制代理…」，随后断开。Host IO WebSocket 仍开着，只有 JSON-RPC tap 应答失败。

Mint 把 iOS 真机会话标为 `agentManaged: true` 并首选 H264。GUI 发送的是 live H264 画面的采集像素。Host `io()` 把这些像素除以缓存的 `device.info.screenSize.scale`。live `device.info` 仍是竖屏逻辑点 `{width:440, height:956, scale:3}`，而画面已是横屏，因此宽度/3 超过 440，WDA 拒绝 tap。`PhoneConnectionController.handleFrame` 随后对 `agentManaged` 会话上任何非 ok IO 做 teardown 并进入 checking-agent。`logicalDisplay` 仅 Android 使用；[H264 Host 对调](2026-09-05-android-h264-videoframe-rotation.zh.md) 不是这次根因。

## 决策

Host `ioParams` 用缓存的 `device.info.screenSize`（不只是 scale）把 iOS 采集像素换成 XCTest 逻辑点。横竖屏 WDA 边界由 [live 采集面方向笔记](2026-09-04-ios-landscape-tap-orientation.zh.md) 拥有。Android 仍按采集像素原样转发。

`handleFrame` 在 tap / gesture JSON-RPC 错误上保持 live 画面。agent 恢复仍用于 mint、画面与 socket 死亡。IO `-32010` 仍是 device-offline，未授权报文仍是 unauthorized，包括 `agentManaged` 会话。

## Alternatives considered

**每次 tap 都刷新 `device.info`，让宽高跟随旋转。** 拒绝：这台真机 live `device.info.screenSize` 仍是竖屏；额外 RPC 不会改掉锁死边界。

**把 Host 横屏 `logicalDisplay` 当作 iOS 映射来源。** 拒绝：该字段只来自 Android `dumpsys display`。

**在 GUI 用 `h264SurfaceForHost` 对调 iOS `devicePointOf`。** 拒绝：iOS 真机 H264 已报告横屏显示尺寸；WDA 越界来自 Host 只除 scale 的换算。

**保留「任何 IO 错误都拆掉托管 Android 会话」。** 拒绝：Host 不会因 tap RPC 错误关闭 IO WebSocket；agent 恢复只留给 agent 缺失、画面失败与 socket 死亡。

## 后果

iOS 真机横屏 tap 的 JSON-RPC 错误不进入 checking-agent。画面与 socket 死亡仍会复检托管 agent。左侧横屏映射由 [live 采集面方向笔记](2026-09-04-ios-landscape-tap-orientation.zh.md) 拥有。

## Testing

`phone-connection.client.spec.ts` 在 tap JSON-RPC 错误后保持 `agentManaged` 的 iOS 真机或 Android 会话 live，并仍走 device-offline 与 unauthorized 分支。横屏 WDA 映射覆盖见 [live 采集面方向笔记](2026-09-04-ios-landscape-tap-orientation.zh.md)。

## Related

iOS WDA 方向由 [横屏点击笔记](2026-09-04-ios-landscape-tap-orientation.zh.md) 拥有。Android 横屏 H264 画面框对调仍由 [VideoFrame rotation 笔记](2026-09-05-android-h264-videoframe-rotation.zh.md) 拥有。
