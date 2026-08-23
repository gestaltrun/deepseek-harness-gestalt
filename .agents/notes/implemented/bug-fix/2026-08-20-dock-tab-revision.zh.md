# Agent Note: Dock 变更使用被操作标签页的修订号

Status: implemented

[English](2026-08-20-dock-tab-revision.md) | 中文

## 问题

Browser Runtime 写入要求被操作标签页的 `expectedRevision`，不匹配则以 `BROWSER_REVISION_CONFLICT` 拒绝。Dock 与收起预览只观察活动标签页，然后把该页面的修订号随每个标签页的 `focus` 与 `close` 一并发送。各标签页独立导航后修订号会分叉，因此对后台标签页的手势几乎总会冲突。

## 决策

`BrowserWorkspaceTabRecord` 携带 Binder 为该标签页提交的最近一次 Runtime 修订号。`create`、`navigate`、`focus`、`input`、`takeover`、`returnControl`、对未关闭标签页的 `observe`，以及对已持有且未关闭标签页的 `browser/runtime-state`，会把该修订号持久化到 `browser/workspace` 快照。对已关闭标签页的 `observe` 会遗忘该行。Dock 与预览在 `focus` 与 `close` 时发送被操作列表行的 `revision`。对话里选中 `browser_*` 工具行时发送同一份列表修订号（[对话浏览器工具聚焦](../feature/2026-08-20-chat-browser-tool-focus-dock.md)）。它们不会观察每一个标签页。刷新、接管与交还智能体仍使用观察到的页面修订号，那是这些动词所针对的活动标签页的当前修订号。刷新会在 navigate 前立即观察，因此不会复用同一标签页更早一次 observe 留下的过期 `about:blank` URL。

该列表是 Session 状态，不是新的模型可见输入。已记录的 Workspace 快照仍不进入派生模型历史。`browserWorkspace` 投影使用 `stateVersion` 2，因此不含每标签页修订号的缓存行会被丢弃。

这扩展了 [Session 持有的 Browser Workspace Agent Note](../feature/2026-08-19-session-browser-workspace.md) 中的 Session 持有列表，以及 [原生 Browser Dock Agent Note](../feature/2026-08-19-browser-dock.md) 中的 Dock chrome。Runtime 内部前进与对已关闭标签页的 observe 遗忘由 [Dock 列表过期 Agent Note](2026-08-20-dock-listing-stale.md) 持有。修订号锁本身仍由 [浏览器控制权仲裁 Agent Note](../feature/2026-08-19-browser-control-arbitration.md) 持有。

## 考虑过的替代方案

**让 Dock 观察每一个标签页。** 否决，因为 Workspace 列表已经能寻址 chrome 可点击的每个标签页，而且 N 次 observe RPC 也无法在 Session 切换后恢复修订号。

**先观察被点击的标签页，再变更。** 否决，因为点击在重新加载后仍需要权威修订号，而 Binder 在每次变更时已经看到该修订号。第二次 observe 是重复列表的额外 RPC。

**只把修订号留在 Dock 的 React 状态里。** 否决，因为 Session 切换与重新加载必须恢复同一个 `expectedRevision`；Dock 内存不是 Session 事实。

## 后果

推进修订号的变更会写入 `browser/workspace`。无密钥 fixture Session 仍只有一个标签页，因此组装后的快照无法演练双标签页聚焦或关闭。

## 测试

`packages/browser/browser-workspace/tests/workspace.spec.ts` 固定双标签页聚焦与关闭时的列表修订号。`packages/client/ui-browser/tests/model.client.spec.ts` 与 `browser-preview.client.spec.tsx` 断言被操作列表修订号。当该列表修订号前进时重新观察活动标签页，由 [Dock 导航 chrome Agent Note](2026-08-20-dock-navigate-chrome.md) 持有。`apps/web/tests/browser-dock.snapshot.ts` 固定恢复后的预览，以及展开 Dock 在打开与刷新之后的界面。无密钥 headless 的 `browser-runtime` 与 `browser-runtime-tandem` stream-json 快照现在在每条 `browser/workspace` 事件上携带每标签页修订号。
