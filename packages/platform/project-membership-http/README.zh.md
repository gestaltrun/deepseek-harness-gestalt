# `@deepseek-ai/dsh-project-membership-http`

[English](README.md) | 中文

`ctx.projectMembership` 的 HTTP 消费方。它注册 Project 创建、按规范化 remote 恢复当前 Account 的 Project、花名册读取、邀请签发、权威的被邀方与按 Project 划分的邀请方待确认读取、以请求体判别的 `accept-with-link`/`decline` 决定、撤回、成员角色、功能标签与移除路由，以及安装级 presence 心跳与关闭。创建与 remote 恢复会附带已鉴权 Account id；邀请 presentation 只并入公开 GitHub 登录名与授予角色。签发请求携带 `grantedRole`，授予门由成员操作自己拥有。每条路由都是一次成员操作之上的一层薄适配，角色门全部由该操作自己拥有；本消费方不复制任何成员状态。响应禁用缓存；错误使用携带领域错误码的稳定 JSON 信封——成员 `INVALID_*` 返回 400，`ROLE_REQUIRED` 与 `NOT_A_MEMBER` 返回 403，`*_NOT_FOUND` 返回 404，`DUPLICATE_INVITEE`、`PROJECT_NAME_TAKEN`、`PROJECT_REMOTE_TAKEN`、`INVITATION_NOT_PENDING` 与 `LAST_OWNER` 返回 409，已吊销的账号会话返回 401，账号 `QUOTA`/`PLATFORM_CAPACITY` 返回 429 并附 `Retry-After` 头。必填且非空的 `origins` 配置必须包含账号服务提供方所选的已验证环境 origin；请求体以 64 KiB 为上限，并经 `@deepseek-ai/dsh-host-webserver` 的 JSON 辅助函数解析。

每条路由都从既有账号会话解析操作者：持有人访问令牌加 `x-gestalt-proof-*` 安装证明头，经 `ctx.platformAccount.current` 验证，共享的 `/v1/projects/presence` 前缀处理函数为心跳与关闭都经 `currentInstallation` 解析安装身份。带参数的路由以 `/v1/projects` 前缀路由的形式注册，未匹配的子路径返回 404。

Presence 由心跳注册且只看活性。同一个 `/v1/projects/presence` 前缀处理函数同时拥有 `POST /v1/projects/presence/heartbeat` 与 `POST /v1/projects/presence/close`。已认证的桌面安装按 `presenceHeartbeatIntervalMs` 节奏（默认 60 秒；其他安装种类返回 `403 INSTALLATION_KIND_UNSUPPORTED`）调用心跳，每次心跳在 `presenceTtlMs`（默认 90 秒）内保持有效，关闭会立即清除该安装，使花名册读者不必等待 TTL 即可看到 Offline。TTL 过期仍是崩溃与分区路径。只要成员任一安装持有有效心跳即为 `online`。花名册读取为每个成员附上该 `presence` 判定，并在同一次批量读取中并入成员的公开身份：`displayName` 为当前公开 GitHub 登录名，`avatarRef` 为当前公开头像 URL；账号平面未知的账户两者留空。没有手动状态，也没有空闲推断。

presence 条目存于进程内 TTL 映射，背后是预留的 `PresenceStore` 适配接口（`record`、`clear`、`onlineAccountIds`）；跨 Platform 实例保持 presence 一致的共享存储属于延后的部署工作，而非服务变更。

## 模型体验

无；这些路由由安装 UI 与产品客户端消费。

#### KV Cache 影响

无。

## 已知限制与延后工作

- TLS 终结、限流与部署可观测性归 Platform 边缘所有。
- 本消费方假设 Platform 组合在账号服务旁挂载了唯一的权威成员服务提供方。
- presence 条目是进程内的；多实例部署需要实现 `PresenceStore` 的共享 TTL 存储（例如 Redis）后，presence 才能跨 Platform 实例保持一致。
