# Agent Note：故障关闭的 CI 规划与 preflight

状态：已实现

[English](2026-08-24-fail-closed-ci-planning.md) | 中文

## 问题

pull-request workflow 的路由直接编码在 job 条件中，而 tracker 策略、生成状态检查与本地变更检查使用彼此独立的输入。缺失 base、未知路径、过期目录或格式错误的 PR 因而可能让本地与 hosted 决策不一致，或在被拒绝前消耗昂贵 runner 容量。

## 决策

`planCi(input)` 根据事件、PR readiness、解析后的 base 与 head、变更路径、模块图摘要、版本化风险目录、锁文件摘要、workflow 摘要和工具链摘要生成版本化且确定的 plan。输出包含受影响 area、升级原因、required 与 observational lane，以及由规范化输入导出的 evidence key。未知或不可用输入会选择穷尽证据并记录原因。

pull-request workflow 通过单一 `preflight` verdict 准入所有证据 job。plan worker 校验 workflow 语义、计算 plan，并要求 PR 元数据包含全部受影响 area。四个生成状态 worker 在相互独立的 immutable install 上分区执行生成目录、翻译配对、文档图、模块图和 workspace constraints。只有 plan worker 与每个生成状态分区都成功，verdict 才会通过，并且只把 plan worker 的路由与证明输出转发给证据 job。

`pnpm ci:plan` 是同一 planner 的本地投影。`pnpm pr:create` 是受支持的发布路径：它验证同仓库 Issue，并创建包含一个声明 kind 以及声明 area 与 planner 所选 area 并集的 Draft PR。

## 考虑过的替代方案

**在 workflow job 中保留独立路径筛选。** 拒绝，因为重复的路由规则会漂移，也无法解释统一的仓库级决策。

**把不可用输入当作空 diff。** 拒绝，因为浅 checkout、已删除 ref 或新路径会因此静默减弱证据。

**只在 PR ready 后校验元数据。** 拒绝，因为 Draft 迭代是修复缺失 Issue、kind 和 area 元数据成本最低的时点。

## 结果

每个 pull request 都会在昂贵工作开始前获得一个可检查的 plan。planner 或仓库存在不确定性时，证据会增加而不会减少。新增变更面必须扩展风险目录及对应 plan fixture；新增生成投影必须把检查加入恰好一个 preflight 分区。完整的本地 `check:ci:preflight` 聚合仍是这些分区的并集。[Draft 影响面决策](2026-08-24-draft-impacted-evidence.zh.md)负责更窄的 plan level，而不改变本次确定的故障关闭输入与 evidence-key contract。
