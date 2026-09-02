# Agent Note: 按运行时选择交付执行器

Status: implemented

[English](2026-08-27-runtime-specific-delivery-executors.md) | 中文

## 问题

交付工作流把 Codex worktree 任务写成首选 ticket 执行器，即使工作流运行在 DSH 中也是如此。DSH 不拥有 Codex 任务生命周期操作，而普通 subagent 不会继承部分产品塑形原型所需的规格对话。对两个运行时套用同一执行器规则，可能选择不可用的生命周期 API，或丢失有用的规划上下文。

## 决策

根协调器根据当前运行时选择执行器。Codex 在可用时使用隔离的 Codex worktree 任务。当 Codex 任务 API 不可用但仍能隔离 worktree 时，根任务会成为唯一的串行执行器，并且每次只在一个专用 worktree 中写入。DSH 在执行器受益于当前对话时使用 `subagent_fork`，在继承上下文没有帮助时使用普通 `subagent`。UI prototype 不在协调会话里绘制：Codex 获得带短 brief 的独立 worktree 任务；DSH 在 brief 写好后才派发 subagent。[融入现有页面的高保真 UI prototype 变体](2026-09-02-fused-ui-prototype-variants.zh.md) 负责 UI 稿规则。结构方案遵循[给人看的方案评审材料](2026-09-02-human-scheme-review-pack.zh.md)。模型选择仍由根协调器按 ticket 决定。

在正常路径上，每个执行器只接收一个 ticket、分支和隔离 worktree。失去 worktree 隔离能力是唯一例外：这会触发共享 checkout 兜底，此时根任务仍是唯一的串行执行器，并会报告隔离能力降低。产品塑形原型保存在独立的已推送分支中，作为规划输入；实现 ticket 会改造这些代码，而不是直接合并原型分支。清理流程通过实际运行的执行器验证终态；只有确实创建过 Codex 任务时才会归档，而且绝不移除共享 checkout。精确验证专用 worktree 和分支仍是所有运行时共用的清理行为。

## 曾考虑的替代方案

**始终使用 Codex 任务。** 这样只有一条指令路径，但会指定 DSH 无法执行的生命周期操作。

**始终使用普通 DSH subagent。** 这适合不依赖上下文的执行，但无法向需要规格对话的原型和执行器提供已接受的上下文。

**把原型分支合并到 ticket 分支。** 这样会保留原型提交，却会在 ticket 执行器依据生产约束完成改造前，就把探索代码写入实现历史。

## 后果

- 每个运行时使用自己拥有的执行器和生命周期操作。
- DSH 可以按需保留规格上下文，无需把上下文复制到所有任务中。
- 正常路径下，执行器隔离和持久分支证据在不同运行时中保持不变；共享 checkout 兜底会明确报告隔离能力丢失。
- 原型代码需要经过明确的改造步骤，其临时分支会保留到所有使用它的 ticket 都落地为止。
