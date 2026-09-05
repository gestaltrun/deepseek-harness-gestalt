# 会话复盘标准

[English](session-retro.md) | 中文

本参考承载会话复盘的共享规则：一个 writer 会话复盘什么、允许读哪些来源、候选改进如何到达用户决策。[`retro`](../../.agents/skills/retro/SKILL.md) skill 是用户启动的入口；[交付工作流](../../.agents/skills/orchestrate-dsh-delivery/SKILL.md)链接本页，使协调者可以让每个 writer 会话运行自己的复盘，而不必通过自动调用要求那个 user-only skill。

## 范围

会话复盘只复盘一个会话：正在运行它的会话本身。每个 writer 对执行其 ticket 工作的会话自行复盘；协调者或其他会话不得代他人复盘。只读取当前会话自己的日志与 workspace 状态。不读取其他会话的日志、其他 writer 的私人 session 存储或其他用户的环境。

## 候选

从会话自身可观察历史收集改进候选：导航摩擦、本可由自动检查捕获的错误、失效的审查规则、无效果的常驻指令、昂贵的工具调用，以及决策时不可获得的信息。按严重程度排序。候选陈述观察到的证据与提议的环境变更，而不是模型信心或对任务内容的抱怨。

## 决策门

候选不会自行落地。writer 把候选列表报告给请求它的协调者，协调者综合所有候选并逐项呈给用户显式决定保留或放弃。只有被接受的项通过交付工作流的 merger 路径落地，并重跑受影响检查。交付在该决策之前不合并。

## 参考

- [`retro`](../../.agents/skills/retro/SKILL.md) — 用户启动的复盘 skill，按用户指定的会话运行本标准，缺省为当前会话。
- [单一 specification pull request 与 retro gate](../../.agents/notes/implemented/process/2026-09-02-spec-pr-delivery-and-retro.zh.md) — 把 retro gate 放在合并之前的交付决策。
