# Agent Note: Dock 列表跟随 Runtime 内部修订号前进

Status: implemented

[English](2026-08-20-dock-listing-stale.md) | 中文

## 问题

Dock 与预览发送的是 `BrowserWorkspaceTabRecord` 上被操作标签页的列表修订号。Binder 只在经 Binder 的变更上写入该记录，Runtime 内部的修订号前进不会写入：Electron 崩溃恢复会提交 `unavailable`（+1）、`reconnect`（+1）或 `reconnect-failed`，且不经过任何 Binder 动词。后台标签页恢复后，其列表修订号一直过期，Runtime 以 `BROWSER_REVISION_CONFLICT` 拒绝，而标签页在调用 focus 或 close 时不捕获该拒绝。

Binder 对已关闭标签页的 `observe` 也会留下列表行，因此幽灵标签页的关闭会持续冲突。

## 决策

Binder 监听 `browser/runtime-state`，并对已持有且未关闭的标签页 `recordFacts`，使内部前进进入列表。已关闭的 Runtime-state 通知不写入事实；对已关闭标签页的 `observe` 会遗忘该行，因此幽灵标签页会消失。

Dock 与预览把列表行上的 `BROWSER_REVISION_CONFLICT` 视为可恢复：对该标签页 observe 一次，并用观察到的修订号重试；若失败不是冲突，或重试仍失败，则展示 `dock.actionFailed`。observe 到已关闭时不重试，因为 Binder 已经遗忘该行。列表修订号前进时重新观察活动标签页界面，仍由 [Dock 导航 chrome Agent Note](2026-08-20-dock-navigate-chrome.zh.md) 持有；本决策持有后台标签页与修订号冲突恢复。

这扩展了 [Dock 标签页修订号 Agent Note](2026-08-20-dock-tab-revision.zh.md) 中的列表。

## 考虑过的替代方案

**让 Dock 订阅 `browser/runtime-state`。** 否决，因为列表已是每个标签页都在读的 Session 事实，且只有 Binder 能在重新加载后恢复该写入。

**在对已关闭标签页的 observe 之后保留幽灵行。** 否决，因为关闭会持续遇到 `BROWSER_REVISION_CONFLICT`，也没有其他动词能移除该行。

**吞掉失败的重试。** 否决，因为静默失效的按钮就是原先的缺陷。

## 后果

Runtime 内部前进会在没有 Binder 动词的情况下写入 `browser/workspace`。对已关闭标签页的 observe 现在会破坏列表。网关仍把 `BrowserRuntimeError` 映射为 `internal`；恢复匹配稳定 code 或 `message` 上的 `revision conflict` 措辞。无密钥 fixture Session 仍只有一个标签页，因此组装后的 Dock 快照无法演练双标签页修订号冲突。

## 测试

`packages/browser/browser-workspace/tests/workspace.spec.ts` 固定 Runtime 内部 navigate 进入列表、该前进之后成功的列表聚焦/关闭、对已关闭与未持有 target 的 Runtime-state 过滤，以及对已关闭标签页的 observe 遗忘幽灵行。`packages/client/ui-browser/tests/listed-mutation.client.spec.ts`、`browser-dock.client.spec.tsx` 与 `browser-preview.client.spec.tsx` 固定 observe 一次后重试，以及恢复失败时的可见提示。
