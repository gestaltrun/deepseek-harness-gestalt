# Agent Note: 成员 presence 聚合经认证的安装心跳

Status: implemented

[English](2026-08-28-member-presence-heartbeats.md) | 中文

## Problem

项目注册表 HTTP 面的花名册读取必须附上每个成员的 presence，而语义早已固定：presence 只由连接活性推导，见[项目成员权威 Agent Note](2026-08-27-project-membership-core.zh.md)。Platform 实际上没有可聚合的通用安装级活性来源。Relay 共享目录条目虽是 TTL 形状，却只在 Mobile Access 附件存活时存在，回答的是单一功能的附件活性，而非成员 presence。账号会话记录无论安装是否运行都可授权长达三十天，`trackConnection` 回答的是"在本实例上持有套接字"——进程内，且今天没有任何 Desktop 面持有长连的 Platform 连接。聚合其中任何一个都会把过期的授权当成 presence 呈现。

## Decision

`project-membership-http` 拥有一个心跳注册表。`POST /v1/projects/presence/heartbeat` 经既有账号会话证明完成鉴权，并经 `currentInstallation` 解析安装身份，然后记录 `(accountId, installationId)` 及其新过期时间。Desktop 按 `presenceHeartbeatIntervalMs` 节奏（Config 默认 60 秒）调用；每次心跳在 `presenceTtlMs`（Config 默认 90 秒）内保持有效，TTL 不大于间隔时组合加载即失败出声。花名册读取按账户合并存活条目，为每个成员附上 `presence: 'online' | 'offline'`；过期是离线的唯一途径——没有手动状态，没有空闲推断，也没有 TTL 之外的宽限窗口。每条路由读取的会话表示——bearer 访问令牌加 `x-gestalt-proof-*` 安装证明头——统一来自 Account HTTP 消费者导出的 `accountSessionPresentation`，让 Account-over-HTTP 会话格式在其各消费者间只保留一份实现。

存储是 `PresenceStore` 预留接口（`record`、`onlineAccountIds`）背后的进程内 TTL 映射。运行多个 Platform 实例的部署以共享 TTL 存储实现该适配接口；注册表、路由与花名册投影均不改变。

## Supersession check

[项目成员权威 Agent Note](2026-08-27-project-membership-core.zh.md)未被取代：本 Note 记录的是其既有语义之下的聚合机制。有一个时间性事实由本机制界定——心跳是周期性的，离线发生在最后一次心跳的 TTL 过期时刻，而非安装停止通信的瞬间；旧 Note 的只看活性判定、其被拒绝的空闲推断备选，以及无队列投递立场全部继续成立。

## Alternatives considered

**聚合 Relay 共享目录。** 拒绝：这些条目只在 Mobile Access 启用时存在，既不覆盖 Desktop presence，也不覆盖关闭 Mobile Access 的部署。

**从账号会话记录推导 presence。** 拒绝：会话的刷新授权与安装是否运行无关，长达三十天，每个成员都会显示在线。

**从 `trackConnection` 推导 presence。** 拒绝：它回答的是哪些会话在一个实例上持有套接字，今天没有任何 Desktop 持有此类套接字，且其注册表在失效时关闭而非随活性过期。

**要求每个 Desktop 持有常驻 presence 套接字。** 在本面上拒绝：它把 presence 绑定到协作面并不需要的长连接，而周期性的认证调用复用了每条路由本就信任的会话证明路径。

## Consequences

在共享 `PresenceStore` 落地前，presence 是实例内的；README 已知限制承载该部署条件。停止心跳的成员会在一个间隔加一个 TTL 内显示离线——网络分区与休眠的笔记本呈现为离线，这正是"我现在能否把一个决定交给这个人"的诚实答案。注册表测试直接驱动假时钟，HTTP 过期测试以短 TTL 跑在真实 TCP 上，因此没有任何测试对着 90 秒默认值睡眠。
