# Agent Note: 双实例 Remote Relay 的组装级验收

Status: implemented

[English](2026-08-19-two-instance-routing-assembled-acceptance.md) | 中文

## Problem

Issue #32 要求 Mobile 与已配对 Desktop 即使分别接到不同的 Platform Instance，也能通过出站连接进入 Remote Online。Relay 切片——`RemoteRelayProvider`、WSS Consumer、Redis 协调以及 Desktop/Mobile endpoint 生命周期——已在 mobile-companion 基线就位，并有一个用手搭两个同进程后端的无密钥示例。工单仍缺的是组装级证据：两个 Loader 启动的 Platform Instance 组合共享测试用持久适配器与 Redis 适配器，经一个 non-sticky TLS 监听器走到已发布的 `WebServer` upgrade 路由接入两端，拒绝没有当前凭据的 route id，只转发有界密文，在实例丢失后 resynchronize，并因 Desktop 窗口生命周期进入 Remote Offline。

## Decision

不改动任何生产接缝，在 HTTP/WSS Consumer 上补一条 REAL 组合验收测试：

`packages/platform/remote-access-http/tests/two-instance-assembled.spec.ts` 启动两个同进程 Loader 组合。每个组合挂载 `WebServer`、`PersonalPairingProvider`、`RemoteRelayProvider`、个人配对 HTTP 与已发布的 Relay WSS Consumer。两个组合共享 `MemoryPersonalPairingAuthorityStore`、内存 `RelayRouteStore`，以及一条测试 Redis 总线上的 `RedisRelayCoordinator`。本地 TLS 监听器终止 TLS 后，把每次 HTTP Upgrade 代理到 `127.0.0.1:${instance.port}`，因此 attach 走 `webServer.registerUpgrade`。Desktop 在实例 A 开启手机访问并确认配对；Mobile 从实例 B 读取封装后的授权。仅凭 route id 与非当前凭据 attach，在 TLS endpoint 和对实例 A 已发布路由的直接 `ws:` attach 上都会返回 `RELAY_ATTACHMENT_REJECTED`。随后 Mobile 与 Desktop 经 TLS endpoint attach，完成一次 AES-GCM Companion 往返，且已发布的协调 frame 解码为 `ciphertext`、其载荷不是含该 prompt 的 Companion JSON；在销毁 Desktop 所在组合后以 Desktop 权威 resynchronization 恢复；并在 window-close、sleep、关闭手机访问与 quit 之后观察到 `REMOTE_OFFLINE`。记录的 `set`/`eval` 值不含密文 frame；Redis mock 对 List 与 Stream API 抛错。

阿里云 TLS 负载均衡、托管 PostgreSQL/Redis/OSS、公网 DNS、在 `apps/platform` 挂载 Remote Relay、经过评审的产品密码，以及工单 #38 的 blob 传输仍是部署证据。测试适配器只代替这些存储，并不声称生产数据平面。

## Alternatives considered

**把既有 `examples/two-instance-relay` 快照当作充分证据。** 否决：该场景只启动一个 Loader 插件，再用手构造两个后端，并把 upgrade 交给私自构造的 WSS Consumer，因此不会执行两个 Platform Instance 组合，也不会走到已发布的 `WebServer` upgrade 路径。

**把 TLS socket 交给第二个 `RelayWebSocketConsumer`。** 否决：删掉 Loader 的 `registerUpgrade` 后往返仍会绿。TLS 前端必须把 HTTP Upgrade 代理到实例端口。

**用两个子进程对接一次性 `redis-server` 与 PostgreSQL。** 暂缓：CI 不安装这些二进制，Redis 适配器已有 skipIf 集成，而共享的同进程测试适配器能让组装路径保持无密钥且始终可跑。

**在 `apps/platform` 生产启动中挂载 Remote Relay。** 本工单否决：该镜像仍未挂载远程访问，证明 Consumer 与提供方组合也不需要改生产接线。

## Consequences

Issue #32 的可本地运行标准在本基线上有了已执行证据：两个同进程 Loader 组合、一个走到已发布 WSS upgrade 路由的 non-sticky TLS endpoint、凭据门禁的 attach、解码后只含密文的跨实例转发、实例退出后的重连与 Desktop 权威 resynchronization、由 Desktop 窗口生命周期产生的 Remote Offline，以及 `set`/`eval` 不保留密文且禁止 List/Stream API。生产 `apps/platform` 启动、云 TLS/DNS/证书、托管 PostgreSQL/Redis/OSS、经过评审的产品密码与 #38 blob 仍暂缓。

## Testing

`pnpm exec vitest run packages/platform/remote-access-http/tests/two-instance-assembled.spec.ts`——一条组装用例，针对回环 TLS 上两个同进程 Loader 组合，使用内存配对权限与 route-store 适配器以及测试 Redis coordinator。既有无密钥示例快照与包单元套件仍覆盖更低层。

## Related

- Issue #32（父 spec #27）——把一台已配对 Desktop 路由到两个 Platform Instance。
- [无状态双实例 Remote Relay](../architecture/2026-08-18-stateless-two-instance-remote-relay.zh.md)——本组合所执行的提供方、coordinator 与生命周期决策。
