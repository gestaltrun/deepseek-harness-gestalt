# Agent Note：实际运行的 OSS 附件 authority

Status: implemented

[English](2026-08-23-operated-oss-attachment-authority.md) | 中文

## 问题

两个生产 Platform 实例共享的远程附件密文不能保留在进程内存，也不能只依赖 PostgreSQL bytea 行。实际运行链路需要私有对象存储、一次性 pairing authority、与既有 `remote_attachment_blobs` 行的滚动兼容、账号完整配额、有界主动清理、临时凭证，以及不会覆盖 bucket 其他消费者 lifecycle rule 的部署检查。

## 决策

PostgreSQL 是 capability authority，Alibaba Cloud OSS 是密文字节 store。`remote_attachment_objects` 把部署 database identity 与 SHA-256 capability digest 绑定到品牌化 Personal Pairing id、受 prefix 约束的私有 object key、byte length、expiry、账号配额 reservation、滚动兼容 authority 与独占 consume claim。publish 会先写入私有 OSS object，再提交元数据。commit 失败或结果不明时，只有 PostgreSQL 确认没有元数据引用该对象才会删除；否则 lifecycle 清理保留安全兜底。

加法迁移让 `remote_attachment_blobs` 保持可读。新实例可消费只有旧行的数据，并在新 OSS 元数据旁兼容写入密文，使旧实例能消费滚动部署期间由新实例创建的上传。独占的新实例 consume 删除旧行之前，旧行仍是兼容 authority；旧实例消费后，配对的 OSS 元数据会变成 stale 且不可使用。新实例会在读取 OSS 前提交 claim，因此跨实例并发的 HTTP consume 只接纳一份响应。响应失败会恢复尚未过期的 claim；响应完成后，即使后续对象或配额清理失败也绝不重放。

每个请求都由当前 Mobile Installation 与已确认 pairing 鉴权。上传准入会在 publish 前预留账号完整 blob 配额，元数据保留不透明 reservation id，直到 consume、revoke、expiry 或 pairing revocation 时释放。定期 PostgreSQL sweep 会删除过期行和已确认 pairing 不再存在的行，记录持久 quota-release 工作，并以配置的并发数排队删除 OSS。publish 只排队批量清理，不等待对象删除。OSS lifecycle 仍是对象删除失败的兜底。持久读取会在缓冲任何对象 stream 前拒绝格式错误的 digest、pairing id、object key、length、expiry、claim 与 reservation id；精确 `Content-Length` 校验和流式字节计数共同执行 PostgreSQL 的长度 authority。

client 只接受 Alibaba Cloud OSS hostname、部署 bucket 与 object prefix，以及 `ecs-ram-role/<role>` selector。它通过 ECS IMDSv2 获取临时凭证，使用 HTTPS 与 Signature V4，请求私有 object ACL，并且不暴露公开 URL 或长期 access key。Platform Deploy 会在替换运行中容器前以 fail-fast shell 语义执行镜像内的 lifecycle preflight。preflight 会保留无关 rule，并确保确切附件 prefix 存在一条启用的一天 expiration rule；失败时旧部署继续运行。

## 考虑过的替代方案

**让 PostgreSQL 成为唯一密文 store。** 不采用，因为 PostgreSQL 拥有紧凑的事务 authority，而大型加密对象具有独立传输与清理行为。重复的 `remote_attachment_blobs` 密文用于滚动兼容机制。

**把长期 Alibaba Cloud access key 放入 GitHub Secrets。** 不采用，因为 ECS RAM role 可提供短期凭证，无需长期部署 secret。

**让每个 Platform startup 重写 bucket lifecycle。** 不采用，因为 runtime instance 不应在每次重启时都需要 bucket 管理 authority，并且 startup 竞态可能覆盖无关 rule。幂等 lifecycle merge 由部署拥有。

## 后果

两个 Platform 实例可以通过一个 PostgreSQL authority 与一个私有 OSS namespace 执行 publish、inspect、consume 和 revoke。即使 consumer 跨实例竞争，capability 仍只可使用一次，已有 binary 在替换期间也保持兼容。主动 expiry 与 pairing-revocation 清理会把元数据和配额保留时间约束在配置的 sweep 间隔内；直接清理通常立即删除密文，而限定 prefix 的一天 rule 会约束 OSS 删除失败后的孤儿保留时间。滚动兼容行会在 PostgreSQL 中复制密文。部署需要 sweep 与清理并发配置，并要求 ECS role 可读取和更新 lifecycle configuration 与私有对象。

## 测试

`oss-client.spec.ts` 固定 IMDSv2、临时凭证校验、私有对象 header、有界 stream 读取、lifecycle 保留、精确 rule 幂等性与缺少 lifecycle 时的创建。`oss-attachment-store.spec.ts` 会在读取 OSS 前拒绝格式错误的持久行，并在 commit 结果不明时保留对象。`product-entry-durable.spec.ts` 使用临时 PostgreSQL 与共享 OSS bytes 驱动新旧 store，覆盖跨实例 claim 独占、滚动读取、pairing 隔离、容量、主动 expiry 与 revocation 清理、quota release、不阻塞的批量删除和精确 boot entry；`production-env.spec.ts` 固定部署变量与 fail-fast workflow 投影。
