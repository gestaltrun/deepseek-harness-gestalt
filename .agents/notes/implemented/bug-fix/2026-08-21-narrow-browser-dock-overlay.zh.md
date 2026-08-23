# Agent Note: 窄视口 Browser Dock 浮层

Status: implemented

[English](2026-08-21-narrow-browser-dock-overlay.md) | 中文

## 问题

Desktop 默认窗口宽 1280px。Browser Dock 占用方的详情范围为 420/640/960，Session Surface 流内下限为 640px。默认 280px 侧边栏下这三轨需要 1340px，因此让步求解器会在默认窗口以及更窄的笔记本分屏上把流内详情宽度推导为零。

`dockOpen` 为 true 时收起预览会自行隐藏。收起控件在 Dock 右缘。截图视口使用 `overflow: hidden` 与 `object-fit: cover`。因此在 1280px 或被裁切的窗口上，人既看不到展开控件，也够不到收起，更无法平移放不下窗格的页面。

## 决策

`computeColumns` 仍会在不改写存储偏好的前提下把流内详情轨道推导为零。当该偏好为打开时，AppFrame 把详情占用方画成右侧浮层，宽度为 `min(夹取后的偏好, 侧边栏旁剩余帧宽)`。浮层可以低于占用方最小值，使控件留在屏内。浮层绘制期间 `data-details-collapsed` 为 false；`data-details-overlay` 标记浮层。拖动以浮层宽度为基准。窗口变宽到流内求解给出正的详情轨道时，浮层消失。

Dock 视口可滚动（`overflow: auto`），并按截图固有尺寸从左上绘制。收起控件在标签条内为 `position: sticky; right: 0`，以免横向溢出的标签盖住它。

官方 Browser chrome 后来离开了 `details`（[工作台官方浏览器 Agent Note](../feature/2026-08-21-workbench-official-browser.md)）。浮层留给其他详情占用方。本决策只持有浮层与可滚动视口。

## 考虑过的替代方案

**在 `dockOpen` 为 true 且详情被让步关闭时显示收起预览。** 否决，因为点击展开仍会调用 `openDetails`，求解器仍会推导出零流内宽度；人会得到一个无法露出页面的按钮。

**降低 `CENTER_MIN` 或 Dock 最小值，使 1280px 保持流内。** 否决，因为 640px Session Surface 下限与 420px Dock 最小值是 [#60](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/60) 的范围；为迁就一个默认窗口而缩小它们会在所有宽度上裁切对话或控件。

**允许外壳横向滚动。** 否决，因为三栏外壳按约定裁切溢出；窗口滚动条会把收起和地址栏藏到右缘外，而这正是缺陷本身。

## 后果

1280px Desktop 窗口上打开的 Dock 会盖住 Session Surface 右侧，而不是消失。收起与接管留在可见浮层内。宽于窗格的截图在视口内平移，不再被 `object-fit: cover` 裁切。存储的详情偏好仍然不是渲染真相。

## 测试

`packages/client/ui-layout/tests/columns.client.spec.ts` 固定 `overlayDetailsWidth` 在关闭偏好、可放下的 640px 浮层、夹取后的 960px 浮层，以及低于占用方最小值的剩余宽度。`packages/client/ui-layout/tests/app-frame.client.spec.tsx` 固定 1280px Browser Dock 浮层、1339px 让步浮层在 2000px 恢复流内，以及 `data-details-overlay` / `data-details-collapsed`。
