# @deepseek-ai/dsh-client-ui-better-sidebar

[English](README.md) | 中文

[omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的钉死源码快照。宿主半边在 webServer 信任围栏后挂上 `/sidebar` JSON、媒体、HTML 预览、懒加载分块与终端 WebSocket 路由。客户端半边发布 `ctx.betterSidebar`，并绘制右侧栏与底部面板。SHA 与更新步骤见 [UPSTREAM.md](UPSTREAM.md)。本仓持有的改动列在 [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md)。

产品组合挂载本包与 [`dsh-client-ui-workbench`](../ui-workbench/README.zh.md)。适配层启用快照浏览器标签，并发布 [`dsh-client-ui-browser`](../ui-browser/README.zh.md) 的官方 chrome；沙箱 iframe 仍是独立安装时的回退。不要为了改产品行为去改快照源码。

## 模型体验

间接，通过快照宿主在 Side Card 设置 `agentTerminalTools` 打开时可选注册的 `terminal_*` 工具。这些工具由本快照的宿主半边持有，在该设置打开之前保持关闭。

#### KV Cache 影响

`agentTerminalTools` 关闭时无影响。打开后会把工具 schema 加入后续请求，并使未包含它们的前缀失效。

## 已知限制与延期工作

- **快照仍带 iframe 浏览器实现** — 产品组合通过 `workbenchBrowser` 替换它所渲染的 chrome；独立安装快照时仍使用 iframe。
- **宿主 fs/git/pty 路由是快照自有栈** — 尚未消费本仓的 `fs` 或 `terminal` 能力缝。
- **右侧 overlay 与官方 details Dock 可能同时绘制** — 布局合一延期。
