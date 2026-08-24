# Agent Note：结构化 CI 证据与有界重试

状态：已实施

[English](2026-08-24-structured-ci-evidence.md) | 中文

## 问题

工作流结论无法说明选择了哪些证据、首个失败 gate、阶段耗时或失败类别。aggregate check、被取消的 superseded run 和耗时很长的观察性 job 还会污染延迟与成功率统计。重试整个失败工作流也会掩盖原始失败究竟是产品缺陷还是基础设施传输故障。

## 决策

CI Planner JSON 和每个已接入的 gate aggregate 都会作为带版本的 artifact 上传。gate 报告按声明顺序保留阶段结果，按实际完成顺序确定首个阻塞失败，并保留耗时、阻塞状态、进程事实、稳定的失败分类和相关 artifact 名称。分类目录区分产品回归、覆盖率、snapshot、生成物漂移、workflow policy、Runner 污染和瞬时基础设施故障。

自动重试由显式命令包装器负责，而不是重试整个工作流。只有第一次命令的完整诊断与严格的瞬时基础设施 allowlist 匹配时，才允许恰好一次第二次尝试。报告会保留两次尝试。allowlist 包含传输超时/重置，以及 node-gyp 获取 headers 时 pnpm 内置 Undici HTTP/1 解析器触发 `assert(!this.paused)` 的精确故障；Python runtime immutable install 与 manylinux 镜像拉取都通过该包装器发布尝试证据。断言、覆盖率失败、snapshot 漂移、生成物漂移、policy 失败、进程 signal 和未分类失败永不重试。

`ci:metrics` 根据完整的 workflow 和 job 时间戳计算可重复基线。它从 lane 样本中排除 aggregate 和观察性 job，并从 run 总体中排除未完成、cancelled、skipped 或 stale 的 run。它会在成功率以及排队、执行、首个结论的 p50/p95 耗时之外同时发布纳入和排除的 run id。

2026-08-24 基线查询了最近 20 次主 CI run。run 32667140424、32666575103、32665585148、32664797140、32664516987 和 32663145844 是有效样本：成功率为 33.3%；排队 p50/p95 为 3/24 秒；执行 p50/p95 为 13/718 秒；首个有效结论 p50/p95 为 16/43 秒。执行分布包含快速出现的有效失败，而不会把它们作为下游 skip 隐藏。较小的有效样本量作为此前取消和 supersession 噪声的证据被保留，不会用无效样本补齐。

## 备选方案

**失败后解析供人阅读的控制台摘要。** 拒绝，因为缓冲 gate 与流式 gate 走不同输出路径，而控制台文本既没有带版本的 schema，也无法定义可比较的总体。

**每个失败任务都重试一次。** 拒绝，因为这会隐藏确定性回归，并在不改变证据的情况下将昂贵工作翻倍。

**直接使用 workflow conclusion 和 wall time。** 拒绝，因为观察性失败可能在必需 verdict 成功后让 workflow 失败，而 aggregate job 会重复计算结论，superseded run 也没有可用的完整样本。

## 后果

CI 改动可以按相同指标比较，并直接检查精确的 gate 证据，无需重建日志。若失败发生在 gate runner 启动前，缺失报告仍会通过 artifact 上传警告显现。新增可重试诊断必须显式修改 allowlist 与测试。新增 aggregate 或观察性 job 名称必须先更新 metrics fixture，才允许改变统计总体。
