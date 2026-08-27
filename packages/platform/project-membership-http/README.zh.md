# `@deepseek-ai/dsh-project-membership-http`

[English](README.md) | 中文

`ctx.projectMembership` 的 HTTP 消费方。它注册项目注册表创建路由、花名册读取、邀请签发、以请求体判别的 `accept-with-link`/`decline` 决定、撤回，以及成员角色、功能标签与移除路由。每条路由都是一次成员操作之上的一层薄适配，角色门全部由该操作自己拥有；本消费方不复制任何成员状态。响应禁用缓存；错误使用携带领域错误码的稳定 JSON 信封——成员 `INVALID_*` 返回 400，`ROLE_REQUIRED` 与 `NOT_A_MEMBER` 返回 403，`*_NOT_FOUND` 返回 404，`DUPLICATE_INVITEE`、`PROJECT_NAME_TAKEN`、`INVITATION_NOT_PENDING` 与 `LAST_OWNER` 返回 409，已吊销的账号会话返回 401，账号 `QUOTA`/`PLATFORM_CAPACITY` 返回 429 并附 `Retry-After` 头。必填且非空的 `origins` 配置必须包含账号服务提供方所选的已验证环境 origin；请求体以 64 KiB 为上限，并经 `@deepseek-ai/dsh-host-webserver` 的 JSON 辅助函数解析。

每条路由都从既有账号会话解析操作者：持有人访问令牌加 `x-gestalt-proof-*` 安装证明头，先经 `ctx.platformAccount.current` 验证，再执行成员操作。带参数的路由以 `/v1/projects` 前缀路由的形式注册，未匹配的子路径返回 404。

## 模型体验

无；这些路由由安装 UI 与产品客户端消费。

#### KV Cache 影响

无。

## 已知限制与延后工作

- TLS 终结、限流与部署可观测性归 Platform 边缘所有。
- 本消费方假设 Platform 组合在账号服务旁挂载了唯一的权威成员服务提供方。
