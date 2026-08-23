# Agent Note: 双实例 Remote Relay 的组装级验收

Status: implemented

[English](2026-08-19-two-instance-routing-assembled-acceptance.md) | 中文

## Problem

Issue #32 要求 Mobile 与 Paired Desktop 即使分别接到不同的 Platform Instance，也能通过出站连接进入 Remote Online。较低层的可运行示例在一个 Loader plugin 内构造两个 Relay 后端，因此不能证明两套独立 Platform／WebServer／HTTP composition 分别发布并服务 WSS upgrade 路由，也不能证明 non-sticky 路由中的逐配对 authority。

## Decision

不改动任何产品接缝，在 HTTP/WSS Consumer 上保留一条 REAL 组合验收测试：

`packages/platform/remote-access-http/tests/two-instance-assembled.spec.ts` 启动两套独立的同进程 Loader composition。每套都挂载 `WebServer`、`PersonalPairingProvider`、`RemoteRelayProvider`、个人配对 HTTP 与已发布的 Relay WSS Consumer。两者共享 `MemoryPersonalPairingAuthorityStore`、内存 `RelayRouteStore`，以及测试 Redis 总线上的一个 `RedisRelayCoordinator`。本地 TLS listener 把每次 HTTP Upgrade 轮流代理到两个实例端口，因此每个 attachment 都经过对应实例的 `webServer.registerUpgrade` owner。两个已认证 Mobile Installation 通过 HTTP 完成端点自有 XKpsk3 mailbox，获得不同的 Snow 密封 Relay authority，以四份不同 P-256 凭据与 attachment id 接入，建立 attachment-bound Snow IK channel，并收到已认证的前台同步。捕获的 Platform HTTP body 与 pairing state 不含实际端点私有凭据字符串。错误凭据在 non-sticky TLS endpoint 和实例直接 WSS 路由上都会被拒绝。释放一个 Platform Instance 会产生新的 attachment generation 与 IK 握手；撤销一项 Personal Pairing 后，另一台手机仍可重连并完成加密 Companion 操作。Redis 不记录密文值，也不暴露 List 或 Stream API。

已运营 TLS 负载均衡、托管 PostgreSQL／Redis、公网 DNS、物理 WKWebView／Android WebView 执行与独立安全评审仍分别需要证据。内存存储、Redis 总线与 localhost 证书使仓库测试保持确定性；它们不声称已运营数据平面或信任链。

## Alternatives considered

**把既有 `examples/two-instance-relay` 快照当作充分证据。** 否决：该场景只启动一个 Loader 插件，再用手构造两个后端，并把 upgrade 交给私自构造的 WSS Consumer，因此不会执行两个 Platform Instance 组合，也不会走到已发布的 `WebServer` upgrade 路径。

**把 TLS socket 交给第二个 `RelayWebSocketConsumer`。** 否决：删掉 Loader 的 `registerUpgrade` 后往返仍会绿。TLS 前端必须把 HTTP Upgrade 代理到实例端口。

**用两个子进程对接一次性 `redis-server` 与 PostgreSQL。** 暂缓：CI 不安装这些二进制，Redis 适配器已有 skipIf 集成，而共享的同进程测试适配器能让组装协议路径始终可跑。

**把已运营 Platform 启动用作仓库测试。** 拒绝：该方式需要部署凭据与基础设施；仓库测试需要对同一套已发布 plugin composition 提供确定性证据，且不能冒充已运营验收。

## Consequences

仓库具有可执行证据，覆盖两套独立 Loader composition、两个已发布 WSS upgrade 路由、端点自有 Snow 配对与重连、两组逐配对凭据和 attachment 身份、仅密文的跨实例转发、新 generation 恢复与独立撤销。该测试只覆盖 composition 与协议行为；已运营 TLS／DNS／数据库、物理 WebView 与独立安全评审仍有各自的证据要求。

## Testing

`pnpm exec vitest run packages/platform/remote-access-http/tests/two-instance-assembled.spec.ts`——一条组装用例，针对回环 TLS 上两套独立 Loader composition，使用内存配对权限与 route-store 适配器以及测试 Redis coordinator。构建后的双实例 Snow 示例与包套件提供较低层和 artifact-plane 证据。

## Related

- Issue #32（父 spec #27）——把一台已配对 Desktop 路由到两个 Platform Instance。
- [无状态双实例 Remote Relay](../architecture/2026-08-18-stateless-two-instance-remote-relay.md)——本组合所执行的提供方、coordinator 与生命周期决策。
