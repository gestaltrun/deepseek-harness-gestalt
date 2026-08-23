# Agent Note: Electron 截图合成器重试

Status: implemented

[English](2026-08-23-electron-screenshot-compositor-retry.md) | 中文

## 问题

已打开并完成加载的 Electron 页面可能在首个 Viz 合成器 surface 可用前，使第一次 `webContents.capturePage` 调用以 Chromium `UnknownVizError` 拒绝。页面仍可使用，但 Browser Runtime 会把截图操作报告为不可用。

## 决策

Electron Browser Runtime 只把 `UnknownVizError` 识别为暂时的合成器启动失败。它等待一个渲染器动画帧，并在原有 abort signal 和请求时限内重试一次 `capturePage`。其他错误或重试失败都会拒绝操作。

## 考虑过的替代方案

**重试所有截图失败。** 否决，因为这会延迟或掩盖非暂时的渲染器、设备和生命周期故障。

**截图前展示或聚焦隐藏页面。** 否决，因为截图不得改变展示状态或焦点归属。

**无限重试。** 否决，因为不可用的合成器必须受操作时限约束并明确失败。

## 后果

首次合成器竞态会被消化，页面可见性不变。持续存在及无关的截图失败保持原有错误行为。

## 测试

假 Electron host 验证 `UnknownVizError` 会成功重试一次，其他截图错误不会重试。声明的 Electron runtime e2e 通过真实 Electron 进程执行截图捕获。
