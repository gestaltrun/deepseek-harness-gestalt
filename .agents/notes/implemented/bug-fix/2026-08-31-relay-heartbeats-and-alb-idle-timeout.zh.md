# Agent Note: 保持 ALB Idle Timeout 大于 Relay 存活窗口

Status: implemented

[English](2026-08-31-relay-heartbeats-and-alb-idle-timeout.md) | 中文

## Problem

Desktop 与 Mobile Relay 端点会在 Platform heartbeat timeout 前发送已鉴别 heartbeat。如果 ALB listener 的 idle timeout 更短，它会在任一端点发送下一次 heartbeat 前关闭健康的 WebSocket attachment，造成不必要的重连与短暂 presence 丢失。该部署不匹配独立于并发配对语义，不能解释 #371 已修复的共享目录缺陷。

## Decision

生产部署通过 `PLATFORM_ALB_LISTENER_ID` 指定准确的 HTTPS listener。部署校验通过阿里云 OIDC 读取该 listener，并要求 `IdleTimeout * 1000` 至少等于 `PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS`，candidate 才能进入任一 ECS host。

实际运行的 listener 使用 60 秒 idle timeout，Platform heartbeat timeout 为 45 秒。端点发布继续使用 30 秒已鉴别 heartbeat interval。

## Alternatives considered

**发布更短的 Desktop 与 Mobile heartbeat interval。** 更短的 interval 可以保持现有 listener 活跃，但需要协调客户端发布，并增加稳定网络流量。listener 必须容纳每个已经满足 Platform 存活要求的客户端。

**发送服务端 WebSocket ping frame。** 传输级 ping 可以保持中间层活跃，但会在已鉴别端点 heartbeat 之外增加另一套存活机制。现有 heartbeat timeout 已经定义中间层必须提供的存活时长。

**把 listener 设置保留为运维检查项。** 手动设置可以在仓库证据不变时漂移。生产替换开始前，部署 preflight 会拒绝不兼容的 listener。

## Consequences

Platform 部署除了既有 ECS 与 server group 读取外，还需要读取一个已配置的 ALB listener。listener timeout 小于已鉴别 Relay 存活窗口时，校验会失败，并且不会修改 ECS、server group、DNS、证书或 WAF 状态。

## Testing

生产环境测试要求 listener id、校验其标识，并检查 workflow 中 HTTPS 协议与 heartbeat timeout 比较。[#499](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/499) 负责该部署修正。[#368](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/368) 保留独立的双 Mobile 组装验收证据。
