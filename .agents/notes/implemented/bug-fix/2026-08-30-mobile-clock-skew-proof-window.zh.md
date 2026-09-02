# Agent Note: 移动端时钟偏移与安装证明重放窗口

Status: implemented

[English](2026-08-30-mobile-clock-skew-proof-window.md) | 中文

## Problem

Installation 使用本地时间戳签署每次 Platform Account 操作。即使 GitHub 授权、TLS 与网络投递都成功，消费级手机的时钟仍可能与 Platform 相差超过六十秒。此时拒绝证明会阻止账号登录和所有已鉴权 Companion 操作，尽管 Installation 仍持有正确私钥。

接纳未来时间的证明还会让其剩余有效期超过服务端接收时刻。如果从接收时刻计算已消费证明 id 的到期时间，重放记录可能在同一签名证明仍处于允许时间窗口时提前释放。

## Decision

当签名 Installation 证明的签发时间与 Platform 时钟相差不超过五分钟时，Platform Account 会接纳该证明。证明仍会绑定精确操作和由令牌推导的值，签名校验仍先于原子 `jti` 消费。这个以分钟为界的有限容差遵循 [OAuth DPoP 证明重放](https://www.rfc-editor.org/rfc/rfc9449.html#section-11.1)中的时钟偏移指引。

共享 Account 后端会把已消费 `jti` 保留到 `issuedAt + ACCOUNT_PROOF_WINDOW_MS`。因此，签发时间领先服务端的证明会在完整有效期内保持重放阻断，而不只是从首次接收开始保留五分钟。

## Alternatives considered

**要求设备使用自动时间。** 消费级应用无法强制手机的时间来源，而且 OAuth 授权成功后出现的证明诊断没有提供可行恢复路径。

**用服务端 nonce 替代客户端时间。** 服务端管理的 nonce 可以消除时钟依赖，但会为每个 Account 证明生产方和校验方增加新的 wire 值与生命周期。现有的操作绑定、签名、有限有效期和共享单次 `jti` 已能在不扩展协议的情况下提供所需保护。

**只接纳时钟落后于 Platform 的证明。** 设备时钟既可能领先也可能落后；非对称规则会让同一种常见偏移变成与方向相关的失败。

## Testing

Platform Account 提供方测试会使用落后和领先三分钟的时钟签署当前账号证明。两个证明都必须成功，精确重放必须失败；测试还会在未来时间证明仍有效时把服务端时间推进到首次接收保留点之后，并继续要求重放失败。现有非法时间、签名和后端测试会继续拒绝超过五分钟窗口的证明。

Platform 部署完成后，物理 iPhone 的 Mobilewright 验收会通过生产 GitHub 回调登录，并继续使用显式完整链接完成 Personal Pairing，不访问摄像头。

## Consequences

被截获证明满足时间检查的最长时间从一分钟增加到五分钟。精确操作与令牌绑定会阻止它用于其他请求，共享 `jti` 消费则会在完整区间内保持该证明只能使用一次。重放存储需要把条目保留五分钟再加上已接纳的未来偏移；这项有限增加换取了对常见移动设备时钟差异的容忍。
