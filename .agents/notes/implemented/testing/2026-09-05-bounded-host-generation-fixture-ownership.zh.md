# Agent Note: 有界 Host 世代 fixture 所有权

Status: implemented

[English](2026-09-05-bounded-host-generation-fixture-ownership.md) | 中文

## Problem

在生产启动接线能够安全落地之前，Desktop 测试基础设施需要先表达 Host 世代的清理所有权。一个世代可能同时持有启动预留、活动租约、重复租约冲突、Host 关闭，以及有界截止时间之后才到达的结算。如果在外部回调之后才发布所有权，或接受调用方选择的权威值，就会产生重入与替换竞态。无界等待会阻止关闭，而通过淘汰实现的重放记忆可能再次接受旧请求。

[Desktop phone Electron 端到端通道](2026-08-31-desktop-phone-electron-e2e-lane.zh.md)会验证已启动进程和可见产品行为，但不持有这项私有协议决策。Issue #572 还要求虚拟设备隐藏运行，这仍不属于这套仅测试策略的范围。

## Decision

测试策略使用两个深 Module。fixture 清理 owner 接受一个不透明的 `OwnedFixtureLease`；注入的 `FixtureCleanupDeadline` 分别约束 `beginCleanup()` 与 Host stop。及时完成的 begin 把唯一剩余所有权转交给 `FixtureCleanupContinuation.settled`；过期或失败的 begin 保留受控的迟到 begin 与 continuation 观察，但不阻塞 cleanup。Host cleanup 在该有界 begin 结果之后启动，并按 Host 优先、随后 fixture 阶段的稳定顺序与 fixture 报告聚合。成功要求机制无关的已验证静止报告且没有 issue。

Host 世代 owner 在每个精确 channel 对象上只接受一次有界 Host hello。Desktop 生成世代标识与 capability；Host 不能选择或复用它们。之后每个请求都回显这两个值，并继续绑定原始 channel 状态。不支持的 support 决策返回相关联的 `PLATFORM_CONTAINMENT_UNAVAILABLE`，协议不会暴露操作系统机制。

状态与记忆化 Promise 在任何外部调用之前发布。`BrokerReservation.id` 在 `reserve()` 返回时同步发布，早于异步启动。按 lease 标识维护的 admission tail 只串行同一标识的 admission，不阻塞无关标识。`request()` 通过 `Promise.resolve().then` 推迟分发，因此没有全局启动屏障。返回的 lease 必须匹配预留标识；不匹配则失败关闭，且未匹配的 lease 在不进入世代所有权的情况下被清理。reservation 先于 broker reserve 和启动回调存在。世代关闭先设置围栏并发布精确 Promise，随后才开始 Host、reservation、collision 或 lease 清理。重复 lease admission 会先发布 collision 记录和清理 Promise，再调用外部清理。`disconnect`、Host 退出与显式 cleanup 使用同一个关闭 Promise。

Host、reservation、collision 和 lease lane 通过注入的 deadline 独立结算。关闭会快照 reservations、leases、collisions、replay refusals 和 admission tails，并在外部清理之前清空这些世代持有的集合。已被 close 认领的 reservation，或在清空之后才从 `reserve()` 返回的 reservation，不得再写入 admission tails。`ownershipSnapshot()` 报告当前 reservation、lease、collision 与 admission-tail 计数。关闭期间及时到达的 reservation 结算进入关闭屏障；超过已声明截止时间才到达的结算进入唯一一个分离且有界的清理 lane。迟到拒绝与迟到清理 issue 使用不同的精确一次诊断。lease 的自然退出观察独立于清理，并有自己的诊断。

请求重放记忆使用注入的正整数容量。容量耗尽时关闭世代，而不是淘汰旧请求。wire 解析校验精确字段、版本、discriminant 与有界值。清理 issue 使用类型化阶段和稳定顺序。

这些 Module 不启动任何进程，也不声称具备强隔离。生产 broker Adapter 必须独立证明其所有权与隔离保证，真实 fixture 才能使用这项策略。隐藏窗口启动 seam 与产品恢复行为继续由 Issue #572 跟踪。

## Alternatives considered

**无界等待和无界 tombstone。** 不采用，因为停滞的启动或清理会阻止 Desktop 关闭，而永久请求历史会无限增长。deadline Adapter 约束所有权 lane，重放容量耗尽时失败关闭。

**扫描外部 PID 或进程组后终止整个组。** 不采用，因为外部发现和标识复用不能证明精确所有权。进程细节留在未来经过评审的 broker Adapter 内部，不进入策略 Interface。

**由 Host 提供世代或 capability 权威。** 不采用，因为调用方选择的值可能寻址已有世代。Desktop 在精确 channel 对象上接受一次 hello 后生成两项权威值。

**在外部回调之后发布状态。** 不采用，因为同步重入可能看不到 reservation、collision 或关闭 Promise，并启动重复工作。策略先发布状态与 deferred Promise。

**可见的自动化 Electron 运行。** 不采用，因为 Issue #572 要求自动化虚拟设备保持隐藏。这套测试策略既不启动 Electron，也不提供可见验收证据。

**在外层 Interface 中使用操作系统机制术语。** 不采用，因为策略应表达所有权、有界结算与已验证静止，而不承诺某个平台专属的隔离实现。

## Consequences

仅 fake 的测试固定权威生成、channel 所有权、同步发布、有界结算、重放拒绝、稳定聚合和诊断所有权，且不调用真实进程。这项策略约束并指导未来生产 Adapter，但不能证明该 Adapter 安全。在生产行为完成之前，Issue #572 仍要求产品接线、隐藏虚拟设备启动、同一 Host 内恢复和真实隔离证据。
