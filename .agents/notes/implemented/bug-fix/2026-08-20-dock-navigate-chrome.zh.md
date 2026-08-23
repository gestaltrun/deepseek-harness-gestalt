# Agent Note: Dock chrome 跟随 Binder 已提交的 navigate

Status: implemented

[English](2026-08-20-dock-navigate-chrome.md) | 中文

## 问题

Desktop Host 一轮模型调用创建临时标签页并导航到 `https://example.com`（`status: open`，`revision: 1`）之后，Browser Dock 仍停在第一次 `about:blank` observe：标签页标题、地址栏与截图没有跟随 Binder 已提交的页面。智能体已经从工具结果里读到 Example Domain 标题，因此 Runtime 变更成功。刷新复用了过期的 `about:blank` URL 与修订号，地址栏也不更新。

Binder 已经通过 `recordFacts` 写入 navigate 之后的修订号。列表不存储 URL 或标题；Dock 界面从 `observe` 读取这些事实。`useBrowserPage` 只在标签页身份变化时重新观察，因此同一标签页一直保留空白的第一次 observe。这不是 [#184](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/184) 中 Runtime 内部崩溃恢复造成的列表缺口。

## 决策

Dock 与收起预览把活动标签页的列表修订号传入 `useBrowserPage`。该修订号前进时，hook 再次 observe 并截图，然后替换界面。仍为空白的第一个标签页（`about:blank`，列表修订号 `0`）保持空白，直到一次成功的 navigate 推进列表。刷新立即观察 Runtime 页面，再带着该修订号导航到该 URL，因此不会从 React 状态重新加载过期的 `about:blank`。

这扩展了 [原生 Browser Dock Agent Note](../feature/2026-08-19-browser-dock.md) 中的界面，以及 [Dock 标签页修订号 Agent Note](2026-08-20-dock-tab-revision.md) 中的列表修订号约定。

## 考虑过的替代方案

**把 URL 与标题放进 `BrowserWorkspaceTabRecord`。** 否决，因为列表仍只保留身份、控制权所有者与修订号；页面事实继续来自 observe 与 screenshot。

**只把 Dock 的 `refresh` / `navigate` RPC 结果写入 React 状态。** 否决，因为 Agent 的 `browser_navigate` 从不经过 Dock 动词。列表修订号才是这些页面事实已变化的 Session 信号。

**让 Dock 订阅 `browser/runtime-state`。** 本工单否决，因为经 Binder 的 navigate 已经提交列表。没有 Binder 动词的 Runtime 内部修订号前进由 [Dock 列表过期 Agent Note](2026-08-20-dock-listing-stale.md) 持有。

## 后果

活动标签页界面在 navigate 与刷新之后跟踪 Binder 已提交的页面。Runtime 内部修订号前进后的后台标签页列表由 [Dock 列表过期 Agent Note](2026-08-20-dock-listing-stale.md) 持有。刷新在 navigate 前增加一次 observe RPC。

## 测试

`packages/client/ui-browser/tests/browser-page-chrome.client.spec.tsx` 与 `use-browser-page.client.spec.tsx` 会在 `status: open` 的 navigate 推进列表修订号后界面仍停在 `about:blank` 时失败。`packages/client/connection/tests/fixture-browser-workspace.client.spec.ts` 在 navigate 之后观察已提交的 URL。`apps/web/tests/browser-dock.snapshot.ts` 固定展开 Dock 在打开与刷新之后相对 `about:blank` 的界面。
