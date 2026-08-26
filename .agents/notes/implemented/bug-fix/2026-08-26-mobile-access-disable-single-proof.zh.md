# Agent Note：Mobile Access 禁用只消费一个安装证明

Status: implemented

[English](2026-08-26-mobile-access-disable-single-proof.md) | 中文

## 问题

禁用 Mobile Access 时，Platform 会先持久化 endpoint revocation intent，再在第二个 pairing transaction 中提交禁用 transition。两个阶段都使用同一个请求 proof 调用 Account authentication。Installation proof 只能使用一次，因此第一阶段消费 proof 后，第二阶段会返回 `PROOF_REPLAYED`；Desktop 展示 HTTP 401，并在下一次轮询时恢复启用状态。

## 决策

禁用请求会在两个 pairing transaction 之前只认证一次 Desktop Installation，并在两个阶段中仅复用得到的 Account 与 Installation identity。持久 revocation-intent transaction 与最终 disable transaction 仍然分开，Mobile Access enablement 保持现有的单 transaction。

## 考虑过的替代方案

**在两个 transaction 中分别认证。** 拒绝，因为 HTTP 请求只携带一个 proof，而 Platform 没有 Desktop Installation private key，不能创建第二个 proof。

**把 revocation intent 与禁用合并为一个 transaction。** 拒绝，因为 retained intent 必须先于外部 credential 与 route cleanup，才能让中断的 disable 保持可恢复。

## 后果

一次 Settings 操作只消费一个 proof，同时保留两阶段持久 cleanup protocol。第一阶段失败时仍会消费本次请求 proof，因此重试仍是携带新 proof 的新认证请求。

## 测试

Provider coverage 使用已认证 Desktop 调用 disable，并证明 Account authentication 只运行一次。Operated Desktop dev flow 还会通过生产 Platform 实际切换 Settings 开关。
