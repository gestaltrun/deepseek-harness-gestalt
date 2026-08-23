# Agent Note: 默认 ticket 交付编排

Status: implemented

[English](2026-08-16-default-ticket-delivery-orchestration.md) | 中文

## Problem

一句简短的 ticket 实现请求本身并未说明 coding agent 是否可以创建 worktree、委派任务、提交、推送、创建 PR 或执行合并。每次在提示词中重复这些权限和协调拓扑会增加人工操作，并且不同会话仍可能选择不一致的停止点。

subagent 文本记录也不适合作为持久协调记录。Worker 可以重启，其任务可能丢失上下文，不同宿主或会话对同级通信的支持也可能不同。GitHub 已经保存 ticket 依赖图、评审状态、检查和合并结果。

未提交的规划文件会在派发前造成同类失败：实现任务无法读取只存在于另一个 checkout 中的决策。让每个 ticket 直接进入 `master` 还会使未完成需求影响无关交付，并把跨 ticket 集成推迟到各部分已经进入默认分支之后。

## Decision

当用户要求实现、修复、继续或落地 issue 或规格时，仓库默认采用[交付编排器](../../../skills/orchestrate-dsh-delivery/SKILL.md)。该请求授权根任务创建隔离的 ticket worktree 和分支、派发 Worker、编辑、提交、推送、创建或更新 PR、响应评审，并在所需证据通过后合并。当前请求中的明确限制覆盖此默认授权。

第一次写入 workspace 前，根任务从 `origin/master` 的精确提交创建并推送一个 `codex/feature-<slug>` 基线。经过确认的 prototype 结论、规格、Agent Note、Context 文档和 ticket 必须在派发前提交到该基线，且规划 checkout 必须干净。每个 ticket 分支从已记录的远端基线提交开始，并以该基线为 PR 目标。只有根任务定期把 `origin/master` merge-forward 到基线；Worker 随后 merge-forward 更新后的基线，避免分别重复处理同一批 master 变化。

根任务是唯一协调者和合并者。GitHub Issue、PR、检查、官方 stack 和远端基线提交是持久状态。每个就绪 ticket 只有一个可写负责人和一个 worktree；相互独立的 ticket 可以并行。读密集型探索和评审可以使用 subagent，而后续指令和跨 ticket 发现通过根任务传递，并记录到 GitHub 或所属仓库文档中。根任务监控所有独立任务，并在协调任务中呈现结构化人工阻塞，因此该流程既不依赖同级 agent 通信，也不要求用户自行发现阻塞任务。

项目 Codex 角色编码两个常用职责：`ticket_worker` 负责一个 ticket 直至形成经过验证的 PR，但不执行合并；`dsh_reviewer` 以只读方式执行规范与规格双轴评审。无法创建任务或 worktree 时，根任务通过顺序执行 ticket Worker 保持相同的所有权模型。

[推送前工作流](../../../skills/dsh-pre-push-checks/SKILL.md)选择对外提交所需证据，[原生 stack 决策](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)负责依赖 PR 的落地。Ticket PR 合入基线并引用对应 Issue，但不关闭它们。Feature 级组装验证通过后，一个经过评审的基线 PR 才进入 `master` 并关闭 tickets。只有在根任务证明终态 ticket 任务干净、已推送、已合并且可由 GitHub 重建后，才归档任务并删除对应 worktree 和分支。创建 tag、GitHub Release、发布、签名、公证和部署始终需要针对该次发布的明确授权。

## Alternatives considered

**每次请求都要求完整交付提示词。** 这会让权限在每次对话中保持可见，但也要求用户重复稳定的仓库策略，并造成不必要的会话差异。

**所有实现共用一个长期任务。** 这避免创建任务，却会混合无关的可变状态、让上下文无限增长，并削弱 ticket 级恢复能力。

**让 Worker 直接协调。** 同级消息可以减少根任务转发，但会让临时 agent 拓扑成为工作流的一部分，并重复 GitHub 中持久的 ticket 和 PR 状态。

**让每个 ticket 直接合入 `master`。** 这会缩短单个 ticket 的路径，却会把部分完成的需求暴露给无关工作，让规划状态脱离实现基线，并取消最终的 feature 级集成决策。

**让每个 Worker 合并最新 `master`。** 这能让长期任务保持更新，却会让同级分支重复解决冲突。由根任务统一同步一次基线，可以只处理一次上游变化，并向所有 Worker 提供相同集成点。

**每个 ticket 都在推送或合并前停止。** 这会最大化逐步确认，却保留了此仓库默认模式旨在消除的人工交接。发布操作会影响已评审 PR 之外的分布式用户和注册表，因此仍保留人工边界。

## Consequences

用户只需提供 ticket 编号或规格引用即可请求实现，并期待工作自动推进到经过验证的合并，无需重复常规 Git 和 GitHub 权限。根任务可以根据 GitHub 状态替换或恢复 Worker，相互独立的 ticket 也可以并行推进，而不共享可写 checkout。实现任务会收到已经提交的规划权威内容，无关需求在各自最终基线 PR 进入 `master` 前彼此隔离。

基线会为每个交付范围增加一个集成分支和一个最终 PR。Ticket 会保持开启直到最终合并，上游变化只通过根任务拥有的明确同步点进入，清理则等待不存在唯一工作丢失风险的证据。自动合并仍会提高 ticket 范围、仓库检查和实时评审状态检查的准确性要求。用户的明确限制始终有效；无法提供隔离时，执行方式降级为顺序 Worker；发布工作始终在授权前暂停。
