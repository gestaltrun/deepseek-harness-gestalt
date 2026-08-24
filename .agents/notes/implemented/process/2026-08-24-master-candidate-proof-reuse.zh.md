# Agent Note：master 候选证明复用

状态：已实现

[English](2026-08-24-master-candidate-proof-reuse.md) | 中文

## 问题

Merge Queue 证明的是合成候选 commit，而落到 master 的 commit 即使产生完全相同的文件，也可能拥有不同的 commit 标识。精确证明之后重新运行完整矩阵会浪费最长的平台时钟，但只信任 commit、artifact 名称或不完整的环境摘要，又可能在 CI 语义变化后复用陈旧证据。

## 决策

候选 preflight 根据 Git tree 以及 `pnpm-lock.yaml`、CI workflow 与 Planner、Node/pnpm toolchain 声明和可执行 gate inventory 的独立摘要，计算带版本的证据身份。证据键对这些字段进行哈希。它有意不含 commit SHA：队列候选与已落地 master 之间需要的是 tree 内容等价。

所有穷尽依赖成功后，`candidate verdict` 用仓库、merge-group run id、事件和成功 verdict 完成该身份，然后发布按 tree 命名的 artifact。Master preflight 只查询同仓库且具有该 tree 的 artifact，确认源 run 是 `candidate verdict` 成功的 merge-group run，下载记录，并要求每个身份字段精确匹配。

精确匹配会选择有界的 `master reuse smoke`，它验证 checkout tree 并报告源证明。证明缺失、过期、不可用、格式错误、来自其他仓库、不完整或不匹配时，会选择所有穷尽 lane。`master evidence verdict` 在精确复用时只接受 smoke；否则要求完整 fallback，包括原生 Windows 和 macOS Electron。

## 考虑过的替代方案

**匹配 merge-group 与 master 的 commit SHA。** 拒绝，因为等价候选树与落地树可能拥有不同的 commit 元数据。

**只匹配 tree 与 lockfile。** 拒绝，因为 workflow、Planner、toolchain 或 gate 变化会改变同一源代码树所证明的内容。

**证明服务不可用时让 master 失败。** 拒绝，因为证明查询是一项优化；不确定性必须通过选择穷尽 fallback 来增加验证。

## 后果

每次 master CI run 都会发布结构化复用决策，列出源 run 或 fallback 原因。新增 workflow、Planner、toolchain 或 gate inventory 输入时，必须把它加入所属摘要列表及 contract test。精确候选证明可以消除重复的穷尽工作，同时不削弱冷启动或服务降级路径。
