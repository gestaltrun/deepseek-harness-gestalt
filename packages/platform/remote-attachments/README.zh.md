# `@deepseek-ai/dsh-remote-attachments`

[English](README.md) | 中文

Remote Access 的配对范围加密 attachment blob store。Mobile 通过 HTTPS 上传 endpoint 加密的密文，并获得限定于单个 Personal Pairing、受大小与过期约束的一次性 capability；Desktop 用该 capability 恰好一次地换取密文，校验哈希后在 endpoint 解密，并把 attachment 提交进既有 Session 路径。WSS Relay 路径只承载有界的 `offer-attachment` 控制消息。

## Blob store

`RemoteAttachmentStoreProvider`（`ctx.remoteAttachments`）只保留密文与元数据：capability、所属 `PersonalPairingId`、密文字节与过期时间。已接受的协议上限是每个 blob 104,857,600 密文字节（100 MiB）、默认 capability 生命周期 900,000 毫秒（15 分钟）；部署可以配置更低的值（`maxBlobBytes`、`capabilityLifetimeMs`），不能更高。Mobile 会拒绝密封后（`明文 + 28` 字节的 AES-GCM IV 与 tag）将超过该密文上限的明文。`maxRetainedBlobs` 约束总容量，在清扫过期条目后仍满时以明确的 `ATTACHMENT_CAPACITY` 失败；`sweepIntervalMs` 驱动会重新武装的后台过期清扫，`dispose()` 会取消它。每次成功 consume、惰性或清扫过期以及配对范围的 `revoke` 都会移除 blob 及其 capability。空密文以 `ATTACHMENT_EMPTY` 失败。高于上限的错误配置，或非正的 `maxRetainedBlobs`，会在构造时失败。`publish`、`inspect`、`observe` 与 `consume` 会复制密文，调用方或观察者的原地修改不能改变已保留的字节。

store 插件（`name: '@deepseek-ai/dsh-remote-attachments'`）把这些边界作为可从 cordis.yml 到达的 Schemastery `Config` 暴露。capability 是来自 `parseAttachmentCapability` 的 256 位一次性值；`inspect` 与 `consume` 拒绝跨配对使用（`ATTACHMENT_PAIRING_MISMATCH`）且不消耗 blob，拒绝未知或已消耗的 capability（`ATTACHMENT_CAPABILITY_INVALID`）与已过期的 capability（`ATTACHMENT_EXPIRED`）。`revoke({ pairingId, capability })` 使用同样的配对检查：不匹配会失败且不删除，未知 capability 是空操作。`observe()` 为 Platform 侧运维投影保留密文与元数据的副本；这一侧边界上不存在明文。

## HTTP 路由

`remote-attachments-http` 插件（`@deepseek-ai/dsh-remote-attachments/http`）在已挂载的 store 上注册三个精确路由，并要求 `webServer`、`remoteAttachments` 与 `remoteAttachmentAuthority` 配对 seam。它的 `origin` Config 是受信任的浏览器 origin。销毁插件 fiber 会注销这些路由。

- `POST /v1/remote-attachments`——原始密文体；返回 `201` 与 `{ capability, byteLength, expiresAt }`，空体返回 `400 ATTACHMENT_EMPTY`，流式超限时返回 `413 ATTACHMENT_LIMIT_EXCEEDED`。
- `POST /v1/remote-attachments/consume`——`{ capability }` JSON；返回 `200` 与原始密文，跨配对 `403`、未知 `404`、过期 `410`。只有响应完成后才移除 blob；中途写入失败会保留它以便再次 consume。
- `POST /v1/remote-attachments/revoke`——`{ capability }` JSON；配对范围 revoke 成功后返回 `204`；已认证配对不拥有该 capability 时返回 `403`。

## 配对 seam

`RemoteAttachmentAuthority.authenticate({ headers })` 把一个 HTTPS 请求映射到恰好一个 `PersonalPairingId`。实际运行的 Platform 实现会依据 PostgreSQL 校验当前 Mobile Installation 证明与确切的已确认 pairing selector；selector 本身没有 authority。它永远看不到 attachment 明文。缺失 authority 服务会使插件加载响亮失败。

## 模型体验

无，因为 attachment 密文与 capability 永不进入模型请求。

#### KV Cache 影响

无。

## 已知限制与延后工作

- `RemoteAttachmentStoreProvider` 仅保留为包测试 fixture。实际运行的 Platform 挂载 PostgreSQL 实现，其事务化 capability digest、过期、容量、consume 与 revoke 状态在多个 Platform 实例之间共享。
- Desktop 把 consume 的 HTTP 403/404/410/413 映射为协议原生拒绝原因，只在哈希校验后解密，并通过 Session 范围的 Host 文件 RPC 准入确切字节。
