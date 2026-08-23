# Agent Note：实际运行的 OSS 附件 authority

Status: implemented

[English](2026-08-23-operated-oss-attachment-authority.md) | 中文

## 问题

两个生产 Platform 实例共享的远程附件密文不能保留在进程内存或 PostgreSQL bytea 行中。实际运行链路需要私有对象存储、一次性 pairing authority、有界清理、临时凭证，以及不会覆盖 bucket 其他消费者 lifecycle rule 的部署检查。

## 决策

PostgreSQL 是 capability authority，Alibaba Cloud OSS 是密文字节 store。`remote_attachment_objects` 把部署 database identity 与 SHA-256 capability digest 绑定到品牌化 Personal Pairing id、受 prefix 约束的私有 object key、byte length 和 expiry。publish 会先写入私有 OSS object，再提交元数据。inspect 读取但不消费。consume、revoke 与 expiry 清理会先提交元数据删除，再尽力删除对象，因此网络失败不会恢复 capability authority，也不会让数据库事务等待网络。持久行在任何对象读取前拒绝格式错误的 digest、pairing id、object key、length 与 expiry。

client 只接受 Alibaba Cloud OSS hostname、部署 bucket 与 object prefix，以及 `ecs-ram-role/<role>` selector。它通过 ECS IMDSv2 获取临时凭证，使用 HTTPS 与 Signature V4，请求私有 object ACL，并且不暴露公开 URL 或长期 access key。Platform Deploy 会在替换运行中容器前执行镜像内的 lifecycle preflight。preflight 会保留无关 rule，并确保确切附件 prefix 存在一条启用的一天 expiration rule；失败时旧部署继续运行。

## 考虑过的替代方案

**在 PostgreSQL 中保存密文。** 不采用，因为 PostgreSQL 拥有紧凑的事务 authority，而大型加密对象具有独立传输与清理行为。

**把长期 Alibaba Cloud access key 放入 GitHub Secrets。** 不采用，因为 ECS RAM role 可提供短期凭证，无需长期部署 secret。

**让每个 Platform startup 重写 bucket lifecycle。** 不采用，因为 runtime instance 不应在每次重启时都需要 bucket 管理 authority，并且 startup 竞态可能覆盖无关 rule。幂等 lifecycle merge 由部署拥有。

## 后果

两个 Platform 实例可以通过一个 PostgreSQL authority 与一个私有 OSS namespace 执行 publish、inspect、consume 和 revoke。即使 consumer 跨实例竞争，capability 仍只可使用一次。直接清理通常会立即删除密文；限定 prefix 的一天 rule 会约束 OSS 删除失败后的孤儿保留时间。除了私有对象操作，部署还要求 ECS role 可读取和更新 lifecycle configuration。

## 测试

`oss-client.spec.ts` 固定 IMDSv2、临时凭证校验、私有对象 header、lifecycle 保留、精确 rule 幂等性与缺少 lifecycle 时的创建。`oss-attachment-store.spec.ts` 会在读取 OSS 前拒绝格式错误的持久行。`product-entry-durable.spec.ts` 使用临时 PostgreSQL 与共享 OSS bytes 驱动两个 store，覆盖 pairing 隔离、容量、并发一次性 consume、expiry 清理与精确 boot entry；`production-env.spec.ts` 固定部署变量与 workflow 投影。
