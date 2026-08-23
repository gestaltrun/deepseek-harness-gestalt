# Remote Protocol

[English](remote-protocol.md) | 中文

[`@deepseek-ai/dsh-remote-protocol`](../../packages/platform/remote-protocol/README.zh.md)定义 Mobile、Desktop 与不透明 Relay 共享的唯一 wire 词汇。它是纯协议模块，不是 Cordis 服务。

## 独立协议

Relay Transport 版本协商独立于 Encrypted Companion 应用协商。Relay 只能解析 attachment、转发、心跳、撤销与 transport error 元数据；其转发 payload 始终是字节。只有双方从 major 2 和 1 中选出最高的安全共同 major，并同时保留已认证加密、配对密钥隔离与重放保护后，Companion 消息才可用。Offer 数组顺序不表达偏好，也不影响选择。

协商结果是进程内不可伪造的 capability，`encodeCompanionMessage` 与 `decodeCompanionMessage` 都必须持有它。每条逻辑 endpoint 连接拥有一个 negotiation channel。新协商会在校验 offer 前让该 channel 的此前 capability 失效，因此失败的重新协商无法复用旧 capability，也不会撤销无关 channel。`COMPANION_UPDATE_REQUIRED` 和 `COMPANION_SECURITY_CAPABILITY_MISSING` 会指出必须更新的 endpoint。调用方不能在协商成功前生成应用消息，因此失败路径只携带版本和 capability 元数据。

## Wire 值

Relay route/attachment id 与 Companion operation、Session projection、transcript entry id 是从 `unknown` 解析出的不同品牌化字符串。Companion 使用协议原生标识符，不导入 Harness 领域类型。两个 codec 都会拒绝未知 discriminant、额外字段、不安全数值、畸形 UTF-8/JSON、过深 parser、大型 container、过多编码值、超大消息和超大密文。Base64url 字段只接受规范的无填充拼写。加密前 Companion 应用数据最多为 60 KiB。完整编码 transcript-page 消息采用更严格的 50 条或 48 KiB 上限，并按 UTF-8 wire 字节计量。

本包不拥有加密实现。Endpoint adapter 使用已评审的配对通道加密 offer 和应用消息。无密钥 Loader example 只用 harness-local cipher 证明 Relay 解码与转发不需要应用明文。
