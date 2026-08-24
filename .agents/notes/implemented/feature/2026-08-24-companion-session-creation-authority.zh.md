# Agent Note: Companion Session 创建 authority

Status: implemented

[English](2026-08-24-companion-session-creation-authority.md) | 中文

## 问题

Mobile 可以通过加密 Companion channel 发送 Workspace 所有和 Ungrouped 的 `session.create` operation，但终态结果丢弃了 Host Session id。共享 Workspace presentation 会有意隐藏非 current 的空白 Session，因此权威 refresh 即使包含新建行，已交付的 Mobile 页面仍可能不显示按钮点击结果。仅断言 operation 或 Host call 的 fixture 无法证明产品交付。

## 决策

Companion mutation result `session-created` 携带真实 Host 返回的品牌化 Session id、operation id 与提交时间。Desktop 在持久 operation ledger 中保留这一原始结果，并在 status query 中重放。Mobile 将其作为创建确认，但不合成 Session 行。Mobile 记录由当前 physical connection 持有的待选择项，并且只在同一连接上的认证 resync 已包含该确认 id 时应用选择。replacement connection 会清除待选择项；未关联、失败、缺失与重复结果都不能引入可见性。重启后，已提交 receipt 的 reconciliation 会恢复同一待选择项。

assembled acceptance 会挂载生产 Mobile surface 与共享 `MobileBrowse`，点击两个已交付的创建按钮，通过 Snow 发送 operation，用真实 Session store 和 Workspace registry 执行真实 Desktop Host `session.create`，重新加载文件 operation ledger，并等待权威 refresh 将新的空白 Session 分别渲染到 Workspace 所有与 Ungrouped 分组。测试中只有外部 Account、Platform 与 Relay transport authority 使用确定性 adapter 表示。

## 考虑过的替代方案

**显示所有空白 Session。** 这会削弱共享 presentation 规则，并暴露无关的临时或已放弃 Session。

**根据按钮输入在 Mobile 乐观创建行。** Mobile 会成为第二个 Session authority，并可能显示 Desktop 已拒绝或从未提交的 Session。

**返回通用 confirmation，并根据下一次列表差异推断新 id。** 并发创建、分页与重连会使推断行产生歧义，旧连接也可能在 replacement generation 中选择 Session。

**只用协议或 Host mock 证明创建。** 这些检查没有把已交付按钮、共享分组、Snow transport、持久 ledger、真实 Host adapter 与权威 refresh 作为一个完整流程执行。

## 后果

Session 创建拥有独立的终态 wire result 和持久 receipt 表示。Mobile 将选择保留为 presentation state，而不是缓存的 Desktop authority；第一个包含准确 id 的同 generation 权威 projection 会消费该选择。assembled 测试由于挂载真实 persistence 与 Host stack，比 component fixture 更慢，但它能发现用户可见流程要求的每个生产 seam 上的断裂。
