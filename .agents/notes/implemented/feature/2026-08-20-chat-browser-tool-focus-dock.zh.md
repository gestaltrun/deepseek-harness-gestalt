# Agent Note: 对话里选中浏览器工具调用会聚焦列表中的 Dock 标签页

Status: implemented

[English](2026-08-20-chat-browser-tool-focus-dock.md) | 中文

## 问题

在对话里选中浏览器工具调用、页面事件或链接时，应聚焦对应的 Browser Dock 标签页。已交付的接线只打开详情栏并写入聊天选中项（`ChatView.openDetails` → `select` + `layout.openDetails()`）。它没有解析 `browser_*` 目标，也没有调用 `browserWorkspace.focus`。原生 Browser Dock 从未覆盖这条路径。

## 决策

`ChatViewInjected.openDetails` 仍然写入选中项并打开详情。当选中项命名一个 `browser_*` 调用时，conversation 再从当前快照解析该调用的 Browser 标签页，并通过 `remote.browserWorkspace.focus` 用 Session `browserWorkspace` 投影里的列表修订号聚焦它。

当 args 已经给出完整 target 时，args 优先（`browser_navigate` 以及其他可寻址动词）。`browser_create` 只在已结算结果文本上携带新创建的 target。该 helper 留在 `ui-conversation` 内，并把 `remote.browserWorkspace` 视为可选，因此没有 Browser 的组合仍能装载。

focus 使用被操作列表行的修订号，与 Dock chrome 和收起预览相同。它不发送工具结果里的修订号，因为那份修订号可能已经过期。

当标签页已不在列表中时，详情仍会打开，且不调用 focus。该路径不合成 409，也不增加第二套错误界面。focus 被拒绝时会被吞掉，因为详情已经打开。

选择会聚焦列表中的标签页，以便收起预览高亮对应项。Browser Workspace 不携带面板展示状态；better-sidebar 仍是面板是否打开的唯一权威来源。

对话 transcript（文本记录）没有独立的页面事件或链接手势。这类选择若存在，共用这条 `openDetails` 路径。只有 `browser_*` 工具行在点击时调用 `selectCall`；普通工具行保持不响应。

这扩展了 [原生 Browser Dock Agent Note](2026-08-19-browser-dock.md) 中的收起与预览规则，以及 [Dock 标签页修订号 Agent Note](../bug-fix/2026-08-20-dock-tab-revision.md) 中的每标签页列表修订号约定。

## 考虑过的替代方案

**只要对话选中浏览器工具就重新打开 Dock。** 否决，因为收起是 Session 事实：用户收起 Dock 后，后续活动不得再偷开它。聚焦列表中的标签页已足够让收起预览高亮匹配项。

**发送工具结果里的修订号。** 否决，因为各标签页独立导航后修订号会分叉。列表行才是 Dock 已经发送的 Session 权威。

**让 conversation 依赖 `dsh-browser-workspace`。** 否决，因为 conversation 必须在没有 Browser 时仍能装载。结构化读取列表加上可选 Remote 可以保持包边界。

**由 `ui-browser` 观察聊天选中项再聚焦。** 否决，因为缺失的解析本就属于 `openDetails`，第二个订阅者会重复列表修订号约定。

**在对话里展示标签页已消失的错误。** 否决，因为现有界面没有覆盖消失的 Dock 标签页，且详情已经打开。

**让每个工具行都打开详情。** 否决，因为组装测试与当前详情限制要求普通 bash 与文件行保持不响应。

## 后果

点击仍在列表中的 `browser_*` 卡片会打开详情并聚焦该标签页，且不改变 Dock 可见性。标签页已消失时仍只打开详情。普通工具行仍然没有详情入口。

## 测试

`packages/client/ui-conversation/tests/browser-tab-focus.client.spec.ts` 锁定 args 与 result 身份、列表修订号、标签页已消失，以及被拒绝的 focus。`apply-inject.client.spec.tsx` 锁定 inject 层 focus。`packages/client/ui-tool/tests/toolview-slot.client.spec.tsx` 通过 conversation+tool 栈点击真实的 `browser_navigate` 卡片，并要求 `focus(sessionId, target, listedRevision)`。无密钥 fixture Session 仍只有一个标签页，因此组装后的快照无法覆盖双标签页的对话选择。
