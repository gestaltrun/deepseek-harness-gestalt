# `@deepseek-ai/dsh-project-membership-desktop`

[English](README.md) | 中文

供 agent preset 使用的 Desktop 专属 Web Host 已鉴权 Project Membership 读取提供方。Electron 保留 Platform Account 会话和安装证明；本包从仅属主可读的文件读取 bearer token，并调用受 token 保护的 loopback 投影，以获取当前公开 Account 身份、与 Agent Workspace 绑定的云端 Project，以及带公开展示字段的完整成员名册。它提供 `ctx.desktopProjectMembership`，且不会把 Platform 凭据放入 Web Host、模型工具参数或 Session log。

## 配置

- `baseUrl` — Desktop Host 发布的绝对 loopback HTTP origin。非 loopback、非 HTTP 或携带路径的值会在加载时失败。
- `tokenFile` — Desktop 持有的 bearer-token 文件路径。本包每次请求都重新读取该文件，使 Desktop 可以替换 bridge 而不会保留过期凭据。

`currentAccount()` 不依赖 Workspace，并从当前 Installation Account 取样。`context(agent)` 要求 Agent 不可变 Session `cwd`，并返回已登录 Account 及按该 Workspace 规范化 Git remote 找到的 Project；无 origin 且 `ctx.workspaceRegistry` 能命名该 cwd 时，改用 `local://workspace/<id>`。`roster(actor, projectId)` 要求 actor 与当前 Desktop Account 一致，并为 `present(view)` 保留公开身份与在线状态装饰。`present(view)` 只接受同一服务实例返回的原始 `RosterView` 对象，防止把一次名册读取的装饰附到另一次读取上。`questionRoute(agent, addresseeLogin, originSessionTitle)` 只读取一次当前名册，并且仅当该名册的公开 GitHub 登录名与收件人大小写不敏感匹配时才返回绑定 Project、匹配到的 Account id 与已鉴权 Account 来源；成员缺失或注入 Account id 时不返回路由。可选取消信号会传递到 loopback fetch 以及 Desktop 持有的 Git 和 Platform 读取。

所有响应都从 `unknown` 解析。HTTP 失败、Account 状态缺失、身份或名册字段异常、Workspace 未绑定以及 Account 不在所属 Project 中都会失败，不会虚构身份或 Project。

## Model Experience

通过 `@deepseek-ai/dsh-tool-project-members` 的名册结果和 `@deepseek-ai/dsh-tool-ask-user` 的成员提问来源字段间接进入模型上下文。

#### KV Cache effect

本提供方不增加独立请求前缀；消费方拥有 schema，并且只在相应工具运行时追加由本提供方解析的值。

## Known Limitations and Deferred Work

- **依赖 Desktop Host** — 纯浏览器 `dsh web` 没有 Account proof owner 或 loopback 投影，因此标准 preset 会在那里省略 `project_members` 与成员定向资格。
- **bridge 只读** — Project 创建、邀请、角色、标签与移除仍由 renderer 经 Desktop 执行，不向 agent preset 暴露。
