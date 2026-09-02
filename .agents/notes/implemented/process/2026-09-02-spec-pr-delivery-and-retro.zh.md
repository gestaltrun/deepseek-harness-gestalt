# Agent Note: 一张规格 PR 与 retro 闸门

Status: implemented

[English](2026-09-02-spec-pr-delivery-and-retro.md) | 中文

## 问题

每票一张 pull request、由根会话负责合并、以及把探索笔记提交到规划分支，会让 GitHub 对象膨胀，并把协调上下文留在合并路径上。规格已经带有票图。评审者要的是实现该规格的一条分支。代码就绪之后，各 writer 会话里的环境浪费仍然不可见，除非每个 writer 做一次 retrospective，并由用户选择保留什么。

## 决策

[交付编排](../../../skills/orchestrate-dsh-delivery/SKILL.md)把一份规格落成一张 pull request。该 pull request 以 `master` 为基线，携带全部票的 closing keywords，并且是这次交付进入默认分支的唯一合并。

根任务仍然拥有权限、派发、监控、人工阻塞和发布停点。它不合并 worker 分支。merger 子代理把每张已完成票的分支快进或 merge-commit 进规格分支，并报告新 head。

每个就绪票仍然只有一个 writer、一条 `codex/<issue>-<slug>` 分支和一个隔离 worktree。Writer 遵循 [`implement`](../../../skills/implement/SKILL.md) 和[推送前检查](../../../skills/dsh-pre-push-checks/SKILL.md)。他们不开 pull request。

探索笔记留在版本控制之外的 scratch 目录，其绝对路径记在 gitignore 的[运行时备忘](2026-09-02-desktop-test-instance-and-runtime-memo.zh.md)中。后续 worker 必须读取的规划权威（规格、Agent Note、票）仍在派发前提交到规格分支。

规格分支收齐全部票、所需检查以及干净的规范与规格评审之后，根任务要求每个 writer 会话运行 [`retro`](../../../skills/retro/SKILL.md)。根任务归纳这些候选，交给用户决定，并只把接受的环境改动落到同一张规格 pull request 上。合入 `master` 等待该用户决定。

[先前的默认编排注记](2026-08-16-default-ticket-delivery-orchestration.zh.md)仍然拥有请求权限、隔离 writer、作为持久状态的 GitHub、GUI 证据、清理证明和发布停点。本注记拥有 pull request 数量、谁负责合并、探索笔记存放位置，以及 retro 闸门。

## 曾考虑的替代方案

**每票一张 pull request，外加一张基线到 master 的 pull request。** 这会按票隔离评审，并让 closing keywords 远离未完成工作。它也会为一份规格制造一叠 GitHub 对象，并把根会话留在合并路径上。

**让根会话合并 worker 分支。** 协调者已经在看每个 writer。在那里合并会把集成冲突混进必须继续派发和报告阻塞的同一上下文。

**把探索笔记提交到规格分支。** 后续 writer 可以从 git 读取，但分支会带上被放弃的搜索。运行时备忘里记录的共享 scratch 路径可读，又不会成为历史。

**只在合入 `master` 之后做 retrospective。** 那就失去了把环境修复与同一份已评审变更一起落地的机会。该闸门花费一次用户决定，并可能推迟合并。

**用 [`implement-spec`](../../../skills/implement-spec/SKILL.md) 整个替换协调器。** 其票图、并发实现者和单张 pull request 与本拓扑一致。它并不拥有 Gestalt 标签、Desktop 证据、残留依赖时的官方 stack、retro 闸门或发布停点。本仓库把这些留在交付技能里，并把 `implement-spec` 当作 worker 与 merger 的模式，而不是根工作流。

## 后果

评审者看到一张规格 pull request，而不是票栈。集成冲突落在 merger 子代理里，而不是协调会话。探索搜索不进入 `master`。retro 中选中的环境改进与产品变更同一次合并。

merger 失败或被拒绝的 retro 候选会推迟进入 `master` 的唯一路径。closing keywords 只在该 pull request 落地时触发，因此 worker 仍在合并时 GitHub Issue 保持开启。scratch 探索笔记会随机器消失，除非用户要求保留。
