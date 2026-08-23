# @deepseek-ai/dsh-client-ui-workbench

[English](README.md) | 中文

与 [`better-sidebar` 快照](../better-sidebar/README.md)平级的本仓适配层。宿主 apply 在命名空间 `dsh-better-sidebar` 尚未注册时加入快照 loader fiber，然后写入 `tabsEnabled.browser: true` 与 `browserInterceptLinks: false`。客户端 half 发布 `workbenchBrowser`，从 module table 请求 `@deepseek-ai/dsh-client-ui-browser/client`，并把每个官方 Workspace 页面绑到一个快照 `browser` 标签。`+ → 浏览器` 再建页面时，由 Browser Workspace 决定是否复用 Profile 匹配的实例；better-sidebar 持有每个 Session 的面板可见状态。Desktop overlay 文档发布该 face，但不调和官方页面。日常产品改动写在这里，不要改快照树。

web-app 组合先插入快照行，再插入本适配层，并保留 `id: ui-browser`。占用关系由 [工作台官方浏览器 Agent Note](../../../.agents/notes/implemented/feature/2026-08-21-workbench-official-browser.md) 规定。

## 模型体验

无，因为本适配层只改快照 prefs 并把官方页面与侧栏标签配对，不注册 prompt、schema、流或工具。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延期工作

- **快照 fs/git/pty 仍走 `/sidebar`** — 本期不把它们迁到官方 `fs` 或 `terminal` 能力缝。
