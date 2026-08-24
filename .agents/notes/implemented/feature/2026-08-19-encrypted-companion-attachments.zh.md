# Agent Note: 配对范围的加密 attachment 传输

Status: implemented

[English](2026-08-19-encrypted-companion-attachments.md) | 中文

## Problem

Mobile 用户必须向 Desktop 拥有的 Session 附带文件，同时不向 Platform 暴露明文，也不向 WSS Relay 实时流推送大 frame。传输需要一个配对范围的 capability，其大小与过期受已接受上限（每 blob 100 MiB 密文、默认生命周期 15 分钟）约束；跨配对使用、哈希不匹配、过期、传输中断与超限都要显式失败；成功接收、过期或撤销后必须移除 blob 及其 capability。

## Decision

加密路径按边界拆分。`@deepseek-ai/dsh-remote-protocol` 新增有界的 `offer-attachment` Companion operation（capability、SHA-256、精确字节数、过期时间、有界文件名）、带协议原生拒绝原因的 `attachment-rejected` result、256 位 `AttachmentCapability` 品牌及其 parser、固定 wire 上限，以及只被 Mobile 与 Desktop 链接的 endpoint attachment cipher（HKDF-SHA-256 → AES-256-GCM 加 SHA-256 密文哈希）。

`@deepseek-ai/dsh-remote-attachments` 拥有 Platform 侧。进程内 provider 只保留为包测试 fixture；实际运行的应用挂载[带私有 OSS 密文的 PostgreSQL capability authority](../architecture/2026-08-23-operated-oss-attachment-authority.zh.md)、主动 expiry 与 pairing-revocation 清理以及账号完整 quota reservation。HTTP 插件通过当前 Mobile Installation 证明与确切的已确认 pairing selector 鉴别每个请求；selector 本身不授予 authority。Platform 不会收到 endpoint key 或明文。consume 会在写入响应前原子 claim，在响应 body 写入失败后恢复尚未过期的 claim，并且绝不重放已完成的响应。

Mobile 读取浏览器 `File`，使用该确切配对独立的随机 32 字节 attachment key 密封字节，擦除本地副本，以当前 Installation 证明只上传密文，并仅通过当前 generation 的 Snow channel 发送有界 operation。Desktop 在 durable confirmation transaction 中生成该 key，并在第一条 XKpsk3 transport payload 内与 Mobile grant 一起交付；transcript hash 仅用于认证词。Desktop 把已鉴别的 Relay selector 映射到已确认 pairing id，查找该 endpoint 所有的确切 key，校验并解密 blob，再调用 loopback Host 的 `session.admitAttachment`。`AttachmentStore.saveFile` 原子发布确切字节；Host 追加只写入日志的 `session/attachment-admitted` 引用并 flush，不会把字节或文件名文本加入模型历史。相同 operation 重试返回已记录引用，冲突 operation id 会失败。撤销会独立擦除 attachment key 与 96 字节 IK reconnect record。

## Alternatives considered

**把 blob 作为 Relay 密文 frame 流式传输。** 65,535 字节的密文 frame 上限会把一次 100 MiB attachment 变成数千个实时 frame，违反有界控制消息要求，并让批量传输重新耦合到在线状态。HTTPS 上传/下载保持实时流精简。

**把密文留在 PostgreSQL。** PostgreSQL 仍拥有单次 consume、容量、过期与撤销所需的跨实例事务，但[实际运行的存储决策](../architecture/2026-08-23-operated-oss-attachment-authority.zh.md)会把大型密文字节交给私有 OSS；除滚动兼容行外，PostgreSQL 只保留紧凑 authority。

**Desktop 拥有的 blob 通道。** 对另一网络上的手机而言 Desktop 不是可达的上传目标；Platform 是两个 endpoint 唯一共享的 rendezvous。

## Consequences

assembled 测试让 shipped Mobile mutation 与 receiver adapter 经真实 XKpsk3/IK 进入 `DesktopCompanionProductOwner` 和随机端口 loopback Host。binary、image 与 text 字节成为不可变 Session 引用；权威搜索返回命中与无命中；Host 400 保持类型化并对 Mobile 可见；不存在 `Attached: <fileName>` prompt。一次性 PostgreSQL 加 OSS 测试证明滚动兼容、跨实例 upload 与独占 consume、跨配对拒绝、过期、pairing revocation、quota release、容量与替换。物理 WKWebView/Android WebView 执行与独立安全评审仍是外部 release evidence。
