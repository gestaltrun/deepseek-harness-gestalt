# Agent Note：为每个 endpoint 配对请求单独授权

状态：已实现

[English](2026-08-25-fresh-installation-proof-per-pairing-request.md) | 中文

## 问题

Mobile 为 endpoint 配对状态 poll 授权一次，并在提交 XKpsk3 message3 时复用这份一次性 Installation proof。Platform 在 status request 中消费 proof，随后把 message3 拒绝为 `PROOF_REPLAYED`，使真实 Mobile 配对停留在 message2 之后的可重试状态。

## 决策

每个 endpoint 配对 HTTP operation 都在 transport call 之前立即获取新的 `authorizeCurrentInstallation()` 结果。特别是，message3 submission 不继承返回 message2 的 status poll authentication。配对 retry state 保留 protocol progress，但不保留可复用的 Account proof material。

## 考虑过的替代方案

**允许 status 与 message3 共用一个 proof。** 拒绝，因为这会削弱 one-operation proof replay rule，并使 proof validity 依赖多请求 client sequence。

**message1 之后不再验证 status proof。** 拒绝，因为 mailbox read 会暴露 Account-bound 配对进度，仍然属于 authenticated Platform operation。

**只在收到 `PROOF_REPLAYED` 后用新 proof 重试 message3。** 拒绝，因为 replay rejection 是 security signal，不是正常 flow control；第一次无效请求仍会出现在 operated log 中。

## 后果

Status polling 与 message3 会携带不同 proof JTI，同时保留同一个 pairing attempt 与 handshake transcript。每个 HTTP operation 会多执行一次 proof signing。已消费、重试或乱序的请求都不能把 proof 转给另一个配对 operation。

## 测试

Controller regression 记录交给 status 与 message3 的 authorization，并要求 JTI 不同。Shipped Android App 已通过 operated Platform 到达 authentication words 和 Desktop confirmation，且没有 proof replay response。
