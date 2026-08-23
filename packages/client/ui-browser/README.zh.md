# @deepseek-ai/dsh-client-ui-browser

[English](README.md) | 中文

Session 持有的官方 Browser chrome 与收起后的标签页预览。[`dsh-client-ui-workbench`](../ui-workbench/README.md) 直接导入页面 chrome，并把它挂在快照 `browser` 标签里。本插件占用 `conversation.browser.preview`，并注册设置分区 `id: 'browser'`。实时 Workspace 事实通过 `useProjection('browserWorkspace')` 到达；变更走生成的 `remote.browserWorkspace` 命名空间，并从 module table 请求共享的 `api-remotes/client` helper。

收起预览是同一批官方页面的分层摘要。ChatView 把它画在对话滚动区右侧留白，并在该留白窄于 240px 时隐藏。点击后层会带着该标签页在列表中的修订号聚焦它；点击当前层会展开工作台标签。后台标签页上的列表修订号 `BROWSER_REVISION_CONFLICT` 会对该标签页 observe 一次并重试，或展示失败。普通 MCP 工具行仍留在对话历史中。

命名空间 `ui-browser` 下的设置分区 `id: 'browser'` 持有持久 Profile 名册，以及模型或用户省略 `profile` 时 `browser_create` 与侧栏 `+ → 浏览器` 使用的默认创建身份（`shared` / `temporary` / `persistent`）。该页不会创建 Browser Workspace。

行为由 [工作台官方浏览器 Agent Note](../../../.agents/notes/implemented/feature/2026-08-21-workbench-official-browser.md) 与 [Browser Dock Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-browser-dock.md) 规定。

## 模型体验

无，因为这个面向人的 chrome 不增加工具、消息、提示词或 provider 请求；页面操作仍由 `dsh-tool-browser` 负责。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延后工作

- **Desktop 展示 Runtime 窗口；`dsh web` 仍是截图加文本**——`window.dshDesktop.browserPresent` 把同一份官方 `webContents` 贴到 chrome 视口上。设置弹层和侧栏 `+` 菜单挂在该页之上的原生 overlay 视图里；该 overlay 文档不 present 或 conceal 页面。observe 或 navigate 进行中时刷新控件旋转。已提交的 Chromium 网络错误把错误文档留在该实况视口里。浏览器 `dsh web` 没有 Host 窗口，仍画 observe/screenshot 事实。
- **无密钥 web 与 headless Runtime 仍是确定性的**——浏览器 `dsh web` 与 headless 继续使用 `dsh-browser-runtime-deterministic`。Desktop Host 持有进程内 Electron `webContents`，并把叠加层 HTTP 客户端指向该 loopback origin。
- **Profile 设置页不会创建标签页**——该分区只写名册与默认身份。
