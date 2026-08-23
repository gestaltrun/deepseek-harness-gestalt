# Agent Note: 通过无状态 Platform Instance 路由已配对 endpoint

Status: implemented

[English](2026-08-18-stateless-two-instance-remote-relay.md) | 中文

## Problem

Mobile 与已配对 Desktop 可能通过同一个 non-sticky endpoint 到达不同 Platform Instance。route id 不能单独成为 attachment 权限，Platform 也不能接收 DSH Session、prompt、approval、model、Workspace 或其他 Companion business value。滚动替换必须在不迁移在线 socket、不保留离线 mutation 的情况下恢复。Desktop 进程生命周期还必须是远程 endpoint 是否在线的事实来源。

## Decision

Remote Access 拥有 `ctx.remoteRelay` capability，并与 [Relay Transport 和加密 Companion protocol](2026-08-18-versioned-remote-protocol.md)分离。`RemoteRelayProvider` 对部署数据无状态。每个实例接收同一组 `RelayRouteStore`、`PersonalPairingAuthorityStore` 与 `RelayCoordinator` 接口、一个不透明的带品牌 instance id，以及显式校验的限制。authority store 原子拥有 Desktop Mobile Access、活跃 route、待撤销 route tombstone 与已确认 Mobile pairing 结果。规范 base64url 编码的 32 字节 Desktop Relay credential 由密码学熵源生成，只返回给 Desktop authority，在持久化前被哈希，并通过单调 route revision 轮换。每个已确认 Mobile pairing 在当前 revision 获得独立 credential，并在 Mobile 观察到确认前封装到其 pairing key。Attach 同时要求 route id 与任一当前 credential。轮换与撤销会扇出不含内容的失效事件，并关闭旧 revision 的本地 attachment。

最小持久 authority 包含 Desktop Installation 关联、活跃或待撤销 route identity、credential digest、单调 revision、撤销状态、已确认 Personal Pairing identity 与封装后的 Mobile Relay authority。它不包含任何 Companion 或 Harness 明文值，也不包含 Desktop credential。Redis coordinator 只拥有临时且会过期的目录条目、直达 instance Pub/Sub 与失效通知。目录条目包含 route 与 attachment id、endpoint 类型、Platform Instance id、防旧清理的 connection token、revision 与 expiry。条件式 Lua refresh 和 unregister 会比较 connection token。Pub/Sub 事件包含有界 Relay 密文 frame、目标 connection token 与 revision。订阅者数量不能证明投递；只有目标 attachment 接纳 frame 后，才会发送由已检查碰撞的不透明 id 关联、有时限且不含内容的 acknowledgement。不使用 Redis Stream、List 或其他离线 queue。

一个精确 WSS Consumer 要求 ciphertext 或 heartbeat 前先收到 attach frame，关闭压缩，执行协议 frame 上限与已校验的 attach timeout，串行处理 frame，并在鉴权之后、目录注册之前刷出 ready，使对端在 endpoint 看到 ready 之前无法 locate 该 attachment。当 deadline、socket 或 Consumer 关闭时，其 lifecycle signal 会取消 route 鉴权与目录注册。Admission 会跨异步鉴权预留容量，并在注册后重新校验，从而关闭 rotation 与 revoke 竞态，也不会越过 provider disposal；因为每个已接纳连接会在最终权威复核前插入本地，所以 invalidation 不需要保留全局 route 历史。目标缺失或过期、instance 没有订阅者、stale target 拒绝、delivery acknowledgement 超时、endpoint 已断开或离线发送都返回 `REMOTE_OFFLINE`；不会保留任何内容等待重放。每实例容量只拒绝新 attachment并返回重试延迟。每目标待写密文字节有上限；超过上限会断开慢消费者。心跳重新校验 credential digest 与 revision、条件式刷新目录，并让停止证明存活的 attachment 过期。所有终止路径都会保留可重试 cleanup tombstone 及其容量，直到 socket、writer、目录、待处理 acknowledgement 与订阅清理成功。

