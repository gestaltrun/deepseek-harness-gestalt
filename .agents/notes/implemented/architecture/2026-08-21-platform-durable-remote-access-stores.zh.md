# Agent Note: Durable Platform Remote Access stores

Status: implemented

[English](2026-08-21-platform-durable-remote-access-stores.md) | 中文

## Problem

两台生产 Platform Instance 位于同一个非粘性 TLS 均衡器后面，并共享 PostgreSQL。配对 challenge、已确认的 Mobile 权威和 Relay credential digest 不能只放在进程内存里，否则一台主机上的 Desktop 启用对另一台主机上的 Mobile 完成不可见。在通过已评审的 Noise handshake 之前，生产监听进程也不能挂载配对 HTTP 或 Relay WSS。

## Decision

[`launchOperatedPlatform`](../../../../apps/platform/src/launch.ts) 在监听前迁移两个 PostgreSQL 适配器：[`PostgresPersonalPairingAuthorityStore`](../../../../apps/platform/src/postgres-pairing-store.ts) 拥有 Desktop route、已确认 Mobile pairing 结果和独占 pairing-transaction 文档，[`PostgresRelayRouteStore`](../../../../apps/platform/src/postgres-route-store.ts) 拥有哈希后的 Relay credential 与单调 revision。[`pairing-state-codec.ts`](../../../../apps/platform/src/pairing-state-codec.ts) 把独占的 `PersonalPairingTransactionState` Map（含 orphan cleanup 同一性）编码为 jsonb。`runPairingTransaction` 对按 database identity 键控的一行做 `SELECT … FOR UPDATE`，让两个实例串行化同一租约。配对 HTTP 和 Relay WSS 保持未挂载；该监听进程永不选择 `DevelopmentKeylessPairingHandshakeProvider`。

## Alternatives considered

**用开发用 keyless handshake 挂载配对 HTTP 和 Relay WSS。** 否决：在独立 Noise 评审接纳产品 handshake 之前，生产路径保持 fail-closed。keyless 适配器仍只用于开发。

**现在继续用内存 store，等挂载 Relay 再加 PostgreSQL。** 否决：表必须在第一次 enable 或 confirm 跨实例之前就存在，而且监听进程已经拥有 Account 的 PostgreSQL 连接池。

**给每个实例私有的配对数据库。** 否决：非粘性均衡器会把一次 Personal Pairing 生命周期拆到两个权威上。

## Consequences

滚动应用会创建共享表，但不会打开配对或 WSS 路由。之后的挂载可以复用同一组适配器和 Redis coordinator。代价是：在 handshake 获准之前，Desktop 设置和 Mobile 无法完成生产配对。

## Testing

[`apps/platform/tests/pairing-state-codec.spec.ts`](../../../../apps/platform/tests/pairing-state-codec.spec.ts) 与 [`apps/platform/tests/postgres-remote-access-stores.spec.ts`](../../../../apps/platform/tests/postgres-remote-access-stores.spec.ts) 钉住 codec 拒绝、orphan 同一性、Desktop route 保留或替换、Mobile 碰撞、独占事务回滚，以及 route 的 rotate/issue/authorize/revoke。[`product-entry-durable.spec.ts`](../../../../apps/platform/tests/product-entry-durable.spec.ts) 会用临时 PostgreSQL 与 Redis store 驱动可执行入口的 launch composition，覆盖实际运行环境校验与 GitHub OAuth 身份，但不声称已有实际基础设施证据。
