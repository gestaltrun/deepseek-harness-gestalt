# Agent Note: 让配对状态与 Desktop 访问共用一个 PostgreSQL 事务

Status: implemented

[English](2026-08-25-postgres-pairing-transaction-encoding-and-access.md) | 中文

## 问题

Endpoint access-generation map 使用进程内 `accountId\0desktopInstallationId` key，并把该 key 直接序列化到 PostgreSQL `jsonb`。PostgreSQL 拒绝包含 NUL escape 的 JSON string，因此真实 Desktop Mobile Access enable 会在状态提交前失败。Desktop route 变化还通过 pool 级 query 写入，而配对状态使用已 checkout 的 transaction client；最终配对状态 commit 失败时，transition 的另一半可能已经保留。

## 决策

配对事务格式版本 2 把每个 endpoint access-generation key 编码成两元素 `[accountId, desktopInstallationId]` tuple，并且只在两个 branded value 都解析后重建私有的 NUL 分隔进程内 key。Decoder 只接受版本 2；[旧配对事务格式会立即失败](../simplification/2026-08-27-reject-legacy-pairing-transaction-formats.zh.md)。

`runPairingTransaction` 在可变配对状态之外提供 transaction-bound `PersonalPairingAccessTransaction`。PostgreSQL 实现通过同一个已 checkout client 执行 Desktop access 读写，memory 实现则提供其串行化 store。修改 endpoint access 的 provider transition 只使用这个 transaction-bound face。

## 考虑过的替代方案

**用另一个字符串字符替换分隔符。** 拒绝，因为 Account 与 Installation identifier 没有为任意分隔符定义 escaping scheme，而结构化 tuple 无需发明 escaping 就能保留两个值。

**继续通过 pool 写 Desktop access，并在 rollback 后补偿。** 拒绝，因为最终 commit 失败或结果不确定时，无法安全证明哪一半已经持久化；一个数据库事务本来就拥有两类 authority。

**把复合 key 存成单个编码 blob。** 拒绝，因为 branded component 是普通的 bounded text，JSON tuple 可以直接检查并独立验证。

## 后果

Operated PostgreSQL 可以接收 endpoint access generation，不再触发 NUL 错误；最终 commit 失败会同时回滚配对文档和 Desktop route 状态。需要在配对 transition 之外读取 Desktop access 的 caller 仍可使用 public store method，但 provider transition 无法绕过 transaction-bound face。

## 测试

Codec coverage 会拒绝带 NUL 的持久化输出并 round-trip 版本 2。PostgreSQL coverage 注入最终 `COMMIT` failure，并观察配对状态与 Desktop access 同时回滚。Operated 双实例 Platform 在写入版本 2 后已接受真实 Desktop Mobile Access enable。
