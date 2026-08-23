# Agent Note：实际运行的 OSS 附件 authority

Status: implemented

[English](2026-08-23-operated-oss-attachment-authority.md) | 中文

## 问题

两个生产 Platform 实例共享的远程附件密文不能保留在进程内存，也不能只依赖 PostgreSQL bytea 行。实际运行链路需要私有对象存储、一次性 pairing authority、与既有 `remote_attachment_blobs` 行的滚动兼容、账号完整配额、有界主动清理、临时凭证，以及不会覆盖 bucket 其他消费者 lifecycle rule 的部署检查。

## 决策

PostgreSQL 是 capability authority，Alibaba Cloud OSS 是密文字节 store。`remote_attachment_objects` 把部署 database identity 与 SHA-256 capability digest 绑定到品牌化 Personal Pairing id、受 prefix 约束的私有 object key、byte length、expiry、账号配额 reservation、兼容 authority 与独占 consume claim。publish 会在写入 OSS 前提交 `remote_attachment_publish_intents`，再以原子事务把 intent 替换成 object 与兼容元数据。最终 commit 结果不明时，只要 PostgreSQL 存在 object 行、intent 或结果不可读，就保留 object；重启后的 expiry reconciliation 会删除孤儿 object 并释放其品牌化 quota reservation。

加法迁移让 `remote_attachment_blobs` 保持可读，并增加共享 claim token。PostgreSQL bridge 与 OSS store 都会在响应前 claim 该行，因此可以在非原子 predecessor 被排空后重叠运行。predecessor 会分别执行 inspect、响应写入与 revoke；任何 schema 列都无法阻止它返回已经 inspect 的字节。Platform Deploy 因此要求完成两次部署：所有主机先通过全 candidate ready 的 contract 进入 `postgres` bridge mode；之后的调用只有在每个 active predecessor 都报告 `postgres` 时才能进入 `oss` mode。contract 会在任何 replacement 接收产品流量前停止全部 predecessor；rollback 只恢复已 rename predecessor 的主机。

每个请求都由当前 Mobile Installation 与已确认 pairing 鉴权。上传要求正数且精确的 `Content-Length`，在读取 request body 前预留账号完整 blob 配额，并在读取被拒绝或失败后释放准入。元数据会保留不透明的品牌化 reservation id，直到 consume、revoke、expiry、pairing revocation 或 publish-intent recovery 时释放。定期 PostgreSQL sweep 只删除 authority 从本轮 candidate set 中明确返回的 pairing id，记录持久 quota-release 工作，并以配置的并发数排队删除 OSS。publish 不等待已排队的 object deletion；dispose 会等待 active sweep 与 cleanup worker。OSS lifecycle 仍是对象删除失败的兜底。持久读取会在缓冲单个预分配 object buffer 前拒绝格式错误的 digest、pairing id、object key、length、expiry、claim 与 reservation id；所有 OSS stream 失败都会销毁 stream。

client 只接受 Alibaba Cloud OSS hostname、部署 bucket 与 object prefix，以及 `ecs-ram-role/<role>` selector。它通过 ECS IMDSv2 获取临时凭证，使用 HTTPS 与 Signature V4，请求私有 object ACL，并且不暴露公开 URL 或长期 access key。Platform Deploy 只在 OSS phase 执行 lifecycle preflight，并在不触碰 active predecessor 的情况下逐主机启动和检查 candidate，随后执行全局 contract。preflight 或 candidate 失败时所有 predecessor 继续运行；replacement 失败时恢复每个已 rename 的 predecessor，且绝不删除未触碰主机的 container。

## 考虑过的替代方案

**让 PostgreSQL 成为唯一密文 store。** 不采用，因为 PostgreSQL 拥有紧凑的事务 authority，而大型加密对象具有独立传输与清理行为。重复的 `remote_attachment_blobs` 密文用于滚动兼容机制。

**把长期 Alibaba Cloud access key 放入 GitHub Secrets。** 不采用，因为 ECS RAM role 可提供短期凭证，无需长期部署 secret。

**让每个 Platform startup 重写 bucket lifecycle。** 不采用，因为 runtime instance 不应在每次重启时都需要 bucket 管理 authority，并且 startup 竞态可能覆盖无关 rule。幂等 lifecycle merge 由部署拥有。

## 后果

两个 Platform 实例可以通过一个 PostgreSQL authority 与一个私有 OSS namespace 执行 publish、inspect、consume 和 revoke。排空 predecessor 后，即使 bridge 与 OSS consumer 竞争，capability 仍只可使用一次。主动 expiry 与 pairing-revocation 清理会把元数据和配额保留时间约束在配置的 sweep 间隔内；直接清理通常立即删除密文，而限定 prefix 的一天 rule 会约束 OSS 删除失败后的孤儿保留时间。在 OSS phase 完成前，兼容机制会在 PostgreSQL 中复制密文。部署要求显式的 `PLATFORM_REMOTE_ATTACHMENT_STORAGE`、两次有序 workflow 调用、sweep 与清理并发配置，并要求 OSS phase 的 ECS role 具备相应 authority。

## 测试

`oss-client.spec.ts` 固定 IMDSv2、临时凭证校验、私有 object header、单 buffer 有界读取、stream 销毁、lifecycle 保留、精确 rule 幂等性与缺少 lifecycle 时的创建。`oss-attachment-store.spec.ts` 会拒绝格式错误的持久行，在清理失败时保留 capacity 错误，并在 commit 结果不明时保留 object。`product-entry-durable.spec.ts` 使用临时 PostgreSQL 证明 fixed-base inspect-write-revoke 重叠、bridge-to-OSS claim 独占、candidate-only revocation、quiescent dispose 与 publish-intent crash/restart reconciliation；`production-env.spec.ts` 固定两种部署 mode、candidate readiness、contract 顺序与逐主机 rollback。
