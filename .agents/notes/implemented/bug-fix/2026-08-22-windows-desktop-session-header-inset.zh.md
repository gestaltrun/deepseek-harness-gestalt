# Agent Note: Windows Desktop Session 顶栏下移

Status: implemented

[English](2026-08-22-windows-desktop-session-header-inset.md) | 中文

## 问题

Windows Desktop Host 无边框，并绘制一条全宽 36px 拖动条（含 caption 按钮）。侧栏已经在控件上方预留 42px。中间 Session 栏顶部间距仍为 0，因此 `conversation.session.header.actions`（子代理目录、后台任务、定时任务）落在拖动条下面。浏览器 `dsh web` 没有 `window.dshDesktop`，同一 Host URL 能看到这些操作。

## 决策

AppFrame 在存在 Windows chrome 标记时把中间 Session 栏下移 36px，与 macOS 已使用的统一 Window Chrome 高度对齐。[Desktop Host Agent Note](../architecture/2026-08-16-deepseek-gestalt-desktop-host.md) 记录 chrome 几何。

## 考虑过的替代方案

**把拖动条收窄到侧栏加 caption 按钮。** 否决，因为无边框 Windows 窗口仍需要全宽拖动行来移动窗口。

**把 Session 顶栏 z-index 提到拖动条之上。** 否决，因为拖动条是 `-webkit-app-region: drag`，仍会截获这些操作上的指针事件。

**Windows 继续不下移。** 否决，因为 Session 顶栏在 Electron 外壳里将不可见或不可点。

## 后果

Windows Desktop 的 Session 内容从拖动条下方开始。浏览器组合不变。caption 按钮仍在拖动条右缘。

## 测试

`packages/client/ui-layout/tests/app-frame.client.spec.tsx` 固定 AppFrame CSS 中 macOS 与 Windows 的 36px 中间栏 padding。`apps/web/tests/desktop-chrome.e2e.ts` 测量两种 chrome 标记下组装后的 Session Surface inset 与 padding。
