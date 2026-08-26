# Agent Note：按编码字节限制 Companion 投影

Status: implemented

[English](2026-08-27-companion-surface-byte-pagination.md) | 中文

## 问题

固定的 Session 与历史行数上限无法约束 Companion 投影的编码大小。真实 Session 标题、工作目录、Workspace 元数据与工具输出可能让原本有效的浏览或会话快照超过投影字节上限，导致 Desktop endpoint 在 Mobile 收到稳定状态前关闭加密通道。

## 决策

Desktop 在完整发现期间保留权威 Session 与 Workspace 快照。对于每个请求的 offset，它最多解析行数上限，并选择完整投影 envelope 不超过协议字节上限的最大 Session 前缀。每个候选前缀都会重新计算 Workspace 归属。后续游标按实际传输的 Session 行数推进。如果单个 Session 及其 Workspace 元数据仍无法放入上限，Desktop 会返回有界的 Host wire 失败，而不是发送过大的投影。Conversation snapshot 使用协商后通道的精确编码器，只丢弃最早的完整节点，直到最新后缀可以放入上限，并设置 `hasMore`。如果仅最新节点就过大，Desktop 会保留该节点，只按 UTF-8 字节截断面向用户的 `text`、`argsRaw` 与错误 `message` 字段。

## 考虑过的替代方案

**提高投影字节上限。** 未采用，因为 ciphertext、Relay frame 与 endpoint 内存限制是协议安全控制，不是部署调节项。

**截断标题、路径或 Workspace 元数据。** 未采用，因为发现字段是权威产品数据，静默截断会让身份识别与导航产生歧义。

**先丢弃 Workspace 行，再减少 Session 行。** 未采用，因为 Workspace 归属属于浏览投影的一部分，并且必须对每个传输的 Session 保持准确。

## 后果

大型真实 Host surface 可以通过多个有界投影完成发现，不会产生通道反复断开、Session 跳过或 Session 重复。大型会话会保留最新的可操作内容，而不是引发反复重连；更早内容仍可通过历史分页访问。页面大小会随编码内容变化，因此消费者必须使用返回的连续状态，而不能假定固定行数。

## 测试

Desktop 产品测试会投影一个在达到行数上限时超过 48 KiB 的 surface，验证首页编码 envelope 保持在上限内，并验证下一页从实际传输数量继续且不存在缺口。Relay 测试会让超大 conversation 经过真实 Companion 编码器，验证加密输出保留最新节点、报告更早历史，并保持在 48 KiB 内。
