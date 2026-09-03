# Agent Note: 根会话只做编排

Status: implemented

[English](2026-09-03-root-session-orchestrates-only.md) | 中文

## 问题

项目尾声的用户反馈、CI 失败和少量后续修改，在实践中会落在票 writer 循环之外。协调会话随后自己读代码、写修复、跑测试。这会把分析和实现混在同一上下文，把根窗口花在代码上，并且没有可恢复的隔离 writer。

## 决策

[交付编排器](../../../skills/orchestrate-dsh-delivery/SKILL.md)把根会话留在分析、拆解、派发和验收。它澄清请求、拆分工作、选择执行器和模型、等待，并判断报告的证据。它不实现。

实现包括：为了改动而阅读大面积代码、编写或编辑产品或文档文件、跑本地测试或其他可执行证据，以及批量修改。根会话通过运行时的 Agent 工具（`subagent`、`subagent_fork` 或 Codex worktree 任务）把这类工作派给该票最合适的模型。任何阶段的用户反馈，包括规格看起来已经完成之后，都按同样方式分类并交给 writer。

根会话可以读 GitHub、跟踪器、worker 报告和 CI 状态；写 brief；创建空的规格分支和 Draft pull request；并在报告的证据通过后入队合并。它不在协调 checkout 里落地代码、文档或环境改动。[规格 PR 决策](2026-09-02-spec-pr-delivery-and-retro.zh.md)仍然拥有 pull request 数量、merger 子代理、scratch 笔记和 retro 闸门。[按运行时选择执行器](2026-08-27-runtime-specific-delivery-executors.zh.md)仍然选择 Codex 或 DSH worker；顺序派发是顺序的隔离 writer，而不是根会话自己写。

当没有任何 Agent 工具能跑 writer 时，根会话报告该隔离失败并停止。它不退回在协调会话里实现。

## 曾考虑的替代方案

**让根会话就地修复尾声反馈。** 一行后续在协调上下文里更快。它也会把分析窗口花在代码上，没有可恢复的隔离 worktree，并训练根会话把「很小」当作可以实现的许可。

**在 Codex 任务或 worktree 不可用时，让根会话充当顺序 writer。** 这能在降级执行器下继续推进。它正是本决策禁止的协调会话实现。缺少 writer 工具是要报告的阻塞。

**允许根会话把接受的 retro 改动落到规划 checkout。** 这些文件是环境转向，不是产品代码。它们仍是协调会话里的实现；由 writer 把它们落到规格分支。

## 后果

根上下文留在交付图上，包括最后一张票之后的反馈。每一次代码、测试和文档改动都有可恢复的 writer。派发为小后续付出 brief 和等待成本。缺少 Agent 工具会停止交付，而不是在根会话里静默实现。
