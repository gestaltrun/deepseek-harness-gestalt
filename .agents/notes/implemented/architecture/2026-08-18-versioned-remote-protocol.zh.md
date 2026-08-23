# Agent Note: 在一个深模块中拥有版本化 Remote Protocol

Status: implemented

[English](2026-08-18-versioned-remote-protocol.md) | 中文

## 问题

Mobile 与 Desktop 独立发布，而 Platform Relay 必须在不获得 Harness 权限或应用明文的前提下转发流量。复用完整 Host HTTP 或 WebSocket 接口会把 settings、credentials、plugins、terminal input、model selection 等 Companion catalog 之外的能力暴露出去。若 codec 与兼容逻辑散落在 composition root 中，同一 wire 规则会在不同 endpoint 之间漂移。

## 决策

`@deepseek-ai/dsh-remote-protocol` 拥有 Relay 与 Companion codec、品牌化 wire 标识符、稳定错误、固定限制和独立版本协商。它是不带 Cordis 服务的纯深模块，也不从 Workspace、Session、prompt、tool、model、approval、Host API 或 WebSocket 包导入类型。

Relay Transport 版本 1 只接受路由 attachment、不透明密文转发、心跳、撤销、transport 错误与 transport 版本协商。每个解码对象都使用精确字段集。Encrypted Companion 只接受显式 projection、operation、result union 与应用版本 offer。协议原生 Companion id 在本包之外适配到 Desktop authority，而不会在 wire 上复用携带 authority 的 Harness id。

只有双方 offer 在 Companion major 2 或紧邻的前一 major 1 上都包含已认证加密、配对密钥隔离和重放保护时，才会完成协商。协商不受 offer 数组顺序影响，始终选择最高的安全共同 major；若较新的共同 major 不安全，而紧邻前一 major 仍安全，则跳过前者。每条逻辑 endpoint 连接拥有一个 negotiation channel，且至多有一个应用 encode/decode 必须持有的、进程内不可伪造 token。开始协商时会在求值 offer 前让该 channel 的此前 token 失效；失败后该 channel 保持未激活，且无关 channel 不会被撤销。不存在安全交集时，会在应用明文可编码前抛出稳定错误，指出必须更新 Mobile 还是 Desktop endpoint。

Codec 会限制完整消息字节、密文字节、parser 深度、container 值数、编码值总数、字符串字节和 transcript page 条数。Base64url wire 字段必须使用规范的无填充拼写。加密前 Companion 应用数据限制为 60 KiB，从而在固定 65,535 字节 Noise 消息上限内为加密开销保留 4,095 字节。完整编码 transcript-page 消息限制为 50 条或 48 KiB UTF-8 wire 字节。它们在 dispatch 前拒绝畸形 UTF-8/JSON、不安全数值、未知 discriminant 与额外字段。

由 Loader assembled 的无密钥 example 使用 harness-local AES-GCM adapter 加密 Mobile 与 Desktop payload，并且只让密文通过 Relay codec。该 adapter 证明装配与明文隔离，不证明产品密码实现。[Snow 跨运行时决策](2026-08-17-cross-runtime-noise-security-path.zh.md)仍只属于 proof，产品集成或 release 仍须完成其安全入口记录的独立评审。Platform Account 与 Installation authorization 继续由[账号决策](../feature/2026-08-17-platform-account-installation-sessions.zh.md)拥有。

## 考虑过的替代方案

**隧穿 Host 接口。** 这会授予已接受 Mobile Companion 权限之外的远程能力，并让 Relay framing 依赖 Harness 业务类型。

**定义 endpoint-local codec。** Mobile、Desktop 与 Platform 可能在限制、稳定错误、降级行为或字段拒绝上产生分歧。单一协议模块让这些规则只对应一份实现与一个测试接口。

**由本 ticket 把 Snow 集成进产品代码。** 已提交 Snow artifact 是尚未由独立安全评审批准产品集成的有界 proof。保持协议独立可以保留评审要求，并让后续 endpoint adapter 提供获批通道。

**协商一个共享 transport/application 版本。** Relay 部署兼容性与独立发布的 Companion 行为因不同原因演进。耦合两者会迫使不必要的 Relay 升级，或通过 transport fallback 允许应用降级。

## 后果

Relay 实现可以在不链接 Harness 领域的情况下路由和拒绝 frame，而 endpoint adapter 共享一个应用 parser 与兼容性决策。新增 Companion operation 必须显式修改协议 union 和 parser，因此当前窄 catalog 不会静默继承 Host route。本包有意将配对、加密、凭据持久化、blob capability、Desktop adaptation 与 operation receipt 留给服务或经评审的 endpoint 集成；[无状态双实例 Relay](2026-08-18-stateless-two-instance-remote-relay.zh.md)拥有 attachment authority 与 forwarding。
