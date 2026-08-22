# `@deepseek-ai/dsh-noise-channel`

[English](README.md) | 中文

用于 Personal Pairing 与加密 Companion 消息的 Snow 0.10.0 WebAssembly 适配器。同一个已提交模块运行于 Node 与浏览器 WebView；首次配对只选择 `Noise_XKpsk3_25519_ChaChaPoly_SHA256`，重连只选择 `Noise_IK_25519_ChaChaPoly_SHA256`。

## 配对

`SnowDesktopEndpointPairingOwner` 与 `SnowMobileHandshakeClient` 完成 XKpsk3 的全部三条消息，Platform 只转发不透明 mailbox 消息与路由元数据。Desktop 在本地构造 QR payload，因此邀请 PSK 不会进入 Platform HTTP 请求或持久化。完成后的握手哈希只用于认证词。Relay authority 是已完成握手的首条 responder transport payload，不是由另行拼装的应用密码保护的 JSON。打开或密封该 payload 会销毁邀请 PSK、配对临时密钥与 transcript 状态；每个端点只保留自己独立生成的静态密钥和已认证的对端公钥。

`SnowPairingHandshakeProvider` 保留较早的 Platform 中介证明面，并通过 Snow 的 `fixed_ephemeral_key_for_testing_only` API 重建短生命周期状态。产品 Desktop 不选择该 provider；它通过不透明 mailbox 事务在本地保留 endpoint owner。

## 重连与消息

`SnowDesktopEndpointPairingOwner` 与 `SnowMobileHandshakeClient` 完成三条 XKpsk3 消息，Platform 只转发不透明 mailbox 消息与路由元数据。Desktop 在本地构造 QR payload，邀请 PSK 不进入 Platform HTTP 或持久化。端点保护的恢复记录让未完成 transcript 可以跨进程重启继续。Desktop 只在确认事务持久化后擦除邀请状态；Mobile 只在打开的 grant 与 reconnect record 同一次提交成功后擦除邀请状态。

`beginSnowMobileReconnect` 与 `acceptSnowDesktopReconnect` 为每条物理 Relay attachment 创建一条 IK channel。Snow 为每次尝试生成新的临时密钥。IK prologue 绑定 Relay route、credential-bound pairing selector、相互独立的 Desktop 与 Mobile attachment id，以及正数 connection generation，因此其他 route、配对、attachment 组合或 generation 不能复用该 transcript。`SnowMobileAttachmentOwner` 与 `SnowDesktopAttachmentOwner` 把这些 IK 消息作为不透明 Relay ciphertext payload 携带；Desktop 只选择由非秘密 selector 命名的本地 static state，而 Snow 会认证该 static identity。

`SnowCompanionProtocolChannel` 只加密由 `@deepseek-ai/dsh-remote-protocol` 接纳的值。Snow 的有序 transport 会拒绝重放和乱序 ciphertext。Foreground Synchronization 是带有 attachment generation 与 Desktop revision 的版本化 `foreground-sync` Companion projection；原始 1 字节 frame 无法解码成同步 authority。

## Model Experience

无，因为配对、Relay authority 与 Companion transport metadata 都不会进入模型请求。

#### KV Cache effect

无。

## 已知限制与延后工作

- Desktop 与 Mobile 产品入口已经组装 endpoint-owned 首配、持久 static state、credential-bound Relay peer discovery，以及每个物理 attachment 一条 Snow IK channel。Platform 挂载不透明 mailbox 与 digest-only Relay authority，不持有 endpoint key 或应用明文。
- Node 22 与 24 以及现有 simulator 与 emulator proof 覆盖所选 Snow 依赖。物理 iOS 与 Android 证据，以及针对这一确切适配器的独立安全审查记录，仍是 release blocker。
