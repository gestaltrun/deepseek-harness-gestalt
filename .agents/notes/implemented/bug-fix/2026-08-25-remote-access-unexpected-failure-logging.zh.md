# Agent Note: 记录不含请求 authority 的 Remote Access 意外故障

Status: implemented

[English](2026-08-25-remote-access-unexpected-failure-logging.md) | 中文

## 问题

Remote Access HTTP 会为意外 service failure 返回通用 `INTERNAL_ERROR`，但不记录 server-side diagnostic。因此真实 Desktop Mobile Access enable 返回 HTTP 500 时，两个 Platform instance 仍保持 healthy，bounded container log 却无法区分 persistence defect、transport failure 或 process failure。一次性 `AccountError` result 也会落入 unexpected branch，而不是保留 stable code 与 authentication status。

## 决策

`HttpError`、`RemoteAccessError` 与 `AccountError` 保留 typed status、body 和可选 retry behavior，不产生 unexpected-failure log。当 challenge 与幂等 completion replay 都不存在时，endpoint message-1 admission 返回 `PAIRING_CHALLENGE_INVALID`，使 Mobile 可以丢弃过时的 crash recovery，而不是重试 HTTP 500。其他所有 rejection 都会向 stderr 写入一条只包含所选 Remote Access operation、固定 unexpected-failure marker 与有界 cause taxonomy 的 diagnostic。PostgreSQL SQLSTATE 会映射为 `persistence-untranslatable-character`、`persistence-missing-relation` 或 `persistence-connection` 等稳定 allowlisted identifier；其他代码拥有的 exception class 映射为 transport、codec、contract、cleanup、dependency 或 unexpected。日志不记录外部提供的 code 或任何 exception 内容。Public response 保持为不变的通用 HTTP 500 body。Relay client 会对未知 connection failure 使用同样不含内容的分类，然后投影稳定的 `REMOTE_OFFLINE` error。

## 考虑过的替代方案

**把底层 exception 返回给 Desktop。** 拒绝，因为 persistence 与 deployment detail 属于 operator diagnostic，不得穿过 public HTTP response。

**记录完整 request 与 Error object。** 拒绝，因为 request 携带 bearer、proof、handshake 与 sealed protocol authority，而 Error object 可能递归暴露超出 actionable operation 与 message 的 implementation state。

**把所有 failure 都当成 unexpected HTTP 500。** 拒绝，因为 Account replay、expiry、quota、capacity 与 Remote Access state conflict 是由 Desktop 和 Mobile retry policy 消费的 stable application outcome。

## 后果

Bounded Platform stderr 可以识别失败 operation 与有用的 failure family，而 public client 仍只获得通用 unexpected-failure response。已知 security 与 capacity outcome 保持 typed，也不会重复记录。由于 log 有意省略 request identity、authority material、exception message、stack、cause 与 custom field，operator 必须按时间与 operation 关联 diagnostic。

## 测试

Assembled HTTP route 会把 `PROOF_REPLAYED` 映射为 HTTP 401 且不记录日志，保留 Remote Access quota behavior，并注入 message 中含 bearer secret 的实际运行 `set-mobile-access` PostgreSQL `22P05` failure。Provider coverage 会以 `PAIRING_CHALLENGE_INVALID` 拒绝缺失的 endpoint challenge，同时保留 challenge record 已消失后的幂等 completion replay。stderr record 只包含 operation、固定 marker 与 `persistence-untranslatable-character`；序列化后的 log argument 不包含 secret，而 response 仍为通用 HTTP 500。Relay lifecycle coverage 会注入含 secret 的 connection reset，并且只观察到固定 marker 与 `transport`。
