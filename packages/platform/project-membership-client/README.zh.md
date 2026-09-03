# `@deepseek-ai/dsh-project-membership-client`

[English](README.md) | 中文

面向 Project Membership 的浏览器客户端，走 HTTP Consumer 的 `/v1/projects` 路由。`ProjectMembershipHttpTransport` 把云项目创建、按规范化 remote 恢复当前 Account 的 Project、带在线状态的成员名册读取、presence 心跳与最后窗口关闭、按 GitHub 登录名发出并指定授予角色的邀请、邀请决定、撤回、含该角色的可信被邀方卡片、按 Project 读取的权威已发出待确认邀请，以及成员角色、职能标签与移除管理，映射到线上契约。创建与 remote 恢复会在 Project 旁返回已鉴权 Account id，让 Desktop 组合可以持久化精确本地绑定而不暴露凭据。`projectByRemote` 把 HTTP 204 与生产环境的 HTTP 404 视为未绑定，而不是传输失败。`pendingInvitations` 把 HTTP 204 与生产环境的 HTTP 404 视为空列表。每次请求携带调用方提供的 Account 会话 presentation 头，且不会暴露安装签名私钥。失败应答保留稳定信封：传输层解析 `{ error: { code, message } }`，以携带领域码与 HTTP 状态码的 `ProjectMembershipClientError` 拒绝，403 角色门槛呈现为 `ROLE_REQUIRED`/403；非 JSON 的代理失败回退为 `HTTP_<状态码>`。所有成功载荷先从 `unknown` 解析，再交给 UI。`ProjectMembershipClient` 是无凭据参数的操作接口，由 Desktop 拥有的已鉴权适配器提供给 renderer 消费方。

## Model Experience

None，传输层从不贡献模型可见状态。

#### KV Cache effect

None。

## Known Limitations and Deferred Work

- 本地 Git 检查、clone、Workspace 注册与 Account/Project 绑定仍由 Host 和 UI 组合负责。
