# Agent Note: 工作台 `contain: layout` 会藏起标签条

Status: implemented

[English](2026-09-04-workbench-contain-layout-tab-strip.md) | 中文

## Problem

Desktop Host 把每个官方 Runtime 页作为 `WebContentsView` 贴在快照 `browser` 标签的视口孔上。右侧与底部工作台面板是绝对定位，并带 `contain: layout` 时，Chromium 会在 `top: 0`、panel host 仍在视口原点的情况下把面板报告成负的 `y`。标签条落到屏外，实况页盖住侧栏标签列表，看起来像另一套浏览器 chrome，而不是工作台里的标签。

## Decision

右侧与底部工作台面板只使用 `contain: style`。官方页面 chrome 仍是 `ui-workbench` / `ui-browser` 里的快照 `browser` 标签；Desktop 仍把实况 `webContents` 贴进 `[data-browser-viewport]`。浮动窗口继续使用 `contain: layout style`。

## Alternatives considered

**保留 `contain: layout`，只补偿 `browserPresent` 的 bounds。** 未采用，因为标签条本身已经在屏外；只移动 native 页仍会藏起页面列表。

**用 Window Chrome 的 `padding-top` 钉住面板。** 未采用，因为 host 已经是视口大小；缺陷是 containment 把绝对定位面板算错，不是缺少 chrome 内边距。

## Consequences

工作台标签条留在窗口内。官方页面仍叠在地址栏下方的视口孔上，而不是单独一层顶栏浏览器。面板拖动隔离不再使用 layout containment。

## Testing

实况 Desktop 上把 `contain` 设为 `none` 后，面板 `y` 从 `-44` 回到 `0`。包内 CSS 记录 `contain: style` 规则。重建后的 headed Desktop 在工作台标签条上显示 `about:blank` 标签，而不再被 native 页盖住。
