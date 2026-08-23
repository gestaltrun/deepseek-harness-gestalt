# @deepseek-ai/dsh-client-ui-better-sidebar

[English](README.md) | 中文

[omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的钉死源码快照。宿主半边在 webServer 信任围栏后挂上 `/sidebar` JSON、媒体、HTML 预览、懒加载分块与终端 WebSocket 路由。客户端半边发布 `ctx.betterSidebar`，并绘制右侧栏与底部面板。SHA 与更新步骤见 [UPSTREAM.md](UPSTREAM.md)。本仓持有的改动列在 [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md)。

产品组合挂载本包与 [`dsh-client-ui-workbench`](../ui-workbench/README.zh.md)。适配层启用快照浏览器标签，并发布 [`dsh-client-ui-browser`](../ui-browser/README.zh.md) 的官方 chrome；沙箱 iframe 仍是独立安装时的回退。不要为了改产品行为去改快照源码。

Side Chat 标签页以子会话 id 挂载本仓已声明的 `conversation` slot。因此，标准会话头、已注册的对话/轨迹视图、会话头操作、transcript 与 InputBar 都和主会话复用同一批组件。标签页外壳只保留线程生命周期、切换与提升控制；继承的 seed 事件保持持久化，但不会出现在该子会话自有的 transcript 中。session scope 的 subagent 谱系、schedule 与后台任务都按子会话 id 解析。workbench terminal 标签页仍由自身的 `SessionScope` 确定范围，不会因嵌入式会话而重定向。

## 模型体验

### Side Chat

#### 模型看到的内容

持久化子 Agent 会收到线程打开时捕获的父会话日志，随后是一条带插件来源标记的上下文注入，其中包含侧边对话边界与可选的父会话进行中输出快照。第一次提问位于该注入之后。每次插件激活持有自己的 Side Chat 活跃句柄：卸载会关闭路由准入、等待已接纳调用完成，并释放全部句柄，同时保留持久化历史。

#### Token 影响

子请求包含继承的父会话日志、边界注入与 Side Chat 问题。

#### KV Cache 影响

继承的父会话历史仍是可复用前缀；边界注入与第一次提问从该前缀之后开始分叉。

### 可选终端工具

#### 模型看到的内容

当 Side Card 设置 `agentTerminalTools` 打开时，快照宿主会加入可选的 `terminal_*` 工具 schema。在该设置启用前，这些工具始终不出现。

#### Token 影响

启用该设置会向后续请求加入可选工具 schema。

#### KV Cache 影响

`agentTerminalTools` 关闭时无影响。启用它会使未包含可选工具 schema 的已缓存请求前缀失效。

## 已知限制与延期工作

- **快照仍带 iframe 浏览器实现** — 产品组合通过 `workbenchBrowser` 替换它所渲染的 chrome；独立安装快照时仍使用 iframe。
- **宿主 fs/git/pty 路由是快照自有栈** — 尚未消费本仓的 `fs` 或 `terminal` 能力缝。
- **右侧 overlay 与官方 details Dock 可能同时绘制** — 布局合一延期。
