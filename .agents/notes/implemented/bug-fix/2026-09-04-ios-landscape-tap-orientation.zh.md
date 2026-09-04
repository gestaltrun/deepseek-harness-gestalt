# Agent Note: iOS 横屏点击跟随 live 采集面

Status: implemented

[English](2026-09-04-ios-landscape-tap-orientation.md) | 中文

## 问题

[#563](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/563) 之后，横屏 tap JSON-RPC 错误不再拆掉 iPhone 真机画面（[会话保持](2026-09-04-ios-real-tap-keeps-session.zh.md)）。Host `ioParams` 仍仅在单点缩放后超出竖屏宽度时，才对调锁死的竖屏 `device.info.screenSize`（`440×956` scale 3）。横屏 H264 画面约 `2868×1320`。左半边与中部 `x/3 ≤ 440`，因此仍按竖屏点转发（`99,660` → `33,220`）。横屏 WDA 要 `956×440`。这些点击无效，会话仍保持 live。

## 决策

方向来自 live 采集面，而不是单点是否越界。浏览器 tap / gesture 帧从 `PhoneConnectionController.surfaceSize()` 发送可选的 `captureWidth`/`captureHeight`。当该采集面为横屏（`captureWidth` 大于 `captureHeight`）且 `screen.width` 小于 `screen.height` 时，Host `ioParams` 始终对调锁死的竖屏逻辑边界，再除以 scale 并夹紧。竖屏采集（`1320×2868`）仍走 `440×956`。省略尺寸时保留越界启发式，供非浏览器调用方使用；浏览器始终发送尺寸。

## Alternatives considered

**继续只用单点缩放后是否越界判断方向。** 拒绝：左侧横屏 tap 永不超出竖屏宽度，会留在错误的 WDA 坐标系。

**每次 tap 刷新 `device.info`。** 拒绝：这台真机 live `screenSize` 仍是竖屏；额外 RPC 不会改掉锁死边界。

**把 Host `logicalDisplay` 当作 iOS 映射来源。** 拒绝：该字段只来自 Android `dumpsys display`。

## 后果

横屏采集上任意 x（含左半边）映射进对调后的 `956×440`。竖屏采集保持 `440×956`。未带采集尺寸的工具与其他非浏览器调用方仍仅在单点越界时对调。

## Testing

`io.spec.ts` 把贝贝猫横屏 `2868×1320` 的 tap（含 `99,660` 以及只在 `956×440` 才会夹紧的 y）映射到对调边界；竖屏 `1320×2868` 不对调；省略尺寸时保留越界启发式。`service.spec.ts` 经 Host `io()` 转发左侧横屏 tap。`phone-stream-client.client.spec.ts` 编码采集尺寸；`phone-connection.client.spec.ts` 与 `phone-connected-view.client.spec.tsx` 从 live 画面发送该尺寸；`phone-stream` 的 `routes.spec.ts` 解析后交给 Host `io()`。

## Related

tap JSON-RPC 错误上的会话存活仍由 [会话保持笔记](2026-09-04-ios-real-tap-keeps-session.zh.md) 拥有。Android H264 画面框对调仍由 [VideoFrame rotation 笔记](2026-09-05-android-h264-videoframe-rotation.zh.md) 拥有。
