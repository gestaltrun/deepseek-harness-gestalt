# `@deepseek-ai/dsh-remote-protocol`

[English](README.md) | 中文

Remote Access 的纯 codec 与协商器。本包拥有两个独立版本化的协议，不导入 Harness Workspace、Session、prompt、tool、model、approval、Host API 或 WebSocket 类型。

## Relay Transport Protocol

版本 1 只暴露路由 attachment、不透明密文转发、心跳、撤销、稳定 transport 错误与 transport 版本协商。Attach 携带独立品牌化的规范 32 字节凭据；route id 永远不是 attachment 权限。Relay 标识符是协议原生的品牌化值。`REMOTE_OFFLINE` 报告在线目标缺失，但不表示存在排队投递。解码会拒绝未知消息类型和额外字段，因此完整 Host 请求不能夹带在 transport 元数据旁。

## Encrypted Companion Protocol

Companion major 2 和 1 是当前及紧邻的前一应用版本。双方 endpoint 必须在所选 major 上声明已认证加密、配对密钥隔离与重放保护。协商不受 offer 数组顺序影响，始终选择最高的安全共同 major，因此不安全的共同 major 只能降级到安全的紧邻前一 major。每条逻辑 endpoint 连接拥有一个 negotiation channel。在该 channel 上开始新协商时，会在求值 offer 前让此前的应用 codec token 失效；失败的协商会让 channel 保持未激活，而其他 channel 仍然有效。不存在安全版本交集时，会在编码应用明文前失败，并指出必须更新的 endpoint。

已实现 catalog 包含有界 transcript-page projection（可选 `streaming`，以及 `text`、`image`、`approval` 与 `ask-user` 条目）、Session 创建 operation、prompt 提交 operation、prompt 取消 operation、attachment offer operation、`settle-approval` 与 `answer-ask-user` operation、重连用的 `query-operation-status` operation、Desktop-confirmed result、attachment 拒绝 result，以及 `status` 应答——为被查询的 operation id 返回原始 committed 结果，或显式声明其未提交任何内容。attachment offer operation 是加密 attachment 传输的有界控制消息：只携带一次性 blob capability、密文 SHA-256、精确密文字节数、capability 过期时间与有界文件名。image 条目只携带 `fileName` 与 `alt`；附件明文字节不进入 Relay frame。`approval` 或 `ask-user` 条目命名一个品牌化 `interactionId` 以及 Desktop 已授权的决定；若存在 `settled`，其 decision 必须是这些决定之一。每个标识符由本协议自行品牌化，不从 Harness 领域包导入。解码时会拒绝不支持的 operation 与 projection 字段。committed 的 `status` 应答内嵌同一 operation id 的 confirmed 结果；absent 应答仅为 `{ absent: true }`。

## Endpoint attachment cipher

`deriveCompanionAttachmentKey`、`sealCompanionAttachment`、`openCompanionAttachment` 与 `hashCompanionCiphertext` 以 HKDF-SHA-256 密钥派生和 AES-256-GCM 实现加密 attachment 传输的 endpoint 侧。密封载荷是 `iv(12) ‖ ciphertext ‖ tag(16)`（`COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES` = 28）。两个 endpoint 链接这些函数；Platform blob store 只接收 `sealCompanionAttachment` 的输出及其 SHA-256，永不派生密钥。密钥材料由 Personal Pairing 层提供。100 MiB blob 上限是密文限制；Mobile 会拒绝加上该开销后无法放入上限的明文。

## Wire 限制与错误

| 限制 | 值 |
|---|---:|
| Parser 深度 | 16 层 |
| 单个对象或数组中的值 | 256 |
| 编码值总数 | 4,096 |
| 单个字符串的 UTF-8 字节 | 90,000 |
| 完整 Relay 消息 | 98,304 字节 |
| 不透明 Noise 消息 | 65,535 字节 |
| 加密前 Companion 应用数据 | 61,440 字节（60 KiB） |
| 完整编码 transcript-page 消息 | 49,152 字节（48 KiB） |
| Transcript page | 50 条 |
| 保留的 attachment blob | 104,857,600 密文字节（100 MiB） |
| Attachment capability 生命周期 | 900,000 毫秒（15 分钟） |
| Attachment 文件名 | 255 UTF-8 字节 |

`RemoteProtocolError` 为无效输入、超过限制、不兼容 Relay 版本、缺少 Companion 安全 capability、endpoint 必须更新及缺少协商提供稳定 code。诊断不会包含应用明文。二进制 wire 值只接受一种规范的无填充 base64url 拼写；能够解码成相同字节的别名也会被拒绝。60 KiB 应用上限在固定 65,535 字节 Noise 消息上限内为加密开销保留 4,095 字节；Relay frame 上限也能在该最大值下容纳 base64url 与 transport 元数据。

本包不加密 Companion 消息流量。Mobile 与 Desktop 提供经过独立评审的端到端通道，再在 Relay 转发前加密版本 offer 和已编码 Companion 消息。[无密钥 assembled example](../../../examples/remote-protocol/start.ts)使用仅限示例的 AES-GCM adapter，证明 composition 与 Relay 仅见密文；它不是产品密码实现或安全评审结论。产品集成仍受[独立 Noise 评审](../../../docs/security/noise-cross-runtime-proof.md)约束。

## 无内容推送提示

Companion 推送提示只携带通用类别（`approval`、`question`、`turn-complete` 或 `failure`）以及不透明的 `routeId` 与可选 `sessionRef`。token 与 `sessionRef` 上限按 UTF-8 字节计（4096 与 128）。流式分片没有类别，也不会产生提示。线解析会拒绝未知类别、畸形标识符和额外字段，因此 Session 文本不能夹带在提示旁。`buildApnsPushPayload` 与 `buildFcmPushMessage` 把同一对字段投影到厂商 JSON 正文；标题只重复类别，不含 transcript、交互内容、设备名或凭据。

## 模型体验

无，因为 Remote Protocol 元数据与设备来源永不进入模型请求。

#### KV Cache 影响

无。

## 已知限制与延后工作

- 当前 Companion catalog 证明 Session 创建、prompt 提交与取消、attachment offer、审批与 Ask User 结算、operation-status 查询、含 image 与交互卡片的 transcript projection，以及 confirmed、attachment-rejected 与 status 三种 result。远程 Workspace 发现仍属于后续 catalog 切片。
- 配对 handshake、凭据持久化、challenge lifecycle、token 分发与生产 Companion 消息加密属于服务或经评审的 endpoint 集成，不属于这些 codec。
