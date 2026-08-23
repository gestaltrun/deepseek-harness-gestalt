# Agent Note：故障关闭的 GitHub Actions workflow 有效性

状态：已实现

[English](2026-08-24-fail-closed-workflow-validity.md) | 中文

## 问题

job 构造字段引用仅在 runner 分配后才存在的上下文时，GitHub 会在分配任何 job 前拒绝 workflow。生成的 push run 没有 job 和日志，因此普通仓库测试及后续 CI job 都无法诊断。YAML 解析与仓库拓扑断言不实现 GitHub Actions 表达式语义，而通用 workflow linter 也可能缺少按字段位置限制上下文的规则。

## 决策

pull-request workflow 从 `workflow validity` 开始；该 job 使用维护中的 actionlint 镜像检查所有 workflow，其他 pull-request 证据 job 只有在它成功后才可运行，required aggregate 也包含它。

`.github/actionlint.yaml` 声明仓库自有 runner 标签，并且只忽略有意禁用的 macOS reference job。其他 workflow 诊断必须在无忽略项的情况下通过 actionlint。

仓库 workflow 测试补充导致零 job 故障的 job 构造限制：job 级 `env` 值不得引用 `runner`。需要 `runner.temp` 的值属于 step 级 `env` 或 step 命令，因为这两处在 GitHub 分配 runner 后解析。测试会执行一个无效 fixture 并扫描所有 workflow，使同类回归在本地和 CI 中失败。

Desktop Release workflow 测试还要求 dispatch 默认版本与 `apps/desktop/package.json` 相同。GitHub 可以接受默认输入已过期的 workflow，但准备 job 会在打包前拒绝该 dispatch，因此版本一致性属于 workflow 有效性的一部分。

## 考虑过的替代方案

**只依赖 push 后的 GitHub 解析。** 拒绝，因为无效 workflow 会禁用自身检查，并产生没有可操作日志的零 job 故障。

**在仓库测试中重新实现全部 GitHub Actions 表达式规则。** 拒绝，因为 GitHub 会演进该语言，本地副本将发生漂移。actionlint 负责通用 workflow 语义；仓库测试只覆盖已确认会影响本仓库 workflow 清单的缺口。

**让 workflow validation 与昂贵 job 并行运行。** 拒绝，因为 validator 必须阻止无效输入占用 coverage、snapshot、平台和 artifact 容量。

## 结果

pull request 会先运行一个短 hosted job，再分配昂贵证据 job。workflow lint 失败会阻断 required verdict，并指出无效文件与位置。仓库特有的上下文限制保留为显式测试，而不是静默 actionlint 忽略项。Desktop Release 手动 dry run 仍是 GitHub 接受 dispatch 和 Desktop Bundle 打包路径的端到端证明；workflow validation 不会发布 release。
