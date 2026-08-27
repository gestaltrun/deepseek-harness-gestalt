# Agent Note: 拒绝旧配对事务格式

Status: implemented

[English](2026-08-27-reject-legacy-pairing-transaction-formats.md) | 中文

## 问题

版本 2 成为唯一写入格式后，预发布配对状态 decoder 仍接受无版本与版本 1 文档。这条永久恢复路径让过期的 durable authority 绕过预发布 backend 拒绝旧格式的仓库规则，并保留了当前 producer 均不需要的 cleanup 重建逻辑。

## 决策

Store value 缺失时仍创建空配对事务状态。每份已存在的配对事务文档必须携带 `formatVersion: 2`；缺少版本、版本为 1 或版本未知时，decoder 会在解析任何 authority field 前抛错。Runtime 不包含旧 replay recovery 或 delimiter-key decoder。该决策部分取代[让配对状态与 Desktop 访问共用一个 PostgreSQL 事务](../bug-fix/2026-08-25-postgres-pairing-transaction-encoding-and-access.zh.md)中的版本 1 迁移行为。

## 考虑过的替代方案

**保留旧格式 decoder，直到首个 tag release。** 拒绝，因为预发布格式规则已经要求旧文档失败，而开放期限的 runtime compatibility path 没有确定的删除时点。

**把旧文档重置为空状态。** 拒绝，因为静默删除 Personal Pairing、Relay 与 attachment authority 会把格式错误变成数据丢失。

**在 decoder 内执行迁移。** 拒绝，因为 operated state 在施加该限制前已经完成版本 2 写入；任何残留的旧文档都是 deployment data error，必须停止发布并由 operator 显式处理。

## 后果

配对 codec 只保留一种 durable format，并显著减少恢复代码。残留的旧生产 row 会立即失败，而不会静默迁移或丢失 authority；candidate acceptance 会停止，直到 operator 证明或完成必要的数据修复。

## 测试

Codec coverage 证明版本 2 可以 round-trip，并且版本 1 或无版本文档会在 field decoding 前被拒绝。现有 PostgreSQL transaction coverage 继续证明配对状态与 Desktop access commit 的原子性。