Mobile 与 Desktop 通过部署的单个 non-sticky TLS endpoint 获取出站连接。客户端 socket 执行 wire 上限，并把消息送入同时限制 item 数与字节数的在线 queue；stop 会取消并等待凭据获取与 DNS/TLS 建连。物理 socket 丢失后，会在已校验的延迟后重新获取连接。Desktop 必须提供权威加密 resync callback，并在每次成功 ready acknowledgement 后执行，因此滚动替换通过重建状态恢复，而不迁移在线 socket。endpoint controller 会拒绝错投密文，也从不保留离线 mutation。Desktop 设置只在手机访问开启时启动 Relay；关闭窗口会先排空 Relay，再销毁窗口；sleep、quit、退出账号或关闭手机访问都会停止并排空连接。不存在 daemon、后台 Host 或 remote wake 路径。

Mobile 与 Desktop 产品入口使用的长期 Account、配对与 Relay 监听是 [`examples/local-companion-platform`](../../../../examples/local-companion-platform/README.md)。assembled keyless 场景运行一个真实本地 TLS/WSS listener，由它把连续连接以 non-sticky 方式分配给两个使用共享 coordinator contract 的进程内 Platform backend。公开 Remote Access 操作会启用 Desktop route、确认 pairing、封装独立 Mobile credential，并在任一 endpoint 连接前从另一个 Personal Pairing provider 恢复结果。Mobile 与 Desktop 被刻意分配到不同实例，完成一次加密 Companion round trip；第一个 Personal Pairing provider 在不撤销持久 authority 的情况下被销毁，替换 Desktop Relay 实例后重新连接，并验证 Mobile 解密了 Desktop 权威 revision。随后 replacement provider 关闭共享 authority，route 变为离线。场景还证明离线目标返回 `REMOTE_OFFLINE` 且没有保留密文。另一个 disposable `redis-server` integration 会实际执行 maintained adapter 的 Lua，读取 key TTL 与替代值，验证 stale unregister 无法删除替代连接，并检查不存在 Stream 或 List。场景专用 AES-GCM channel、keyless authority serializer 与测试证书不进入生产。独立 Noise 安全 gate 继续让生产配对与 Relay 激活保持 fail-closed；显式开发 Desktop 与 Mobile 配置可以组装真实 WSS 生命周期，但不会声称拥有产品 Companion crypto provider。

## Alternatives considered

**使用负载均衡 stickiness。** sticky routing 将 instance ownership 隐藏在边缘状态中，也无法在滚动替换后继续成立。共享的会过期目录让每条连接和每个实例都可丢弃。

**使用持久 broker queue。** 排队密文会引入 Remote Companion 不需要的离线投递、保留、重放、删除与产品策略。直达 Pub/Sub 会立即报告在线目标缺失。

**在 Platform 存储 Companion 对象。** 解析或持久化应用值会打破协议分离，并向中心服务暴露 DSH 权限。Platform 只转发已经有界的密文 envelope。

**运行后台 Desktop Host。** daemon 或 remote wake 会让窗口状态产生误导，并增加新的 installation lifecycle。关闭唯一 Desktop 窗口会直接退出进程并让 route 离线。

**集成 proof-local Snow 代码。** transport delivery 不会批准产品密码能力。经评审 provider 仍是独立 gate，可执行验收场景继续明确保持 keyless。

## Consequences

两个 Platform Instance 可以在没有连接亲和性的情况下共享一个 endpoint，滚动替换只会丢失临时 socket。实例 disposal 不会撤销已确认 pairing 或 route authority；显式 disable 会把活跃 route 移入持久撤销 tombstone，之后的 enable 使用 replacement route，旧 cleanup 无法删除它。route id 仍是非 secret locator，credential 轮换与撤销具有跨实例效果，coordinator 无法检查 Companion business value。代价是每次实例丢失后 endpoint 都必须重连且 Desktop 必须 resync；离线 Mobile 工作会立即失败，只能由未来显式产品动作重试，而不能依赖基础设施重放。云供应、生产 TLS 证书与边缘配置、Redis 可用性与经评审产品密码 provider 仍是部署工作，不是本仓库声称已交付的能力。生产监听通过 [`PostgresPersonalPairingAuthorityStore`](../../../../apps/platform/src/postgres-pairing-store.ts) 与 [`PostgresRelayRouteStore`](../../../../apps/platform/src/postgres-route-store.ts) 迁移 PostgreSQL pairing-authority 和 route-store 表；在该 handshake 获准之前，不挂载配对 HTTP 和 Relay WSS。
