# `@deepseek-ai/dsh-project-membership-client`

[English](README.md) | 中文

面向 Project Membership 的浏览器客户端，走 HTTP Consumer 的 `/v1/projects` 路由。`ProjectMembershipHttpTransport` 把升级操作——云项目创建、带在线状态的成员名册读取、邀请的发出/决定/撤回与被邀方待确认邀请轮询，以及成员角色、职能标签与移除管理——映射到线上契约；每次请求携带调用方提供的 Account 会话凭证头，且不接触安装签名私钥。失败应答保留稳定信封：传输层解析 `{ error: { code, message } }`，以携带领域码与 HTTP 状态码的 `ProjectMembershipClientError` 拒绝，403 角色门槛呈现为 `ROLE_REQUIRED`/403；非 JSON 的代理失败回退为 `HTTP_<状态码>`。所有成功载荷先从 `unknown` 解析，再交给 UI。

## Model Experience

None，传输层从不贡献模型可见状态。

#### KV Cache effect

None。

## Known Limitations and Deferred Work

- GitHub 登录名到账号的解析与工作区 remote 查询由组合层负责；传输层只认账号 ID。
