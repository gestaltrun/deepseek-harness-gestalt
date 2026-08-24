# Agent Note：Merge Queue 候选证据

状态：已实现

[English](2026-08-24-merge-queue-candidate-evidence.md) | 中文

## 问题

Ready PR 只证明运行开始时其 head 与已观察 base 的组合。后续 base 更新可能改变最终集成树，却没有一个覆盖该精确候选树的完整结论。Draft 反馈也与合并准入共用同一工作流拓扑，尽管迭代与准入对延迟和置信度的要求不同。

## 决策

CI 工作流监听 `merge_group`，并 checkout GitHub 的合成候选合并 commit。Preflight 读取事件的 `base_sha` 与 `head_sha`；Planner 对该非 PR 事件始终选择穷尽证据，并把每个 lane 标为必需。由于 merge-group payload 不是 PR，因此跳过 PR 元数据策略。

每个穷尽 worker 都接受 Planner 选中的 merge-group lane。候选使用 hosted runner，不采用限定到 PR 作者的仓库 failover override。覆盖率、组装态 snapshot 与 artifact、受支持 Node 版本、两个 SDK 投影、发布形态 Python runtime、Wine、全部原生 Windows 分区及 macOS Electron 都必须成功。

`candidate verdict` 是唯一供分支保护使用的 merge-group 结论。它使用 `always()`，要求穷尽 plan，并拒绝任何失败、取消或意外跳过的必需依赖。Draft 与 Ready PR 继续使用 `all checks passed`；已知低风险 Draft 仍只选择影响面证据。

依赖 verdict 通过后，该 job 会 checkout 候选树、安装固定版本的 pnpm 与 Node 工具链，并完成不可变依赖安装，再通过仓库 CLI 完成 attestation。Worker job 的设置不会跨越 GitHub Actions job 边界，因此 verdict 自身的工具链准备属于证明路径，并由工作流契约测试固定。

## 考虑过的替代方案

**把 Ready PR head 当作合并证明。** 拒绝，因为它不能标识 base 出现更新或队列中其他 PR 落地后形成的精确树。

**在分支保护中直接要求每个矩阵 job。** 拒绝，因为 job 名称与矩阵会演进；一个稳定 verdict 负责完整依赖清单和故障关闭语义。

**每次 Draft synchronize 都运行候选证明。** 拒绝，因为影响面 Planner 已提供有界的迭代反馈，而准入需要针对候选树的独立事件。

## 后果

Merge Queue 只能准入完整平台与 artifact 清单获得单一成功 verdict 的树。新增或重命名穷尽 job 时必须更新候选依赖与 contract test。PR 反馈保持独立，因此 Draft 更新不会启动只属于合并证明的穷尽流程。
