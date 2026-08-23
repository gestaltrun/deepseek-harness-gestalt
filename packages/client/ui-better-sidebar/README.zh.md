# @deepseek-ai/dsh-client-ui-better-sidebar

[English](README.md) | 中文

[omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的钉死源码快照。宿主半边在 webServer 信任围栏后挂上 `/sidebar` JSON、媒体、HTML 预览、懒加载分块与终端 WebSocket 路由。客户端半边发布 `ctx.betterSidebar`，并绘制右侧栏与底部面板。SHA 与更新步骤见 [UPSTREAM.md](UPSTREAM.md)。本仓持有的改动列在 [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md)。

产品组合挂载本包与 [`dsh-client-ui-workbench`](../ui-workbench/README.zh.md)。适配层启用快照浏览器标签，并发布 [`dsh-client-ui-browser`](../ui-browser/README.zh.md) 的官方 chrome；沙箱 iframe 仍是独立安装时的回退。不要为了改产品行为去改快照源码。

Side Chat 标签页以临时子 Session id 挂载本仓已声明的 `conversation` slot。临时行会立即携带保留的 `Side: ` 标题，因此列表分类器与 subagent 自动激活不会把草稿误判为委派任务；其临时标记还会让它在发布前保持在父会话后代计数之外。打开标签页不会创建 Host Session 或 Agent；首次提交消息时才会以该 id 原子创建二者、捕获父会话历史、安装所选模型并准入提示词。因此，已注册的对话/轨迹视图、会话操作、transcript 与 InputBar 都和主会话复用同一批组件。标签页外壳只持有子会话创建与生命周期，不提供标签页内的线程切换、新建或提升工具栏。其准入适配器持有提示词、取消、queue/steer、权限、skill catalog 与模型路由，通用 Session RPC 因而不会绕过 subagent 归属。权限变更同时应用到父会话与已发布子会话；临时子会话首次准入时继承父会话选择的权限。Side Chat 会话头省略 Session 标题、面包屑导航与 agent preset 标签，同时保留视图标签页、当前 Side Chat 的下级目录，以及按子会话确定范围的 schedule 和后台任务。选择下级会重定向同一个 Side Chat 标签页，而不会改变外壳选中的 Session；标签页会保留根 child id，以便关闭时仍释放归属方持有的在线句柄。头部操作紧随「轨迹」，任务弹层通过 viewport portal 向左展开，避免被窄侧栏裁切。继承的 seed 事件保持持久化，但不会出现在该子会话自有的 transcript 中。workbench terminal 标签页仍由自身的 `SessionScope` 确定范围，不会因嵌入式会话而重定向。

## 模型体验

### Side Chat

#### 模型看到的内容

持久化子 Agent 会收到首次提交问题时捕获的父会话日志，随后是一条带插件来源标记的上下文注入，其中包含侧边对话边界与可选的父会话进行中输出快照。第一次提问在同一次准入中位于该注入之后。每次插件激活持有自己的 Side Chat 活跃句柄：卸载会关闭路由准入、等待已接纳调用完成，并释放全部句柄，同时保留持久化历史。

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
