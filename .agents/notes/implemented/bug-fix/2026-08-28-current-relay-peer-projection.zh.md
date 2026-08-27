# Agent Note: 从当前共享目录投影 Relay Peer

Status: implemented

[English](2026-08-28-current-relay-peer-projection.md) | 中文

## Problem

一条 Desktop route 可以承载多台独立配对的 Mobile 设备，每项配对分别拥有 Desktop Relay attachment。并发登记和移除 attachment 时，不同 Platform Instance 发布完整 peer 快照的到达顺序可能不同于生成快照的目录变更顺序。延迟快照因此可能移除 Mobile 当前的 Desktop peer，直到另一次 route 变化发布替换快照。配对 presence 由独立 lease 投影，仍会显示在线，因此 Desktop Settings 可能与受影响 Mobile 的状态不一致。

## Decision

跨实例 `peer-update` 消息是目录变化通知，而不是权威 peer 快照。接收端 Relay provider 校验目标连接 token 与 route revision 后，会列出当前共享 route 目录，并在投递前立即派生目标专属的 peer 投影。配对 selector 继续把每台 Mobile 与同一路由上的其他 Desktop 配对 attachment 隔离。

发布的消息保留协调适配器使用的有界 Relay 协议字段，其中携带的 peer 列表不会成为端点状态。共享目录读取失败时，不投递这份可能陈旧的列表。

## Alternatives considered

**依赖 Redis Pub/Sub 顺序。** Redis 保证单一发布者的消息顺序，但并发 Platform Instance 可以分别列出并发布同一 route。各发布者内部的顺序无法建立全 route 的快照顺序。

**增加全 route 的 peer 投影序列。** 序列需要一个原子拥有目录变更与发布的所有者，或增加一份共享排序记录。从当前目录投影会复用既有目录 authority，避免引入第二套一致性机制。

**活跃 channel 忽略空 peer update。** Desktop 真正断开时必须立即移除 peer。依据旧快照保留活跃 channel 会把密文路由到已不存在的 attachment，并错误表达 mutation authority。

## Consequences

并发 Mobile 设备保持相互独立：打开或关闭一项配对，不能让另一项配对消费更早的 peer 快照。每次跨实例 peer 通知都会在接收实例增加一次有界共享目录 list operation。目录不可用时会失败关闭，不保留离线队列或陈旧端点投影。

## Testing

Relay 覆盖会安装当前按配对划分的 Desktop 条目，再投递一条包含空 peer 列表的同 revision 延迟通知，并要求 Mobile 目标仍收到共享目录中存在的 Desktop peer。既有 Relay 覆盖继续验证 selector 隔离、替换 generation、close update、revision 失效、直达密文投递与独立 presence lease。
