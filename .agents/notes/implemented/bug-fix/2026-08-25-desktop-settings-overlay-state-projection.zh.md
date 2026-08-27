# Agent Note: 将 Desktop 状态投影到 Settings Overlay

Status: implemented

[English](2026-08-25-desktop-settings-overlay-state-projection.md) | 中文

## 问题

Desktop Settings 渲染在独立的 `WebContentsView` 中，而 Platform Account、Personal Pairing 与 updater 状态变化只发送给主 `BrowserWindow`。因此，在 GitHub 授权之前已经挂载的 overlay 会在 Account controller 登录成功后继续保留退出状态。同一项传输遗漏也会导致挑战、待确认决策、已配对设备和 updater 变化无法在不重新打开 Settings 的情况下显示。

## 决策

Desktop 状态 owner 通过同一个 helper，把每次 Account、Personal Pairing 与 updater 快照同时投影到两个当前 renderer surface。投影只接纳每个不同且尚未销毁的 `WebContents` 一次。主进程只提供当前主窗口与 overlay 引用，因此已释放或已替换的 overlay 不会被保留为事件目标。

## 考虑过的替代方案

**只在打开 Settings 时刷新状态。** 拒绝，因为登录轮询、配对 mailbox 交付、Relay presence 和更新下载进度都可能在 overlay 保持打开时发生变化。

**由 renderer 轮询每个 controller。** 拒绝，因为 preload 事件通道已经定义了 push 所有权；轮询会在 UI 中增加陈旧 interval，并重复生命周期策略。

**只把这些事件发送给 overlay。** 拒绝，因为 preload bridge 安装在两个 Desktop renderer surface 上；投影策略不应依赖当前由哪个 surface 消费某一类状态。

## 后果

打开的 Settings overlay 会持续跟随 Account 授权、配对挑战创建、Mobile 确认、设备投影和 updater 进度，不需要关闭后重新打开。Renderer 替换仍限定于当前 Electron owner，重复引用也不会产生重复状态回调。

## 测试

Renderer projection 回归测试会把一条事件发送给两个有效目标，排除已销毁目标，并去重同一个有效目标。Packaged Desktop 验收会通过 GitHub 登录，并在 Settings 保持打开时继续完成真实 Personal Pairing 状态变化。
