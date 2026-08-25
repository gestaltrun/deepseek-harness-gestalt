# `@deepseek-ai/dsh-remote-attachments`

[English](README.md) | 中文

Remote Access 的配对范围加密 attachment blob store。Mobile 通过 HTTPS 上传 endpoint 加密的密文，并获得限定于单个 Personal Pairing、受大小与过期约束的一次性 capability；Desktop 用该 capability 恰好一次地换取密文，校验哈希后在 endpoint 解密，并把 attachment 提交进既有 Session 路径。WSS Relay 路径只承载有界的 `offer-attachment` 控制消息。

## Blob store

`RemoteAttachmentStoreProvider`（`ctx.remoteAttachments`）是进程内 fixture，保留密文以及 capability、所属 `PersonalPairingId`、过期时间与可选账号 quota reservation。已接受的协议上限是每个 blob 104,857,600 密文字节（100 MiB）、默认 capability 生命周期 900,000 毫秒（15 分钟）；部署可以配置更低的值（`maxBlobBytes`、`capabilityLifetimeMs`），不能更高。Mobile 会拒绝密封后（`明文 + 28` 字节的 AES-GCM IV 与 tag）将超过该密文上限的明文。已准入的账号 reservation 带有持久绝对 lease expiry；publish 会拒绝并释放早于预定 blob expiry 结束的 lease，因此 quota 不会在 blob authority 仍有效时消失。`maxRetainedBlobs` 约束总容量，在清扫过期条目后仍满时以明确的 `ATTACHMENT_CAPACITY` 失败；`sweepIntervalMs` 驱动会重新武装的后台过期清扫，`dispose()` 会取消它。每次完成的 consume、惰性或清扫过期以及配对范围的 `revoke` 都会移除 blob、capability 与 quota reservation。空密文以 `ATTACHMENT_EMPTY` 失败。高于上限的错误配置，或非正的 `maxRetainedBlobs`，会在构造时失败。`publish`、`inspect`、`observe` 与 `consume` 会复制密文，调用方或观察者的原地修改不能改变已保留的字节。

store 插件（`name: '@deepseek-ai/dsh-remote-attachments'`）把这些边界作为可从 cordis.yml 到达的 Schemastery `Config` 暴露。capability 是来自 `parseAttachmentCapability` 的 256 位一次性值；`inspect` 与 `consume` 拒绝跨配对使用（`ATTACHMENT_PAIRING_MISMATCH`）且不消耗 blob，拒绝未知、已 claim 或已消耗的 capability（`ATTACHMENT_CAPABILITY_INVALID`）与已过期的 capability（`ATTACHMENT_EXPIRED`）。`consume` 返回独占 claim：`complete()` 永久结算成功投递，`abandon(now)` 在投递失败后恢复尚未过期的 blob。`revoke({ pairingId, capability })` 使用同样的配对检查：不匹配会失败且不删除，未知 capability 是空操作。`observe()` 为 Platform 侧运维投影保留密文与元数据的副本；这一安全边界上不存在明文。

## HTTP 路由

`remote-attachments-http` 插件（`@deepseek-ai/dsh-remote-attachments/http`）在已挂载的 store 上注册三个精确路由，并要求 `webServer`、`remoteAttachments` 与 `remoteAttachmentAuthority` 配对 seam。它的非空 `origins` 配置列出受信任的精确标准或自定义元组 origin；带路径的 origin、opaque `null`、畸形值与未配置 origin 都会被拒绝。销毁插件 fiber 会注销这些路由。

- `POST /v1/remote-attachments`——带正数且精确 `Content-Length` 的原始密文体；账号完整 quota 准入先于 body 读取与 publish，然后返回 `201` 与 `{ capability, byteLength, expiresAt }`，空体或长度不匹配返回 `400 ATTACHMENT_EMPTY` / `CONTENT_LENGTH_MISMATCH`，缺少长度返回 `411 CONTENT_LENGTH_REQUIRED`，超限返回 `413 ATTACHMENT_LIMIT_EXCEEDED`，`429 QUOTA` / `PLATFORM_CAPACITY` 则携带 `retryAfter`。被拒绝或中断的 body 会释放 reservation。
- `POST /v1/remote-attachments/consume`——`{ capability }` JSON；在写入前原子 claim，并返回 `200` 与原始密文，跨配对 `403`、未知或已 claim `404`、过期 `410`。body 写入失败会放弃 claim 以便重试；body 完成后即使结算清理失败也绝不重放。
- `POST /v1/remote-attachments/revoke`——`{ capability }` JSON；配对范围 revoke 成功后返回 `204`；已认证配对不拥有该 capability 时返回 `403`。

## 配对 seam

`RemoteAttachmentAuthority.authenticate({ headers })` 把一个 HTTPS 请求映射到恰好一个 `PersonalPairingId` 以及 `admit(bytes)`；后者会预留一条带绝对 `expiresAt` 且 `release()` 幂等的不透明账号完整 quota lease。实际运行的 Platform 实现会依据 PostgreSQL 校验当前 Mobile Installation 证明与确切的已确认 pairing selector；selector 本身没有 authority。它永远看不到 attachment 明文。缺失 authority 服务会使插件加载响亮失败。

## 模型体验

无，因为 attachment 密文与 capability 永不进入模型请求。

#### KV Cache 影响

无。

## 已知限制与延后工作

- `RemoteAttachmentStoreProvider` 仅保留为包测试 fixture。实际运行的 Platform 会先把 PostgreSQL 原子 consume bridge 部署到全部主机，再在每个 predecessor 都报告 bridge mode 后通过单独部署启用私有 OSS 字节。bridge 与 OSS store 共享 claim token；主动 sweep 会删除过期和明确 inactive 的 pairing candidate，并释放 quota reservation。
- Desktop 把 consume 的 HTTP 403/404/410/413 映射为协议原生拒绝原因，只在哈希校验后解密，并通过 Session 范围的 Host 文件 RPC 准入确切字节。
