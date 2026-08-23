# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

这是 `ctx.browserRuntime` 的模型 Consumer。它把 `browser_create`、`browser_navigate`、`browser_observe`、`browser_screenshot`、`browser_focus`、`browser_input` 与 `browser_close` 注册为普通延迟工具。`browser_input` 发送 Agent 合成输入，并要求提供非空 URL 或文本。

## 配置

`timeoutMs` 是每次调用的正安全整数协作超时，默认值为 `30000`。无效值会让插件加载失败。Consumer 依赖 Browser Runtime 与工具注册表；禁用 `toolSearch` 时注册会明确失败。当调用 Agent Session 存在且已组合 `ctx.browserWorkspace` 时，操作会把创建的标签页绑定到该 Session。

`tool_search` 返回匹配 schema，但绝不激活工具。eligibility 仍是发现与调度的唯一权威。工具不提供自定义 presenter，因此 Host 客户端沿用与其他普通工具相同的通用 MCP 风格工具卡路径。

## 模型体验

### 浏览器工具发现与结果

#### 模型看到什么

初始工具列表省略全部七个 Browser 工具，并包含普通 `tool_search` schema。搜索浏览器能力会在持久结果中返回精确 schema；后续请求依据当前合资格的 deferred 定义重新验证这些名称。每个操作结果都把 Profile、Workspace、浏览器、标签页、修订号、页面、截图、焦点、关闭、可用性、chrome 与 storage 事实——包括未标注的临时 Profile、保留名共享 Profile，以及携带原因与重连标志的 `unavailable` 状态——完整渲染为 JSON 文本。省略 `browser_create` 的 `profile` 会使用 `ui-browser` 设置页的默认身份；在该页改掉之前，默认仍是共享 Profile。组合 Session Binder 后，省略 attach 会复用匹配保留 Profile 上已打开的浏览器实例。

#### Token 影响

发现会把选中 schema 加入搜索结果与后续请求头。每次操作都会把完整渲染的 JSON 结果加入 Session 历史。

#### KV 缓存影响

首次请求不把较大的 Browser schema 放入前缀。发现会改变下一次请求的工具列表；此后追加式结果在该变化后的前缀之后保留复用。

## 已知限制与后续工作

- Consumer 暴露临时、命名持久与共享 Browser Profile，不添加账号选择器或浏览器专用对话卡片。持久与共享 chrome 是运行时事实，不是 Dock 页眉。Session 本地 Workspace 所有权见 [`dsh-browser-workspace`](../browser-workspace/README.md)。Dock chrome 见 [`dsh-client-ui-browser`](../../client/ui-browser/README.md)。无密钥 Browser Runtime 快照保持不含 Binder，因为它们证明发现与已渲染 Runtime 事实，而不是 Session 隔离。
